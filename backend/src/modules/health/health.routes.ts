import type { FastifyInstance } from 'fastify';
import type { DatabaseStatus } from '../../shared/database/index.js';

export interface HealthSource {
  health(): Promise<DatabaseStatus>;
}

/**
 * PUBLIC routes (explicit allowlist, 06 §2 step 5): liveness and readiness only.
 * Responses carry no version, host, or dependency detail.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: { db: HealthSource }): void {
  app.get('/health', { config: { public: true } }, () => ({ status: 'ok' as const }));

  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    const status = await deps.db.health();
    if (!status.ok) {
      return reply.status(503).send({ status: 'not_ready' as const });
    }
    return { status: 'ready' as const };
  });
}
