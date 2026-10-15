import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors/http-errors.js';
import { isUuidV7 } from '../ids/uuidv7.js';

/**
 * Authenticated, opaque pagination cursors (docs/architecture/v3/security_artitecture.md: "opaque, signed cursors bound
 * to principal and query"; FU-EMP-1 in 20-employees.md). A cursor is an AES-256-GCM envelope around a small payload that
 * binds tenant, user, route, filter hash and the last admission number seen, plus an issue and an expiry time.
 *
 * The codec is stateless and knows nothing about routes, permissions, ordering or the database. It is not wired into
 * any route yet.
 *
 * Envelope (base64url, unpadded; canonical form is enforced on decode):
 *   version(1) | keyIdLength(1) | keyId(ASCII) | nonce(12, random per cursor) | ciphertext | tag(16)
 * The version byte, key-ID length and key ID are the additional authenticated data (AAD).
 *
 * Replay: a cursor is NOT single-use. Anyone holding a valid cursor can reuse it for the same user, route and filter
 * until it expires. The binding and the expiry limit that; they do not prevent it.
 *
 * Every decode failure is the same public 400 INVALID_CURSOR. The reason is deliberately not recorded anywhere.
 */

/** Maximum cursor lifetime in seconds (`exp - iat`) and the lifetime of every cursor this codec issues. */
export const CURSOR_TTL_SECONDS = 600;
/**
 * Clock-skew tolerance: a cursor whose `iat` is up to 30 seconds ahead of this instance's clock is still accepted, so a
 * cursor issued by another instance with a slightly fast clock is not refused. The allowance does NOT extend expiry
 * (`exp` must still be later than the local time) and is deliberately a constant, not configuration.
 */
export const CURSOR_MAX_FUTURE_SKEW_SECONDS = 30;
/** Longest accepted encoded cursor. A worst-case payload encodes to about 620 characters; this is checked before decoding. */
export const CURSOR_MAX_LENGTH = 1024;
export const CURSOR_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
export const CURSOR_MAX_KEYS = 4;

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** version + key-ID length + 1-byte key ID + nonce + 1 byte of ciphertext + tag */
const MIN_RAW_BYTES = 2 + 1 + NONCE_BYTES + 1 + TAG_BYTES;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const KEY_TEXT_RE = /^[A-Za-z0-9_-]{43}$/;
const ROUTE_ID_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const FILTER_HASH_RE = /^[0-9a-f]{64}$/;
const POSITION_RE = /^[\x21-\x7E]{1,64}$/;

const PAYLOAD_FIELDS = [
  'tenantId',
  'userId',
  'routeId',
  'filterHash',
  'lastAdmissionNumber',
  'iat',
  'exp',
] as const;

/** Anything that can reveal a key as canonical unpadded base64url text. The config `Secret` satisfies this. */
export interface CursorKeySource {
  reveal(): string;
}

export interface CursorKeyring {
  /** Used to encode new cursors. Must be a key of `keys`. */
  readonly activeKeyId: string;
  /** Every key a cursor may have been encrypted with: the active key plus retiring keys (decode only). */
  readonly keys: ReadonlyMap<string, CursorKeySource>;
}

/** What a cursor is bound to. The expected values come from the trusted context and the normalised request. */
export interface CursorBinding {
  readonly tenantId: string;
  readonly userId: string;
  readonly routeId: string;
  /** Lower-case hex SHA-256 of the normalised filters, for example the output of `requestFingerprint`. */
  readonly filterHash: string;
}

export interface CursorPayloadInput extends CursorBinding {
  readonly lastAdmissionNumber: string;
}

export interface CursorCodec {
  /** Issues a cursor valid for `CURSOR_TTL_SECONDS`. Invalid input is a programming error and throws a plain Error. */
  encode(input: CursorPayloadInput): string;
  /**
   * Returns the position when `text` is an unexpired cursor, authentic under a configured key, and bound to exactly
   * `expected`. Any other cursor throws the one public AppError (400 INVALID_CURSOR). An invalid `expected` is a
   * programming error and throws a plain Error.
   */
  decode(text: string, expected: CursorBinding): { readonly lastAdmissionNumber: string };
}

