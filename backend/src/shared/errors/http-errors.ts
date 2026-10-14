export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: { field: string; message: string }[];
  };
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function envelope(
  requestId: string,
  code: string,
  message: string,
  details?: { field: string; message: string }[],
): ErrorEnvelope {
  return {
    error: { code, message, requestId, ...(details ? { details } : {}) },
  };
}

/**
 * The ONE 404 used for "does not exist" and for "exists but you may not discover it" (06 §2 step 8).
 * Same status, code and message everywhere, so the two cases are indistinguishable to a client.
 */
export const RESOURCE_NOT_FOUND_MESSAGE = 'The requested resource was not found.';
export function resourceNotFound(): AppError {
  return new AppError(404, 'RESOURCE_NOT_FOUND', RESOURCE_NOT_FOUND_MESSAGE);
}

/**
 * PostgreSQL waits the runtime role is configured to abandon (bootstrap.ts: lock_timeout 10s, statement_timeout 30s):
 *  55P03 lock_not_available (lock timeout), 57014 query_canceled (statement timeout).
 * Both abort the statement and therefore the whole transaction, which the caller rolls back, so a retry is safe.
 * 40P01 (deadlock detected) is deliberately NOT here: it means two code paths broke the documented lock order, so it
 * stays a logged 500 until that is investigated.
 */
export function isDatabaseTimeout(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === '55P03' || code === '57014';
}

/** The one safe answer for a database timeout: fixed text, no SQL, constraint or relation detail. */
export function databaseBusy(): AppError {
  return new AppError(503, 'DATABASE_BUSY', 'The service is busy. Retry the request.');
}
