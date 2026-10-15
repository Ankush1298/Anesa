import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  CURSOR_MAX_FUTURE_SKEW_SECONDS,
  CURSOR_MAX_LENGTH,
  CURSOR_TTL_SECONDS,
  createCursorCodec,
  type CursorBinding,
  type CursorKeySource,
} from '../../src/shared/pagination/index.js';

// All key and cursor values are generated at run time (secret-scanner rules); nothing below is a real credential.
const newKey = (): string => randomBytes(32).toString('base64url');
const source = (text: string): CursorKeySource => ({ reveal: () => text });
function keyring(entries: Record<string, string>, activeKeyId: string) {
  return {
    activeKeyId,
    keys: new Map(
      Object.entries(entries).map(([id, text]): [string, CursorKeySource] => [id, source(text)]),
    ),
  };
}

const NOW_SECONDS = 1_800_000_000;
let clockMs = NOW_SECONDS * 1000;
const now = (): number => clockMs;
const setNow = (seconds: number): void => {
  clockMs = seconds * 1000;
};

const BINDING: CursorBinding = {
  tenantId: uuidv7(),
  userId: uuidv7(),
  routeId: 'students.directory',
  filterHash: 'ab'.repeat(32),
};
const POSITION = 'ADM-2026-0042';
const INPUT = { ...BINDING, lastAdmissionNumber: POSITION };

const MESSAGE = 'The cursor is invalid or has expired.';

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected the call to throw');
}

/**
 * Builds an envelope by hand, so a test can make a cursor that is valid except for exactly one defect.
 * The additional authenticated data defaults to the header bytes (what the codec expects); `aad` replaces it with
 * other bytes or, as 'omit', leaves it out. `kid` is written byte for byte (latin1), so a test can use high-bit bytes.
 */
function seal(
  keyText: string,
  kid: string,
  plaintext: string,
  options: { version?: number; aad?: Buffer | 'omit' } = {},
): string {
  const kidBytes = Buffer.from(kid, 'latin1');
  const header = Buffer.concat([Buffer.from([options.version ?? 1, kidBytes.length]), kidBytes]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyText, 'base64url'), nonce, {
    authTagLength: 16,
  });
  if (options.aad !== 'omit') cipher.setAAD(options.aad ?? header);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([header, nonce, body, cipher.getAuthTag()]).toString('base64url');
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...INPUT,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + CURSOR_TTL_SECONDS,
    ...overrides,
  });
}

describe('createCursorCodec: keyring validation', () => {
  const a = newKey();
  const b = newKey();

  it.each([
    ['no keys', keyring({}, 'k1')],
    ['five keys', keyring({ k1: a, k2: newKey(), k3: newKey(), k4: newKey(), k5: newKey() }, 'k1')],
    ['active key not in the keyring', keyring({ k1: a }, 'k2')],
    ['invalid key ID (space)', keyring({ 'k 1': a }, 'k 1')],
    ['invalid key ID (too long)', keyring({ ['k'.repeat(17)]: a }, 'k'.repeat(17))],
    ['invalid key ID (leading dash)', keyring({ '-k': a }, '-k')],
    ['padded key', keyring({ k1: `${a}=` }, 'k1')],
    ['standard base64 characters', keyring({ k1: '+'.repeat(43) }, 'k1')],
    ['non-canonical trailing bits', keyring({ k1: `${a.slice(0, 42)}B` }, 'k1')],
    ['31-byte key', keyring({ k1: randomBytes(31).toString('base64url') }, 'k1')],
    ['33-byte key', keyring({ k1: randomBytes(33).toString('base64url') }, 'k1')],
    ['duplicate key material', keyring({ k1: a, k2: a }, 'k1')],
  ])('rejects: %s', (_name, ring) => {
    expect(() => createCursorCodec(ring, { now })).toThrow(Error);
    let message = '';
    try {
      createCursorCodec(ring, { now });
    } catch (e) {
      expect(e).not.toBeInstanceOf(AppError);
      message = (e as Error).message;
    }
    expect(message).not.toContain(a);
    expect(message).not.toContain(b);
  });

  it('accepts one to four valid keys', () => {
    expect(() => createCursorCodec(keyring({ k1: a }, 'k1'), { now })).not.toThrow();
    const four = { k1: a, k2: b, k3: newKey(), k4: newKey() };
    expect(() => createCursorCodec(keyring(four, 'k4'), { now })).not.toThrow();
  });
});