/** True when `text` is the canonical unpadded base64url encoding of exactly 32 bytes (43 characters). */
export function isCanonicalCursorKey(text: string): boolean {
  return KEY_TEXT_RE.test(text) && Buffer.from(text, 'base64url').toString('base64url') === text;
}

function invalidCursor(): AppError {
  return new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid or has expired.');
}

const isId = (v: unknown): v is string => isUuidV7(v) && v === v.toLowerCase();
const isRouteId = (v: unknown): v is string => typeof v === 'string' && ROUTE_ID_RE.test(v);
const isFilterHash = (v: unknown): v is string => typeof v === 'string' && FILTER_HASH_RE.test(v);
const isPosition = (v: unknown): v is string => typeof v === 'string' && POSITION_RE.test(v);
const isSeconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Name of the first invalid binding field, or undefined. Never includes a value. */
function invalidBindingField(b: unknown): string | undefined {
  if (typeof b !== 'object' || b === null) return 'binding';
  const o = b as Record<string, unknown>;
  if (!isId(o.tenantId)) return 'tenantId';
  if (!isId(o.userId)) return 'userId';
  if (!isRouteId(o.routeId)) return 'routeId';
  if (!isFilterHash(o.filterHash)) return 'filterHash';
  return undefined;
}

interface OpenedPayload extends CursorPayloadInput {
  readonly iat: number;
  readonly exp: number;
}

/** Strict payload check: exactly the seven fields, each of the expected type and shape. */
function parsePayload(v: unknown): OpenedPayload | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  if (Object.getPrototypeOf(v) !== Object.prototype) return undefined;
  if (Object.keys(v).length !== PAYLOAD_FIELDS.length) return undefined;
  if (!PAYLOAD_FIELDS.every((k) => Object.hasOwn(v, k))) return undefined;
  const o = v as Record<string, unknown>;
  if (invalidBindingField(o) !== undefined) return undefined;
  if (!isPosition(o.lastAdmissionNumber) || !isSeconds(o.iat) || !isSeconds(o.exp))
    return undefined;
  return {
    tenantId: o.tenantId as string,
    userId: o.userId as string,
    routeId: o.routeId as string,
    filterHash: o.filterHash as string,
    lastAdmissionNumber: o.lastAdmissionNumber,
    iat: o.iat,
    exp: o.exp,
  };
}

/**
 * `now` returns epoch milliseconds (default `Date.now`); it is injectable so tests can pin the clock.
 * Throws a plain Error (a configuration bug, never a client error) when the keyring is malformed.
 */
