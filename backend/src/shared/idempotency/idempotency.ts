import { createHash } from 'node:crypto';
import type { TenantTx } from '../database/tenant-tx.js';
import { AppError, databaseBusy } from '../errors/http-errors.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';

/**
 * Shared idempotency mechanism (docs/architecture/v3/22-idempotency.md, table app.idempotency_keys, migration 0018).
 *
 * A request carries an `Idempotency-Key`. The first request with a key CLAIMS it inside the same transaction as its
 * business write and stores its successful response; a retry with the same key and the same canonical request gets that
 * response back without a second write; the same key with a different request is refused (422). A request that fails
 * rolls back the transaction and the claim with it, so failures are never cached.
 */

/** 16-128 URL-safe characters: enough entropy to be unguessable, no whitespace, nothing a header parser can mangle. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const IDEMPOTENCY_TTL_HOURS = 24;
/** A cached body is stored as jsonb; creation responses are tiny, so a hard cap protects the table. */
export const MAX_RESPONSE_BYTES = 16_384;

export interface IdempotentResponse {
  /** 2xx only: failures are never cached. */
  status: number;
  body: Record<string, unknown>;
}
export interface IdempotentResult extends IdempotentResponse {
  /** True when the response came from the store and the business work did NOT run. */
  replayed: boolean;
}

/** Missing header ⇒ 428; present but malformed (or repeated) ⇒ 400. Pass `req.headers['idempotency-key']`. */
export function parseIdempotencyKey(header: unknown): string {
  if (header === undefined) {
    throw new AppError(428, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required.');
  }
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must be 16 to 128 characters: letters, digits, "-" or "_".',
    );
  }
  return header;
}

/** JSON with object keys sorted at every depth, so equal requests serialise identically whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error('canonicalJson: unsupported value');
}

/**
 * SHA-256 (hex) of the canonical form of `{operation, request}`. `request` must be the NORMALISED request (parsed,
 * trimmed, lower-cased where the service treats values as equal), never the raw body, or two equal requests would hash
 * differently. The tenant and the principal are part of the record identity, not of the hash.
 */
export function requestFingerprint(operation: string, request: unknown): string {
  return createHash('sha256').update(canonicalJson({ operation, request })).digest('hex');
}

interface StoredRow {
  operation: string;
  request_hash: string;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  expired: boolean;
}

const MAX_ATTEMPTS = 4;

function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * Lock and statement timeouts come from the runtime role's settings (lock_timeout, statement_timeout; the SQL guard
 * forbids setting them per statement). They are mapped to fixed answers instead of leaking as 500:
 *  - waiting for a concurrent request with the SAME key (55P03 while claiming) ⇒ 409, safe to retry;
 *  - any other lock timeout, or a statement timeout ⇒ 503, safe to retry (the transaction rolled back).
 */
function timeoutError(err: unknown, claiming: boolean): AppError | undefined {
  const code = pgCode(err);
  if (code === '55P03' && claiming) {
    return new AppError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    );
  }
  if (code === '55P03' || code === '57014') {
    return databaseBusy();
  }
  return undefined;
}

async function claiming<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw timeoutError(err, true) ?? err;
  }
}

/**
 * Runs `work` at most once per (tenant, principal, key) within the key's lifetime. Call it INSIDE `withTenant`, after
 * authentication and authorization have been decided (a replay must not bypass them) and after the request has been
 * validated. `request` is the normalised request that is fingerprinted.
 *
 * `work` runs in the same transaction as the claim and returns the response to cache. If it throws, nothing is cached.
 */
export async function runIdempotent(
  tx: TenantTx,
  ctx: TrustedContext,
  opts: { key: string; operation: string; request: unknown },
  work: () => Promise<IdempotentResponse>,
): Promise<IdempotentResult> {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(opts.key)) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Invalid idempotency key reached the store.');
  }
  const hash = requestFingerprint(opts.operation, opts.request);
  const id = [ctx.tenantId, ctx.userId, opts.key];

  const finish = async (): Promise<IdempotentResult> => {
    let response: IdempotentResponse;
    try {
      response = await work();
    } catch (err) {
      throw timeoutError(err, false) ?? err;
    }
    const text = JSON.stringify(response.body);
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 299 ||
      Buffer.byteLength(text) > MAX_RESPONSE_BYTES
    ) {
      throw new AppError(500, 'INTERNAL_ERROR', 'The response cannot be stored for replay.');
    }
    await claiming(() =>
      tx.query(
        `UPDATE app.idempotency_keys SET response_status = $4, response_body = $5::jsonb
          WHERE organization_id = $1 AND user_id = $2 AND key = $3`,
        [...id, response.status, text],
      ),
    );
    return { ...response, replayed: false };
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Serialisation point: a concurrent claim of the same key blocks here on the primary-key index until the other
    // transaction ends. Committed ⇒ DO NOTHING (replay below); rolled back ⇒ this insert wins.
    const claimed = await claiming(() =>
      tx.query(
        `INSERT INTO app.idempotency_keys
           (organization_id, user_id, key, operation, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6::int))
         ON CONFLICT (organization_id, user_id, key) DO NOTHING
         RETURNING key`,
        [...id, opts.operation, hash, IDEMPOTENCY_TTL_HOURS],
      ),
    );
    if ((claimed.rowCount ?? 0) > 0) return finish();

    const found = await claiming(() =>
      tx.query<StoredRow>(
        `SELECT operation, request_hash, response_status, response_body, expires_at <= now() AS expired
           FROM app.idempotency_keys
          WHERE organization_id = $1 AND user_id = $2 AND key = $3`,
        id,
      ),
    );
    const row = found.rows[0];
    if (!row) continue; // cannot normally happen (no DELETE grant); re-claim rather than guess

    if (row.expired) {
      // Replace in place. The predicate makes two racing replacements safe: the loser blocks on the row lock, re-checks
      // expires_at against the winner's new value, updates nothing and re-reads the winner's claim on the next pass.
      const replaced = await claiming(() =>
        tx.query(
          `UPDATE app.idempotency_keys
              SET operation = $4, request_hash = $5, response_status = NULL, response_body = NULL,
                  created_at = now(), expires_at = now() + make_interval(hours => $6::int)
            WHERE organization_id = $1 AND user_id = $2 AND key = $3 AND expires_at <= now()
        RETURNING key`,
          [...id, opts.operation, hash, IDEMPOTENCY_TTL_HOURS],
        ),
      );
      if ((replaced.rowCount ?? 0) > 0) return finish();
      continue;
    }

    if (row.operation !== opts.operation || row.request_hash.trim() !== hash) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (row.response_status === null || row.response_body === null) {
      // A committed claim without a response means a bug in a caller of this module, never a client error.
      throw new AppError(500, 'INTERNAL_ERROR', 'The stored idempotent response is incomplete.');
    }
    return { status: row.response_status, body: row.response_body, replayed: true };
  }
  throw new AppError(
    409,
    'IDEMPOTENCY_IN_PROGRESS',
    'A request with this Idempotency-Key is still being processed. Retry shortly.',
  );
}
