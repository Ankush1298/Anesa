import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, Secret } from '../../src/config/env.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createCursorCodec } from '../../src/shared/pagination/index.js';

const base = {
  DATABASE_URL: 'postgresql://app:Sup3rS3cretValue@127.0.0.1:5432/db', // secret-scan:allow (deliberate test fixture)
};

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(base);
    expect(c.env).toBe('development');
    expect(c.host).toBe('127.0.0.1');
    expect(c.trustProxy).toBe(false);
    expect(c.database.ssl).toBe(false);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('never echoes a supplied value in error messages', () => {
    const bad = { DATABASE_URL: 'mysql://user:Sup3rS3cretValue@host/db' }; // secret-scan:allow (deliberate test fixture)
    let message = '';
    try {
      loadConfig(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('Sup3rS3cretValue');
  });

  it('requires TLS to the database in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/DATABASE_SSL/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        DATABASE_SSL: 'require',
        APP_ORIGINS: 'https://app.example.edu',
      }),
    ).not.toThrow();
  });

  it('refuses wildcard bind in production unless behind a trusted proxy', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_SSL: 'require',
      HOST: '0.0.0.0',
      APP_ORIGINS: 'https://app.example.edu',
    };
    expect(() => loadConfig(prod)).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'true' })).not.toThrow();
  });
});

describe('APP_ORIGINS (CSRF origin allow-list)', () => {
  const prod = { ...base, NODE_ENV: 'production', DATABASE_SSL: 'require' };
  it('is required in production and must be https', () => {
    expect(() => loadConfig(prod)).toThrow(/APP_ORIGINS: required/);
    expect(() => loadConfig({ ...prod, APP_ORIGINS: 'http://app.example.edu' })).toThrow(/https/);
  });
  it('parses exact origins and rejects paths, wildcards and junk (fail closed)', () => {
    expect(
      loadConfig({ ...base, APP_ORIGINS: 'https://a.edu, http://localhost:5173' }).allowedOrigins,
    ).toEqual(['https://a.edu', 'http://localhost:5173']);
    expect(loadConfig(base).allowedOrigins).toEqual([]);
    for (const bad of [
      '*',
      'https://a.edu/',
      'https://a.edu/path',
      'a.edu',
      'ftp://a.edu',
      'https://*.a.edu',
    ]) {
      expect(() => loadConfig({ ...base, APP_ORIGINS: bad }), bad).toThrow(/APP_ORIGINS/);
    }
  });
});

describe('Secret', () => {
  it('cannot be printed, serialised or inspected', () => {
    const c = loadConfig(base);
    expect(String(c.database.url)).toBe('[REDACTED]');
    expect(`${c.database.url.toString()}`).toBe('[REDACTED]');
    expect(JSON.stringify(c)).not.toContain('Sup3rS3cretValue');
    expect(inspect(c, { depth: 5 })).not.toContain('Sup3rS3cretValue');
  });

  it('reveals only through reveal()', () => {
    expect(new Secret('abc').reveal()).toBe('abc');
  });
});

