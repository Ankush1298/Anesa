import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import {
  IDEMPOTENCY_KEY_PATTERN,
  canonicalJson,
  parseIdempotencyKey,
  requestFingerprint,
  runIdempotent,
} from '../../src/shared/idempotency/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

const KEY = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.statusCode : undefined;
  }
  return undefined;
}

describe('Idempotency-Key header', () => {
  it('missing ⇒ 428', () => {
    expect(statusOf(() => parseIdempotencyKey(undefined))).toBe(428);
  });

  it('accepts 16-128 URL-safe characters (a UUID, a 16-char and a 128-char key)', () => {
    for (const ok of [KEY, 'A'.repeat(16), 'a_b-c'.repeat(25) + 'abc']) {
      expect(ok.length).toBeGreaterThanOrEqual(16);
      expect(parseIdempotencyKey(ok)).toBe(ok);
    }
    expect(parseIdempotencyKey('x'.repeat(128))).toHaveLength(128);
  });

  it.each([
    ['empty', ''],
    ['too short (15)', 'a'.repeat(15)],
    ['too long (129)', 'a'.repeat(129)],
    ['space', 'abcdefgh ijklmnopq'],
    ['control character', `abcdefghijklmnop${String.fromCharCode(7)}`],
    ['slash', 'abcdefgh/ijklmnopq'],
    ['quote', 'abcdefgh"ijklmnopq'],
    ['non-ASCII', 'abcdefghijklmnopé'],
    ['a repeated header (array)', [KEY, KEY]],
    ['a number', 1234567890123456],
  ])('malformed (%s) ⇒ 400', (_label, value) => {
    expect(statusOf(() => parseIdempotencyKey(value))).toBe(400);
  });

  it('the pattern is anchored (no partial match)', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(`${KEY}\n`)).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test(` ${KEY}`)).toBe(false);
  });
});

describe('canonical request hashing', () => {
  it('is independent of object key order at every depth, and of undefined members', () => {
    const a = { userId: 'u', nested: { b: 1, a: [1, { y: 2, x: 1 }] }, skipped: undefined };
    const b = { nested: { a: [1, { x: 1, y: 2 }], b: 1 }, userId: 'u' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(requestFingerprint('POST /x', a)).toBe(requestFingerprint('POST /x', b));
  });

  it('is a lowercase SHA-256 hex digest (64 chars), stable across calls', () => {
    const h = requestFingerprint('POST /x', { a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint('POST /x', { a: 1 })).toBe(h);
  });

  it('any difference in the request or the operation changes the hash', () => {
    const base = requestFingerprint('POST /x', { a: '1', b: '2' });
    expect(requestFingerprint('POST /x', { a: '1', b: '3' })).not.toBe(base);
    expect(requestFingerprint('POST /x', { a: '1' })).not.toBe(base);
    expect(requestFingerprint('POST /y', { a: '1', b: '2' })).not.toBe(base);
    // types matter: the string "1" is not the number 1; arrays are ordered
    expect(requestFingerprint('o', { a: 1 })).not.toBe(requestFingerprint('o', { a: '1' }));
    expect(requestFingerprint('o', { a: [1, 2] })).not.toBe(requestFingerprint('o', { a: [2, 1] }));
  });

  it('cannot be confused by values that look like structure', () => {
    expect(requestFingerprint('o', { a: 'x","b":"y' })).not.toBe(
      requestFingerprint('o', { a: 'x', b: 'y' }),
    );
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

describe('timeout outcomes are mapped deterministically (stubbed transaction, no database)', () => {
  const ctx = issueTrustedContext({
    tenantId: '01939a00-0000-7000-8000-000000000a01',
    userId: '01939a00-0000-7000-8000-00000000aa03',
    actorKind: 'STAFF',
  });
  const opts = { key: KEY, operation: 'POST /x', request: { a: 1 } };
  const pgError = (code: string): Error => Object.assign(new Error('pg'), { code });
  const txThrowing = (code: string, onCall: number): TenantTx => {
    let n = 0;
    return {
      query: () => {
        n++;
        return n === onCall
          ? Promise.reject(pgError(code))
          : Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as TenantTx;
  };
  const work = (): Promise<{ status: number; body: Record<string, unknown> }> =>
    Promise.resolve({ status: 201, body: {} });

  it('55P03 while claiming (waiting for the same key) ⇒ 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    await expect(runIdempotent(txThrowing('55P03', 1), ctx, opts, work)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });

  it('57014 (statement timeout) while claiming ⇒ 503 DATABASE_BUSY', async () => {
    await expect(runIdempotent(txThrowing('57014', 1), ctx, opts, work)).rejects.toMatchObject({
      statusCode: 503,
      code: 'DATABASE_BUSY',
    });
  });

  it('a lock or statement timeout inside the business work ⇒ 503 DATABASE_BUSY, never 409 "in progress"', async () => {
    for (const code of ['55P03', '57014']) {
      await expect(
        runIdempotent(txThrowing('00000', 99), ctx, opts, () => Promise.reject(pgError(code))),
      ).rejects.toMatchObject({ statusCode: 503, code: 'DATABASE_BUSY' });
    }
  });

  it('any other database error propagates unchanged', async () => {
    await expect(runIdempotent(txThrowing('23505', 1), ctx, opts, work)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('an untrusted context and a malformed key never reach the database', async () => {
    const never = {
      query: () => Promise.reject(new Error('must not be called')),
    } as unknown as TenantTx;
    await expect(
      runIdempotent(never, {} as unknown as typeof ctx, opts, work),
    ).rejects.toMatchObject({ statusCode: 500 });
    await expect(runIdempotent(never, ctx, { ...opts, key: 'short' }, work)).rejects.toMatchObject({
      statusCode: 500,
    });
  });
});