describe('cursor codec: encode and decode', () => {
  const k1 = newKey();
  const k2 = newKey();
  const codec = createCursorCodec(keyring({ k1 }, 'k1'), { now });

  it('round-trips with the active key and returns only the position', () => {
    setNow(NOW_SECONDS);
    expect(codec.decode(codec.encode(INPUT), BINDING)).toEqual({ lastAdmissionNumber: POSITION });
  });

  it('emits the documented envelope: version 1, key ID in the header, canonical base64url, within the size limit', () => {
    setNow(NOW_SECONDS);
    const text = codec.encode(INPUT);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    const raw = Buffer.from(text, 'base64url');
    expect(raw.toString('base64url')).toBe(text);
    expect(raw[0]).toBe(1);
    expect(raw[1]).toBe(2);
    expect(raw.toString('ascii', 2, 4)).toBe('k1');
  });

  it('keeps a worst-case payload within the size limit', () => {
    setNow(NOW_SECONDS);
    const worst = {
      ...INPUT,
      routeId: `r${'a'.repeat(63)}`,
      lastAdmissionNumber: 'Z'.repeat(64),
    };
    const text = codec.encode(worst);
    expect(text.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    expect(codec.decode(text, worst).lastAdmissionNumber).toBe('Z'.repeat(64));
  });

  it('uses a fresh nonce for every encoding', () => {
    setNow(NOW_SECONDS);
    const texts = Array.from({ length: 50 }, () => codec.encode(INPUT));
    expect(new Set(texts).size).toBe(50);
    const nonces = texts.map((t) => Buffer.from(t, 'base64url').subarray(4, 16).toString('hex'));
    expect(new Set(nonces).size).toBe(50);
  });

  it('issues cursors that live exactly the fixed 600 seconds', () => {
    setNow(NOW_SECONDS);
    const text = codec.encode(INPUT);
    setNow(NOW_SECONDS + CURSOR_TTL_SECONDS - 1);
    expect(codec.decode(text, BINDING).lastAdmissionNumber).toBe(POSITION);
    setNow(NOW_SECONDS + CURSOR_TTL_SECONDS);
    expect(failure(() => codec.decode(text, BINDING)).code).toBe('INVALID_CURSOR');
  });

  it('supports two-phase rotation: retiring keys decode, the active key encodes, removed keys are refused', () => {
    setNow(NOW_SECONDS);
    const before = createCursorCodec(keyring({ k1 }, 'k1'), { now });
    const during = createCursorCodec(keyring({ k1, k2 }, 'k2'), { now });
    const after = createCursorCodec(keyring({ k2 }, 'k2'), { now });

    const oldCursor = before.encode(INPUT);
    // phase 1/2: the new key is configured and active, the old one is retiring
    expect(during.decode(oldCursor, BINDING).lastAdmissionNumber).toBe(POSITION);
    const newCursor = during.encode(INPUT);
    expect(Buffer.from(newCursor, 'base64url').toString('ascii', 2, 4)).toBe('k2');
    expect(after.decode(newCursor, BINDING).lastAdmissionNumber).toBe(POSITION);
    // the old key is removed: cursors encrypted with it stop working
    expect(failure(() => after.decode(oldCursor, BINDING)).code).toBe('INVALID_CURSOR');
    // a new-key cursor is unknown to a deployment that does not have the key yet
    expect(failure(() => before.decode(newCursor, BINDING)).code).toBe('INVALID_CURSOR');
  });

  it('exposes only encode and decode and never serialises key material', () => {
    expect(Object.keys(codec).sort()).toEqual(['decode', 'encode']);
    expect(JSON.stringify(codec)).not.toContain(k1);
    expect(inspect(codec, { depth: 6, showHidden: true })).not.toContain(k1);
    expect(inspect(codec, { depth: 6 })).not.toContain(
      Buffer.from(k1, 'base64url').toString('hex'),
    );
  });
});

describe('cursor codec: every decode failure is the same public error', () => {
  const k1 = newKey();
  const codec = createCursorCodec(keyring({ k1 }, 'k1'), { now });

  function expectInvalid(text: unknown, expected: CursorBinding = BINDING): void {
    const err = failure(() => codec.decode(text as string, expected));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('INVALID_CURSOR');
    expect(err.message).toBe(MESSAGE);
    expect(err.message).not.toContain(k1);
    expect(err.message).not.toContain('k1');
  }
  function expectValid(text: string): void {
    expect(codec.decode(text, BINDING).lastAdmissionNumber).toBe(POSITION);
  }

  it('control: a hand-sealed baseline cursor decodes, so each case below fails for its one defect only', () => {
    setNow(NOW_SECONDS);
    expectValid(seal(k1, 'k1', payload()));
  });

  it('refuses malformed, truncated, oversized and non-canonical text', () => {
    setNow(NOW_SECONDS);
    const valid = codec.encode(INPUT);
    for (const text of [
      '',
      'not base64url!',
      `${valid}=`,
      valid.replace(/.$/, '+'),
      valid.slice(0, 20),
      valid.slice(0, -1),
      'A'.repeat(CURSOR_MAX_LENGTH + 1),
      undefined,
      null,
      42,
      {},
    ]) {
      expectInvalid(text);
    }

    // Valid in every respect but size: the length cap alone must refuse it.
    const small = seal(k1, 'k1', payload());
    expectValid(small);
    const big = seal(k1, 'k1', `${payload()}${' '.repeat(900)}`);
    expect(big.length).toBeGreaterThan(CURSOR_MAX_LENGTH);
    expectInvalid(big);

    // Valid in every respect but the trailing padding bits of the base64url text: only the canonical check refuses it.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let padded = payload();
    let sealed = seal(k1, 'k1', padded);
    while (Buffer.from(sealed, 'base64url').length % 3 === 0) {
      padded += ' ';
      sealed = seal(k1, 'k1', padded);
    }
    expectValid(sealed);
    const last = sealed.at(-1) as string;
    const tweaked = sealed.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(Buffer.from(tweaked, 'base64url').equals(Buffer.from(sealed, 'base64url'))).toBe(true);
    expectInvalid(tweaked);
  });

  it('refuses a tampered header, nonce, ciphertext or tag', () => {
    setNow(NOW_SECONDS);
    const raw = Buffer.from(codec.encode(INPUT), 'base64url');
    const positions = {
      version: 0,
      keyIdLength: 1,
      keyId: 2,
      nonce: 8,
      ciphertext: 20,
      tag: raw.length - 5,
    };
    for (const index of Object.values(positions)) {
      const copy = Buffer.from(raw);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expectInvalid(copy.toString('base64url'));
    }
  });

  it('refuses an unsupported version, an unknown key ID and a wrong key under a known ID', () => {
    setNow(NOW_SECONDS);
    expectInvalid(seal(k1, 'k1', payload(), { version: 2 }));
    expectInvalid(seal(k1, 'k1', payload(), { version: 0 }));
    expectInvalid(seal(k1, 'zz', payload()));
    expectInvalid(seal(newKey(), 'k1', payload()));
  });

  it('refuses a cursor whose additional authenticated data is not exactly its header bytes', () => {
    setNow(NOW_SECONDS);
    const aad = (version: number, kid: string): Buffer =>
      Buffer.concat([Buffer.from([version, kid.length]), Buffer.from(kid, 'ascii')]);
    // Control: the same envelope, key and payload decode when the AAD is the header, so each case below differs only in AAD.
    expectValid(seal(k1, 'k1', payload(), { aad: aad(1, 'k1') }));
    expectInvalid(seal(k1, 'k1', payload(), { aad: 'omit' }));
    expectInvalid(seal(k1, 'k1', payload(), { aad: Buffer.alloc(0) }));
    expectInvalid(seal(k1, 'k1', payload(), { aad: aad(1, 'k2') })); // another key ID
    expectInvalid(seal(k1, 'k1', payload(), { aad: aad(2, 'k1') })); // another version
    const trailing = Buffer.concat([aad(1, 'k1'), Buffer.from([0])]); // one extra byte
    expectInvalid(seal(k1, 'k1', payload(), { aad: trailing }));
  });

  it('does not let a key-ID byte with the high bit set alias a configured key ID', () => {
    setNow(NOW_SECONDS);
    // 0xEB with the high bit stripped is 'k': under ASCII decoding this header would resolve to key "k1".
    const alias = 'ë1';
    expect(Buffer.from(alias, 'latin1').toString('ascii')).toBe('k1');
    // Control: with the real ID the identical envelope decodes. The alias envelope is authentic (same key, header
    // authenticated as its own AAD), so only the key-ID decoding can refuse it.
    expectValid(seal(k1, 'k1', payload()));
    expectInvalid(seal(k1, alias, payload()));
  });

  it('refuses a payload that is not exactly the seven validated fields', () => {
    setNow(NOW_SECONDS);
    const cases: [string, string][] = [
      ['not JSON', 'not json'],
      ['array', '[]'],
      ['null', 'null'],
      ['string', '"x"'],
      ['extra field', payload({ extra: 1 })],
      ['tenant not a string', payload({ tenantId: 7 })],
      ['tenant not a UUID', payload({ tenantId: 'x' })],
      ['tenant UUIDv4', payload({ tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })],
      ['tenant upper-case', payload({ tenantId: BINDING.tenantId.toUpperCase() })],
      ['user upper-case', payload({ userId: BINDING.userId.toUpperCase() })],
      ['route with a space', payload({ routeId: 'Bad Route' })],
      ['route too long', payload({ routeId: `r${'a'.repeat(64)}` })],
      ['filter hash too short', payload({ filterHash: 'ab'.repeat(31) })],
      ['filter hash upper-case', payload({ filterHash: 'AB'.repeat(32) })],
      ['position empty', payload({ lastAdmissionNumber: '' })],
      ['position too long', payload({ lastAdmissionNumber: 'a'.repeat(65) })],
      ['position with a space', payload({ lastAdmissionNumber: 'a b' })],
      ['position not a string', payload({ lastAdmissionNumber: 5 })],
      ['iat a string', payload({ iat: String(NOW_SECONDS) })],
      ['iat fractional', payload({ iat: NOW_SECONDS + 0.5 })],
      ['iat zero', payload({ iat: 0 })],
      ['exp null', payload({ exp: Number.NaN })],
      ['exp negative', payload({ exp: -1 })],
    ];
    for (const field of Object.keys(INPUT).concat(['iat', 'exp'])) {
      cases.push([`missing ${field}`, payload({ [field]: undefined })]);
    }
    for (const [, plaintext] of cases) {
      expectInvalid(seal(k1, 'k1', plaintext));
    }
  });

  it('refuses a cursor bound to a different tenant, user, route or filter', () => {
    setNow(NOW_SECONDS);
    const text = codec.encode(INPUT);
    expectInvalid(text, { ...BINDING, tenantId: uuidv7() });
    expectInvalid(text, { ...BINDING, userId: uuidv7() });
    expectInvalid(text, { ...BINDING, routeId: 'students.other' });
    expectInvalid(text, { ...BINDING, filterHash: 'cd'.repeat(32) });
  });

  it('gives identical status, code and message for different failure causes', () => {
    setNow(NOW_SECONDS);
    const tampered = failure(() => codec.decode('A'.repeat(60), BINDING));
    const mismatch = failure(() => codec.decode(codec.encode(INPUT), { ...BINDING, routeId: 'x' }));
    expect({ s: tampered.statusCode, c: tampered.code, m: tampered.message }).toEqual({
      s: mismatch.statusCode,
      c: mismatch.code,
      m: mismatch.message,
    });
  });
});

describe('cursor codec: clock policy (injected clock)', () => {
  const k1 = newKey();
  const codec = createCursorCodec(keyring({ k1 }, 'k1'), { now });
  const decodeAt = (iat: number, exp: number, atSeconds = NOW_SECONDS): void => {
    setNow(atSeconds);
    codec.decode(seal(k1, 'k1', payload({ iat, exp })), BINDING);
  };
  const refusedAt = (iat: number, exp: number, atSeconds = NOW_SECONDS): void => {
    expect(failure(() => decodeAt(iat, exp, atSeconds)).code).toBe('INVALID_CURSOR');
  };

  it('requires exp to be later than now, and the skew allowance never extends expiry', () => {
    expect(() => decodeAt(NOW_SECONDS - 599, NOW_SECONDS + 1)).not.toThrow();
    refusedAt(NOW_SECONDS - 600, NOW_SECONDS); // exp === now
    refusedAt(NOW_SECONDS - 700, NOW_SECONDS - 100);
    refusedAt(NOW_SECONDS - 600, NOW_SECONDS - 1);
  });

  it('accepts an issue time up to 30 seconds ahead and refuses 31', () => {
    expect(CURSOR_MAX_FUTURE_SKEW_SECONDS).toBe(30);
    expect(() => decodeAt(NOW_SECONDS + 30, NOW_SECONDS + 30 + CURSOR_TTL_SECONDS)).not.toThrow();
    refusedAt(NOW_SECONDS + 31, NOW_SECONDS + 31 + CURSOR_TTL_SECONDS);
  });

  it('refuses a lifetime above 600 seconds and an exp that is not after iat', () => {
    expect(() => decodeAt(NOW_SECONDS, NOW_SECONDS + CURSOR_TTL_SECONDS)).not.toThrow();
    refusedAt(NOW_SECONDS, NOW_SECONDS + CURSOR_TTL_SECONDS + 1);
    refusedAt(NOW_SECONDS, NOW_SECONDS); // exp === iat
    refusedAt(NOW_SECONDS + 10, NOW_SECONDS + 5); // exp < iat
  });

  it('floors the injected millisecond clock to whole seconds', () => {
    clockMs = NOW_SECONDS * 1000 + 999;
    const text = codec.encode(INPUT);
    clockMs = (NOW_SECONDS + CURSOR_TTL_SECONDS) * 1000 - 1;
    expect(codec.decode(text, BINDING).lastAdmissionNumber).toBe(POSITION);
    clockMs = (NOW_SECONDS + CURSOR_TTL_SECONDS) * 1000;
    expect(failure(() => codec.decode(text, BINDING)).code).toBe('INVALID_CURSOR');
  });
});

describe('cursor codec: programming errors are not client errors', () => {
  const codec = createCursorCodec(keyring({ k1: newKey() }, 'k1'), { now });

  function plain(fn: () => unknown): Error {
    try {
      fn();
    } catch (e) {
      expect(e).not.toBeInstanceOf(AppError);
      return e as Error;
    }
    throw new Error('expected the call to throw');
  }

  it('encode rejects an invalid binding or position with a plain Error that never echoes the value', () => {
    setNow(NOW_SECONDS);
    const bad: Partial<typeof INPUT>[] = [
      { tenantId: 'x' },
      { userId: BINDING.userId.toUpperCase() },
      { routeId: '' },
      { filterHash: 'nothex' },
      { lastAdmissionNumber: '' },
      { lastAdmissionNumber: 'with space' },
    ];
    for (const override of bad) {
      const err = plain(() => codec.encode({ ...INPUT, ...override }));
      for (const v of Object.values(override)) if (v) expect(err.message).not.toContain(v);
    }
  });

  it('decode rejects an invalid expected binding with a plain Error, not INVALID_CURSOR', () => {
    setNow(NOW_SECONDS);
    const text = codec.encode(INPUT);
    plain(() => codec.decode(text, { ...BINDING, tenantId: 'x' }));
    plain(() => codec.decode(text, { ...BINDING, filterHash: 'zz' }));
  });
});