describe('cursor key configuration (optional)', () => {
  // Generated at run time: nothing below is a real credential.
  const keyA = randomBytes(32).toString('base64url');
  const keyB = randomBytes(32).toString('base64url');
  const keyC = randomBytes(32).toString('base64url');
  const keyD = randomBytes(32).toString('base64url');
  const keyE = randomBytes(32).toString('base64url');
  const prod = {
    ...base,
    NODE_ENV: 'production',
    DATABASE_SSL: 'require',
    APP_ORIGINS: 'https://a.edu',
  };

  function messageOf(env: Record<string, string>): string {
    try {
      loadConfig({ ...base, ...env });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    throw new Error('expected loadConfig to throw');
  }

  it('absent: cursor configuration is absent and existing behaviour is unchanged', () => {
    const c = loadConfig(base);
    expect('cursor' in c).toBe(false);
    expect(c.cursor).toBeUndefined();
    expect(() => loadConfig(prod)).not.toThrow();
    expect('cursor' in loadConfig(prod)).toBe(false);
  });

  it('parses a single key', () => {
    const c = loadConfig({ ...base, CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' });
    expect(c.cursor?.activeKeyId).toBe('k1');
    expect(c.cursor?.keys.size).toBe(1);
    expect(c.cursor?.keys.get('k1')?.reveal()).toBe(keyA);
  });

  it('parses several keys, selects the active one, and still starts in production', () => {
    const c = loadConfig({
      ...prod,
      CURSOR_KEYS: `k1:${keyA},k-2:${keyB},K_3:${keyC},4:${keyD}`,
      CURSOR_ACTIVE_KEY_ID: 'k-2',
    });
    expect(c.cursor?.activeKeyId).toBe('k-2');
    expect([...(c.cursor?.keys.keys() ?? [])]).toEqual(['k1', 'k-2', 'K_3', '4']);
    expect(c.cursor?.keys.get('4')?.reveal()).toBe(keyD);
  });

  it('produces a config the cursor codec accepts directly', () => {
    const c = loadConfig({
      ...base,
      CURSOR_KEYS: `k1:${keyA},k2:${keyB}`,
      CURSOR_ACTIVE_KEY_ID: 'k2',
    });
    if (!c.cursor) throw new Error('cursor configuration missing');
    const codec = createCursorCodec(c.cursor);
    const binding = {
      tenantId: uuidv7(),
      userId: uuidv7(),
      routeId: 'students.directory',
      filterHash: 'ab'.repeat(32),
    };
    expect(codec.decode(codec.encode({ ...binding, lastAdmissionNumber: 'A-1' }), binding)).toEqual(
      {
        lastAdmissionNumber: 'A-1',
      },
    );
  });

  const rejected: [string, Record<string, string>, RegExp][] = [
    ['keys without an active ID', { CURSOR_KEYS: `k1:${keyA}` }, /CURSOR_ACTIVE_KEY_ID: required/],
    ['an active ID without keys', { CURSOR_ACTIVE_KEY_ID: 'k1' }, /CURSOR_KEYS: required/],
    [
      'an explicitly empty CURSOR_KEYS',
      { CURSOR_KEYS: '', CURSOR_ACTIVE_KEY_ID: 'k1' },
      /CURSOR_KEYS: must not be empty/,
    ],
    [
      'an explicitly empty CURSOR_ACTIVE_KEY_ID',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: '' },
      /CURSOR_ACTIVE_KEY_ID: must not be empty/,
    ],
    [
      'both empty',
      { CURSOR_KEYS: '', CURSOR_ACTIVE_KEY_ID: '' },
      /CURSOR_KEYS: must not be empty[\s\S]*CURSOR_ACTIVE_KEY_ID: must not be empty/,
    ],
    [
      'an entry without a separator',
      { CURSOR_KEYS: `k1${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'an extra separator',
      { CURSOR_KEYS: `k1:${keyA}:x`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a trailing comma',
      { CURSOR_KEYS: `k1:${keyA},`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 must be <keyId>:<key>/,
    ],
    [
      'a leading comma',
      { CURSOR_KEYS: `,k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a lone comma',
      { CURSOR_KEYS: ',', CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 must be <keyId>:<key>/,
    ],
    [
      'a space after a comma',
      { CURSOR_KEYS: `k1:${keyA}, k2:${keyB}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 key ID/,
    ],
    ['an empty key ID', { CURSOR_KEYS: `:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' }, /entry 1 key ID/],
    [
      'a key ID with a space',
      { CURSOR_KEYS: `k 1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k 1' },
      /entry 1 key ID/,
    ],
    [
      'a 17-character key ID',
      { CURSOR_KEYS: `${'k'.repeat(17)}:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key ID/,
    ],
    [
      'a key ID starting with a dash',
      { CURSOR_KEYS: `-k:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key ID/,
    ],
    ['an empty key', { CURSOR_KEYS: 'k1:', CURSOR_ACTIVE_KEY_ID: 'k1' }, /entry 1 key must be/],
    [
      'a padded key',
      { CURSOR_KEYS: `k1:${keyA}=`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'standard base64 characters',
      { CURSOR_KEYS: `k1:${'+'.repeat(43)}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a non-canonical encoding',
      { CURSOR_KEYS: `k1:${keyA.slice(0, 42)}B`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a 31-byte key',
      { CURSOR_KEYS: `k1:${randomBytes(31).toString('base64url')}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a 33-byte key',
      { CURSOR_KEYS: `k1:${randomBytes(33).toString('base64url')}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 1 key must be/,
    ],
    [
      'a duplicate key ID',
      { CURSOR_KEYS: `k1:${keyA},k1:${keyB}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 repeats a key ID/,
    ],
    [
      'duplicate key material',
      { CURSOR_KEYS: `k1:${keyA},k2:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k1' },
      /entry 2 repeats key material/,
    ],
    [
      'more than four keys',
      {
        CURSOR_KEYS: `k1:${keyA},k2:${keyB},k3:${keyC},k4:${keyD},k5:${keyE}`,
        CURSOR_ACTIVE_KEY_ID: 'k1',
      },
      /CURSOR_KEYS: at most 4 keys/,
    ],
    [
      'an active ID that is not configured',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k2' },
      /CURSOR_ACTIVE_KEY_ID: must name one of the keys/,
    ],
    [
      'an invalid active ID',
      { CURSOR_KEYS: `k1:${keyA}`, CURSOR_ACTIVE_KEY_ID: 'k 1' },
      /CURSOR_ACTIVE_KEY_ID: must be 1 to 16/,
    ],
  ];

  it.each(rejected)(
    'rejects %s, naming the variable and rule and never the value',
    (_name, env, pattern) => {
      const message = messageOf(env);
      expect(message).toMatch(pattern);
      for (const secretText of [keyA, keyB, keyC, keyD, keyE])
        expect(message).not.toContain(secretText);
      for (const value of Object.values(env)) {
        if (value.length > 20) expect(message).not.toContain(value);
      }
    },
  );

  it('is checked together with the production rules in one ConfigError', () => {
    const message = messageOf({ NODE_ENV: 'production', CURSOR_KEYS: `k1:${keyA}` });
    expect(message).toMatch(/CURSOR_ACTIVE_KEY_ID: required/);
    expect(message).toMatch(/APP_ORIGINS: required in production/);
  });

  it('keeps key material out of inspection and serialisation of the config', () => {
    const c = loadConfig({
      ...base,
      CURSOR_KEYS: `k1:${keyA},k2:${keyB}`,
      CURSOR_ACTIVE_KEY_ID: 'k1',
    });
    for (const text of [keyA, keyB]) {
      expect(JSON.stringify(c)).not.toContain(text);
      expect(inspect(c, { depth: 8 })).not.toContain(text);
      expect(String(c.cursor?.keys.get('k1'))).toBe('[REDACTED]');
    }
  });
});
