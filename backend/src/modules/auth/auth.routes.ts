import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from './auth.service.js';

interface LoginBody {
  email: string;
  password?: string;
  tenant?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  opts: { authService?: AuthService } = {},
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

      const result = await authService.login(email, password ?? '', tenant);

      // Set cookie securely
      reply.cookie('session_token', result.sessionToken, {
        path: '/',
        httpOnly: true,
        secure: true, // Assume TLS everywhere
        sameSite: 'lax',
        maxAge: 12 * 60 * 60, // 12 hours
      });

      return reply.send({ success: true, tenant_id: result.tenantId });
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { public: true }, // We can still call this without a 401 if they are already logged out
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const token = request.cookies.session_token;
      if (token) {
        await authService.logout(token);
      }
      reply.clearCookie('session_token', { path: '/' });
      return reply.send({ success: true });
    },
  );

  app.get(
    '/auth/me',
    {
      config: {
        permission: 'session.read',
        extractScope: (req) => ({ user_id: req.tenantContext!.userId }),
      },
    },
    async (request, reply) => {
      // This route requires authentication. Fastify hooks will run and attach the context to request.tenantContext.
      // See auth.hook.ts for how we attach this.
      const ctx = request.tenantContext;
      if (!ctx) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }

      return reply.send({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        actor_kind: ctx.actorKind,
      });
    },
  );
}
