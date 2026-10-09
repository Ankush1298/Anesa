import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from './auth.service.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { csrfTokenFor } from './csrf.js';
import type { LoginRateLimiter } from './login-limiter.js';
import { SESSION_COOKIE, SESSION_COOKIE_ATTRS, SESSION_MAX_AGE_SECONDS } from './session-cookie.js';

interface LoginBody {
  email: string;
  password?: string;
  tenant?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  opts: { authService?: AuthService; loginLimiter?: LoginRateLimiter } = {},
): void {
  // If not provided, construct defaults. This assumes `app.db` doesn't exist, we usually pass `db` to modules or get it from some global context, but we can just use `app.db` if we decorate it, or we construct the service inside `buildApp`.
  // Actually, standard practice in this repo seems to be passing dependencies via options.
  const authService = opts.authService;

  app.post(
    '/auth/login',
    {
      config: { public: true },
      schema: {
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          password: Type.String(),
          tenant: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const { email, password, tenant } = request.body as LoginBody;

      // Per-IP / per-(IP, account) budget, checked BEFORE any password work and independent of
      // whether the account exists. request.ip honours X-Forwarded-For only when TRUST_PROXY is set.
      const limiter = opts.loginLimiter;
      const wait = limiter?.check(request.ip, email) ?? 0;
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.');
      }

      let result;
      try {
        result = await authService.login(email, password ?? '', tenant);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 401)
          limiter?.recordFailure(request.ip, email);
        throw err;
      }
      limiter?.recordSuccess(request.ip, email);

      reply.cookie(SESSION_COOKIE, result.sessionToken, {
        ...SESSION_COOKIE_ATTRS,
        maxAge: SESSION_MAX_AGE_SECONDS,
      });

      return reply.send({
        success: true,
        tenant_id: result.tenantId,
        csrf_token: csrfTokenFor(result.sessionToken),
      });
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { public: true }, // We can still call this without a 401 if they are already logged out
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const token = request.cookies[SESSION_COOKIE];
      if (token) {
        await authService.logout(token);
      }
      reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_ATTRS);
      return reply.send({ success: true });
    },
  );

  app.get(
    '/auth/me',
    {
      // The caller's own session only: the identity is the authenticated one, there is no target id.
      config: { permission: 'session.read' },
    },
    async (request, reply) => {
      // This route requires authentication. Fastify hooks will run and attach the context to request.tenantContext.
      // See auth.hook.ts for how we attach this.
      const ctx = request.tenantContext;
      if (!ctx) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }

      // display_name / roles / capabilities: for rendering menus only; every action is re-checked
      // server-side. Spread so no route code ever inspects role names.
      if (!authService) throw new Error('authService not provided');
      const profile = await authService.describe(ctx);
      return reply.send({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        actor_kind: ctx.actorKind,
        ...profile,
        csrf_token: csrfTokenFor(request.cookies[SESSION_COOKIE] ?? ''),
      });
    },
  );
}
