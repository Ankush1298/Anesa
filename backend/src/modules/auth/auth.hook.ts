import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthService } from './auth.service.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { AuthorizationEngine, type ResourceScope } from '../../shared/authorization/engine.js';
import type { Database } from '../../shared/database/index.js';
import { assertCsrfToken, assertOrigin, isUnsafeMethod } from './csrf.js';
import { SESSION_COOKIE } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TrustedContext;
  }
  interface FastifyContextConfig {
    permission?: string;
    extractScope?: (req: FastifyRequest) => ResourceScope | undefined;
  }
}

export interface AuthPluginOptions {
  authService: AuthService;
  db: Database;
  /** Exact browser origins allowed for state-changing requests (empty = same host only). */
  allowedOrigins: readonly string[];
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  await Promise.resolve();
  app.decorateRequest('tenantContext', undefined);

  // 0. CSRF origin check: every state-changing request, public routes (login/logout) included.
  app.addHook('onRequest', (request, _reply, done) => {
    try {
      if (!request.is404 && isUnsafeMethod(request.method)) {
        assertOrigin(request, opts.allowedOrigins);
      }
      done();
    } catch (err) {
      done(err as Error);
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    // 1. Identity & Auth Check
    if (request.routeOptions?.config?.public || request.is404) {
      return done();
    }

    const runAuth = async () => {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing authentication token');
      }

      try {
        const ctx = await opts.authService.validateSession(token);
        request.tenantContext = ctx;
      } catch (err: unknown) {
        if (err instanceof AppError && err.statusCode === 401) {
          throw err;
        }
        throw new AppError(500, 'INTERNAL_ERROR', 'Authentication failed unexpectedly');
      }

      // 1b. CSRF token: required for every authenticated state-changing request.
      if (isUnsafeMethod(request.method)) assertCsrfToken(request, token);
    };

    runAuth()
      .then(() => done())
      .catch((err) => done(err));
  });

  app.addHook('preHandler', async (request, _reply) => {
    // 2. Authorization Check (Slice 3)
    if (request.routeOptions?.config?.public || request.is404) {
      return;
    }

    const ctx = request.tenantContext;
    if (!ctx) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const config = request.routeOptions?.config;
    if (!config || !config.permission) {
      throw new AppError(
        500,
        'INTERNAL_ERROR',
        'Route is missing required permission configuration',
      );
    }

    const scope = config.extractScope ? config.extractScope(request) : undefined;

    // We execute the check using the configured permission and scope extractor
    await opts.db.withTenant(ctx, async (tx) => {
      await AuthorizationEngine.assert(tx, ctx, config.permission as string, scope);
    });
  });
};

export default fp(authPlugin, {
  name: 'smart-campus-auth-hook',
  dependencies: ['@fastify/cookie'],
});
