import type { FastifyLoggerOptions, FastifyRequest } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

export type AppLoggerOptions = FastifyLoggerOptions & PinoLoggerOptions;

/** Property paths whose values must never reach a log line. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.otp',
  '*.totpCode',
  '*.recoveryCode',
  '*.connectionString',
  '*.databaseUrl',
  'password',
  'token',
  'secret',
];

/**
 * Request logging records method, path (never the query string — it can carry tokens),
 * request id and remote address. Headers and bodies are never logged.
 */
export function loggerOptions(level: string): AppLoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      req(req: FastifyRequest) {
        // Defensive: a malformed `req` log field must still never expose headers or the query string.
        const url: unknown = req.url;
        const path = typeof url === 'string' ? (url.split('?')[0] ?? '') : '';
        return { method: req.method, path, remoteAddress: req.ip };
      },
      res(res: { statusCode: number | string }) {
        return { statusCode: res.statusCode };
      },
    },
  };
}
