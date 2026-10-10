import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerHardening } from './shared/http/hardening.js';
import { loggerOptions, type AppLoggerOptions } from './shared/logging/logger-options.js';
import fastifyCookie from '@fastify/cookie';
import authHook from './modules/auth/auth.hook.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { LoginRateLimiter } from './modules/auth/login-limiter.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthRepository } from './modules/auth/auth.repository.js';
import { registerOrganizationRoutes } from './modules/organization/organization.routes.js';
import type { Database } from './shared/database/index.js';
import { PERMISSION_CODES } from './shared/authorization/catalog.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as intentionally unauthenticated. Every other route will require a permission (Slice 3). */
    public?: boolean;
    permission?: string | readonly string[];
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Database;
  /** Tests may pass `false` to silence logs or a custom pino-compatible stream via logger options. */
  logger?: AppLoggerOptions | false;
  /** Tests inject a limiter with a fake clock; production uses the default. */
  loginLimiter?: LoginRateLimiter;
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
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // Route coverage (06 §2 step 5, 10 §4.1): every route is either on the explicit public allowlist
  // or names catalogued permission(s) from the central catalog. Violations fail at boot, not at runtime.
  app.addHook('onRoute', (route) => {
    const cfg = route.config as
      { public?: boolean; permission?: string | readonly string[] } | undefined;
    if (cfg?.public === true) return;
    if (!cfg?.permission) {
      throw new Error(`Route ${route.method.toString()} ${route.url} has no catalogued permission`);
    }
    const permVal = cfg.permission;
    const perms: readonly string[] = typeof permVal === 'string' ? [permVal] : permVal;
    if (perms.length === 0) {
      throw new Error(`Route ${route.method.toString()} ${route.url} has no catalogued permission`);
    }
    for (const p of perms) {
      if (!PERMISSION_CODES.has(p)) {
        throw new Error(
          `Route ${route.method.toString()} ${route.url} has no catalogued permission: ${p}`,
        );
      }
    }
  });

  registerHardening(app, { production: config.env === 'production' });

  // No `secret`: the session cookie is an opaque random token looked up by its SHA-256 hash, so
  // cookie signing would add nothing. (A placeholder secret would only pretend to.)
  app.register(fastifyCookie);

  const authRepository = new AuthRepository();
  const authService = new AuthService(deps.db, authRepository);

  // Register auth hook to protect routes
  app.register(authHook, { authService, db: deps.db, allowedOrigins: config.allowedOrigins });

  registerHealthRoutes(app, { db: deps.db });
  registerAuthRoutes(app, {
    authService,
    loginLimiter: deps.loginLimiter ?? new LoginRateLimiter(),
  });
  app.register(registerOrganizationRoutes, { prefix: '/api/v1/organization', db: deps.db });

  return app;
}
