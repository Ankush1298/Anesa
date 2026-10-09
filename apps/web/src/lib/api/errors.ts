/**
 * Failures of an API call, reduced to what the UI may act on. The server's message text and body are
 * deliberately NOT kept: the UI shows its own fixed wording, so nothing the server (or an attacker
 * who controls a response) sends is ever rendered, logged or leaked.
 */
export type ApiErrorKind =
  | 'unauthenticated' // 401
  | 'forbidden' // 403 (authorization)
  | 'csrf' // 403 CSRF_REJECTED (origin / token)
  | 'not_found' // 404
  | 'rate_limited' // 429
  | 'validation' // 400 / 413 / 422
  | 'server' // 5xx
  | 'network' // fetch failed / timed out / offline
  | 'protocol'; // 2xx but not the documented shape

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    kind: ApiErrorKind,
    status: number,
    extra: { code?: string; retryAfterSeconds?: number; requestId?: string } = {},
  ) {
    super(`API ${kind} (${status})`);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = extra.code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.requestId = extra.requestId;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function kindForStatus(status: number, code: string | undefined): ApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return code === 'CSRF_REJECTED' ? 'csrf' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
}
