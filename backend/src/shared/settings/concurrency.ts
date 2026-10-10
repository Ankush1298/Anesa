import { createHash } from 'node:crypto';
import { AppError } from '../errors/http-errors.js';

/**
 * Expected version parsed from an If-Match header (or supplied internally).
 *  - 'unconditional': used internally when no optimistic concurrency check is requested.
 *  - 'initial': the client expects the resource to not yet exist in the database (e.g. If-Match: "0" or "null").
 *  - 'exists': the client expects the resource to exist at any version (If-Match: "*").
 *  - 'version': the client expects the resource to exist at an exact version number (If-Match: "<version>").
 */
export type ExpectedVersion =
  | { type: 'unconditional' }
  | { type: 'initial' }
  | { type: 'exists' }
  | { type: 'version'; version: number };

/**
 * Parses the HTTP If-Match header for versioned resource mutations (docs/architecture/v3/08 §4.1, 09 §9).
 *
 * Requirements:
 *  - Missing / empty header => 428 PRECONDITION_REQUIRED (doc 09 S-12 line 192, ADR-021).
 *  - '*' => { type: 'exists' }
 *  - '0' or 'null' (quoted or unquoted) => { type: 'initial' } (for setting an unpersisted default).
 *  - Positive integer (quoted or unquoted) => { type: 'version', version }.
 *  - Weak tags (W/...) or any other string => 400 BAD_REQUEST (RFC 9110 §13.1.1 strong comparison).
 */
export function parseIfMatch(header: string | undefined): ExpectedVersion {
  if (header === undefined || header === null || header.trim() === '') {
    throw new AppError(428, 'PRECONDITION_REQUIRED', 'If-Match header is required.');
  }

  const raw = header.trim();
  if (raw === '*' || raw === '"*"') {
    return { type: 'exists' };
  }

  // RFC 9110 §13.1.1 & §8.8.3.2: If-Match requires strong comparison; weak entity tags (W/...) MUST NOT match.
  if (raw.startsWith('W/')) {
    throw new AppError(400, 'BAD_REQUEST', 'Weak entity tags cannot be used in If-Match headers.');
  }

  // Strip surrounding quotes if present
  let inner = raw;
  if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
    inner = inner.slice(1, -1).trim();
  }

  if (inner === '0' || inner === 'null') {
    return { type: 'initial' };
  }

  if (/^[1-9]\d*$/.test(inner)) {
    const version = Number.parseInt(inner, 10);
    if (Number.isSafeInteger(version)) {
      return { type: 'version', version };
    }
  }

  throw new AppError(400, 'BAD_REQUEST', 'Invalid If-Match header.');
}

/**
 * Computes a deterministic weak ETag for a settings collection representation.
 */
export function computeCollectionETag(
  items: readonly { key: string; version: number | null }[],
): string {
  const payload = items.map((i) => `${i.key}:${i.version ?? '0'}`).join(';');
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}
