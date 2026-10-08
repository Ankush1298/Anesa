import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import type { Queryable } from './shared/database/pool.js';
import { registerHardening } from './shared/http/hardening.js';
import { loggerOptions, type AppLoggerOptions } from './shared/logging/logger-options.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as intentionally unauthenticated. Every other route will require a permission (Slice 3). */
    public?: boolean;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Queryable;
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
  registerHealthRoutes(app, { db: deps.db });

  return app;
}
