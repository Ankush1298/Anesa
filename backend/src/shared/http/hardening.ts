import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  AppError,
  RESOURCE_NOT_FOUND_MESSAGE,
  databaseBusy,
  envelope,
  isDatabaseTimeout,
} from '../errors/http-errors.js';

/**
 * Baseline HTTP hardening shared by every route:
 *  - security headers and `Cache-Control: no-store` on every API response (05 §7)
 *  - uniform error envelope; unexpected errors never leak internals
 */
export function registerHardening(app: FastifyInstance, opts: { production: boolean }): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    if (opts.production) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(envelope(req.id, 'RESOURCE_NOT_FOUND', RESOURCE_NOT_FOUND_MESSAGE));
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.statusCode).send(envelope(req.id, err.code, err.message));
      return;
    }
    if (err instanceof ZodError) {
      void reply.status(400).send(
        envelope(
          req.id,
          'VALIDATION_ERROR',
          'Request validation failed.',
          err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        ),
      );
      return;
    }
    if (isDatabaseTimeout(err)) {
      // A lock or statement timeout outside the idempotency helper (close, the structure guards, any other route): the
      // transaction already rolled back, so the client may retry. Fixed text; the driver's message stays in the log.
      req.log.warn({ err }, 'database timeout');
      const busy = databaseBusy();
      void reply.status(busy.statusCode).send(envelope(req.id, busy.code, busy.message));
      return;
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Framework-level client errors (malformed JSON, payload too large, ...). Generic text only.
      void reply.status(status).send(envelope(req.id, 'BAD_REQUEST', 'The request was invalid.'));
      return;
    }
    req.log.error({ err }, 'unhandled error');
    // Log internally but do not leak details
    void reply
      .status(500)
      .send(envelope(req.id, 'INTERNAL_ERROR', 'An unexpected error occurred.'));
  });
}
