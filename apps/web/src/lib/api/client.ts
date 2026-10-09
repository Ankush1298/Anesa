import type { z } from 'zod';
import { ApiError, kindForStatus } from './errors';
import { ErrorEnvelopeSchema } from './schemas';

export const CSRF_HEADER = 'x-csrf-token';
const REQUEST_TIMEOUT_MS = 15_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestOptions<S extends z.ZodType> {
  schema: S;
  body?: unknown;
  signal?: AbortSignal;
  /** Public endpoints (login) must not trigger the "session expired" handler on 401. */
  public?: boolean;
}

export interface ApiClientOptions {
  basePath: string;
  fetchImpl?: typeof fetch;
}

/**
 * The single place that talks to the backend.
 *  - same-origin only (relative URL, credentials: 'same-origin'); the HttpOnly session cookie is sent
 *    by the browser and is never readable here, stored, or copied into a header;
 *  - the CSRF token lives in this closure (memory only: not in storage, cookies, URLs or the DOM) and is
 *    attached to every unsafe request; one transparent refresh+retry if the server rejects it;
 *  - responses are validated against zod schemas; server text is never surfaced; nothing is logged.
 */
export class ApiClient {
  private csrfToken: string | null = null;
  private onUnauthorized: (() => void) | null = null;
  private refreshCsrf: (() => Promise<void>) | null = null;
  private readonly basePath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.basePath = options.basePath;
    // Bound so `this` is never the client when the browser's fetch is invoked.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  setCsrfToken(value: string): void {
    this.csrfToken = value;
  }
  clearCsrfToken(): void {
    this.csrfToken = null;
  }
  hasCsrfToken(): boolean {
    return this.csrfToken !== null;
  }
  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.onUnauthorized = handler;
  }
  /** Registered by the auth layer: re-reads the token from GET /auth/me. */
  setCsrfRefresher(refresher: (() => Promise<void>) | null): void {
    this.refreshCsrf = refresher;
  }

  get<S extends z.ZodType>(path: string, o: RequestOptions<S>): Promise<z.infer<S>> {
    return this.request('GET', path, o);
  }
  post<S extends z.ZodType>(path: string, o: RequestOptions<S>): Promise<z.infer<S>> {
    return this.request('POST', path, o);
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    o: RequestOptions<S>,
    retried = false,
  ): Promise<z.infer<S>> {
    const unsafe = !SAFE_METHODS.has(method);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (unsafe && this.csrfToken !== null) headers[CSRF_HEADER] = this.csrfToken;

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.basePath}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal,
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      });
    } catch (err) {
      if (o.signal?.aborted) throw err; // caller cancelled: not a failure to report
      throw new ApiError('network', 0);
    }

    if (response.ok) {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ApiError('protocol', response.status);
      }
      const parsed = o.schema.safeParse(json);
      if (!parsed.success) throw new ApiError('protocol', response.status);
      return parsed.data;
    }

    const error = await this.toApiError(response);

    if (error.kind === 'csrf' && unsafe && !retried && this.refreshCsrf) {
      try {
        await this.refreshCsrf();
      } catch {
        throw error;
      }
      return this.request(method, path, o, true);
    }
    if (error.kind === 'unauthenticated' && !o.public) this.onUnauthorized?.();
    throw error;
  }

  private async toApiError(response: Response): Promise<ApiError> {
    let code: string | undefined;
    let requestId: string | undefined;
    try {
      const env = ErrorEnvelopeSchema.safeParse(await response.json());
      if (env.success) {
        code = env.data.error.code;
        requestId = env.data.error.requestId;
      }
    } catch {
      /* body is not the documented envelope: ignore, keep only the status */
    }
    const retry = Number(response.headers.get('retry-after'));
    return new ApiError(kindForStatus(response.status, code), response.status, {
      ...(code !== undefined ? { code } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {}),
    });
  }
}