export function createCursorCodec(
  keyring: CursorKeyring,
  options: { readonly now?: () => number } = {},
): CursorCodec {
  const now = options.now ?? Date.now;

  if (keyring.keys.size < 1 || keyring.keys.size > CURSOR_MAX_KEYS) {
    throw new Error(`Cursor keyring must hold 1 to ${CURSOR_MAX_KEYS} keys.`);
  }
  // The decoded key bytes live only in this closure: no accessor, not enumerable, not serialised.
  const keys = new Map<string, Buffer>();
  const seenMaterial = new Set<string>();
  for (const [id, source] of keyring.keys) {
    if (!CURSOR_KEY_ID_PATTERN.test(id))
      throw new Error('Cursor keyring contains an invalid key ID.');
    const text = source.reveal();
    if (typeof text !== 'string' || !isCanonicalCursorKey(text)) {
      throw new Error('Cursor keyring contains an invalid key.');
    }
    if (seenMaterial.has(text)) throw new Error('Cursor keyring contains a duplicated key.');
    seenMaterial.add(text);
    keys.set(id, Buffer.from(text, 'base64url'));
  }
  const activeKey = keys.get(keyring.activeKeyId);
  if (activeKey === undefined)
    throw new Error('Cursor keyring active key ID is not in the keyring.');
  const activeKid = Buffer.from(keyring.activeKeyId, 'ascii');
  const activeHeader = Buffer.concat([Buffer.from([VERSION, activeKid.length]), activeKid]);

  const nowSeconds = (): number => {
    const s = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(s) || s <= 0)
      throw new Error('Cursor clock returned an invalid time.');
    return s;
  };

  /** Returns the authenticated, valid payload or undefined. Never throws: the caller maps undefined to INVALID_CURSOR. */
  function open(text: unknown, nowSec: number): OpenedPayload | undefined {
    try {
      if (typeof text !== 'string' || text.length === 0 || text.length > CURSOR_MAX_LENGTH)
        return undefined;
      if (!BASE64URL_RE.test(text)) return undefined;
      const raw = Buffer.from(text, 'base64url');
      if (raw.toString('base64url') !== text) return undefined; // non-canonical encoding
      if (raw.length < MIN_RAW_BYTES || raw[0] !== VERSION) return undefined;
      const kidLength = raw[1];
      if (kidLength === undefined || kidLength < 1 || kidLength > 16) return undefined;
      const nonceStart = 2 + kidLength;
      if (raw.length < nonceStart + NONCE_BYTES + 1 + TAG_BYTES) return undefined;
      // latin1 keeps every byte distinct. 'ascii' would drop the high bit, so a header byte such as 0xEB would read as
      // 'k' and alias a configured key ID. A byte >= 0x80 can never equal a configured ID (they are ASCII only).
      const key = keys.get(raw.toString('latin1', 2, nonceStart));
      if (key === undefined) return undefined;

      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        raw.subarray(nonceStart, nonceStart + NONCE_BYTES),
        {
          authTagLength: TAG_BYTES,
        },
      );
      decipher.setAAD(raw.subarray(0, nonceStart));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(raw.subarray(nonceStart + NONCE_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]);

      const p = parsePayload(JSON.parse(plaintext.toString('utf8')));
      if (p === undefined) return undefined;
      if (p.iat > nowSec + CURSOR_MAX_FUTURE_SKEW_SECONDS) return undefined; // issued in the future
      if (p.exp <= nowSec) return undefined; // expired; the skew allowance never extends expiry
      if (p.exp <= p.iat || p.exp - p.iat > CURSOR_TTL_SECONDS) return undefined;
      return p;
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    encode(input: CursorPayloadInput): string {
      const bad =
        invalidBindingField(input) ??
        (isPosition(input.lastAdmissionNumber) ? undefined : 'lastAdmissionNumber');
      if (bad !== undefined) throw new Error(`Invalid cursor input: ${bad}.`);

      const iat = nowSeconds();
      const plaintext = JSON.stringify({
        tenantId: input.tenantId,
        userId: input.userId,
        routeId: input.routeId,
        filterHash: input.filterHash,
        lastAdmissionNumber: input.lastAdmissionNumber,
        iat,
        exp: iat + CURSOR_TTL_SECONDS,
      });
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', activeKey, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(activeHeader);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const text = Buffer.concat([activeHeader, nonce, ciphertext, cipher.getAuthTag()]).toString(
        'base64url',
      );
      if (text.length > CURSOR_MAX_LENGTH)
        throw new Error('Encoded cursor exceeds the size limit.');
      return text;
    },

    decode(text: string, expected: CursorBinding): { readonly lastAdmissionNumber: string } {
      const bad = invalidBindingField(expected);
      if (bad !== undefined) throw new Error(`Invalid expected cursor binding: ${bad}.`);

      const p = open(text, nowSeconds());
      if (
        p === undefined ||
        p.tenantId !== expected.tenantId ||
        p.userId !== expected.userId ||
        p.routeId !== expected.routeId ||
        p.filterHash !== expected.filterHash
      ) {
        throw invalidCursor();
      }
      return { lastAdmissionNumber: p.lastAdmissionNumber };
    },
  });
}
