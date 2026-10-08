import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthService } from './auth.service.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AppError } from '../../shared/errors/http-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TrustedContext;
  }
}

export interface AuthPluginOptions {
  authService: AuthService;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  // We need to keep async to satisfy FastifyPluginAsync signature or just use FastifyPluginCallback.
  // Actually, I can just add `await Promise.resolve()` to satisfy eslint.
  await Promise.resolve();
  app.decorateRequest('tenantContext', undefined);

  app.addHook('onRequest', (request, _reply, done) => {
    // Skip public routes and 404s
    if (request.routeOptions?.config?.public || request.is404) {
      return done();
    }

    const run = async () => {
      const token = request.cookies.session_token;
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
    };

    run()
      .then(() => done())
      .catch((err) => done(err));
  });
};

export default fp(authPlugin, {
  name: 'smart-campus-auth-hook',
  dependencies: ['@fastify/cookie'],
});
