import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerHardening } from './shared/http/hardening.js';
import { loggerOptions, type AppLoggerOptions } from './shared/logging/logger-options.js';
import fastifyCookie from '@fastify/cookie';
import authHook from './modules/auth/auth.hook.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthRepository } from './modules/auth/auth.repository.js';
import type { Database } from './shared/database/index.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as intentionally unauthenticated. Every other route will require a permission (Slice 3). */
    public?: boolean;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Database;
  /** Tests may pass `false` to silence logs or a custom pino-compatible stream via logger options. */
  logger?: AppLoggerOptions | false;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config.logLevel),
    // Never trust a client-supplied request id.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  registerHardening(app, { production: config.env === 'production' });

  // Register fastify-cookie
  app.register(fastifyCookie, {
    secret: 'change_me_session_secret',
  });

  const authRepository = new AuthRepository();
  const authService = new AuthService(deps.db, authRepository);

  // Register auth hook to protect routes
  app.register(authHook, { authService, db: deps.db });

  registerHealthRoutes(app, { db: deps.db });
  registerAuthRoutes(app, { authService });

  return app;
}
