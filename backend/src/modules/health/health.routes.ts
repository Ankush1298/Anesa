import type { FastifyInstance } from 'fastify';
import { checkDatabase, type Queryable } from '../../shared/database/pool.js';

/**
 * PUBLIC routes (explicit allowlist, 06 §2 step 5): liveness and readiness only.
 * Responses carry no version, host, or dependency detail.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: { db: Queryable }): void {
  app.get('/health', { config: { public: true } }, () => ({ status: 'ok' as const }));

  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    const status = await checkDatabase(deps.db);
    if (!status.ok) {
      return reply.status(503).send({ status: 'not_ready' as const });
    }
    return { status: 'ready' as const };
  });
}
