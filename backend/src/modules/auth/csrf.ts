import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors/http-errors.js';

/**
 * CSRF defence for the cookie-session architecture (three independent checks, see
 * docs/architecture/v3/15-csrf-and-login-abuse.md):
 *  1. Origin / Sec-Fetch-Site validation on every state-changing request (public ones included).
 *  2. A per-session CSRF token, required in the `X-CSRF-Token` header on every authenticated
 *     state-changing request. It is DERIVED from the opaque session token with a domain-separated
 *     SHA-256, so it needs no extra secret or storage, dies with the session on logout/expiry, and
 *     cannot be computed without the HttpOnly session cookie. The browser receives it in the login
 *     and /auth/me responses and keeps it in memory (never in a cookie).
 *  3. SameSite=Lax on the session cookie (defence in depth only, never the sole control).
 * A custom header also forces a CORS preflight for cross-site callers, and no CORS is enabled.
 */
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`campusos.csrf.v1:${sessionToken}`).digest('base64url');
}

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function reject(): AppError {
  return new AppError(403, 'CSRF_REJECTED', 'The request was rejected.');
}

/**
 * Browsers always send Origin on cross-origin unsafe requests. Present ⇒ must be allow-listed (or,
 * with no allow-list configured in development, equal to the request's own host). `null` and
 * unparsable origins are rejected. Absent Origin is left to the token check (non-browser clients).
 */
export function assertOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    const allowed =
      allowedOrigins.length > 0
        ? allowedOrigins.includes(origin)
        : origin === `${request.protocol}://${request.headers.host ?? ''}`;
    if (!allowed) throw reject();
    return;
  }
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw reject();
}

export function assertCsrfToken(request: FastifyRequest, sessionToken: string): void {
  const sent = request.headers[CSRF_HEADER];
  if (typeof sent !== 'string' || sent.length === 0) throw reject();
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const got = Buffer.from(sent);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw reject();
}
