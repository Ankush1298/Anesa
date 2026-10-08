import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, Secret } from '../../src/config/env.js';

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
      loadConfig({ ...base, NODE_ENV: 'production', DATABASE_SSL: 'require' }),
    ).not.toThrow();
  });

  it('refuses wildcard bind in production unless behind a trusted proxy', () => {
    const prod = { ...base, NODE_ENV: 'production', DATABASE_SSL: 'require', HOST: '0.0.0.0' };
    expect(() => loadConfig(prod)).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'true' })).not.toThrow();
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
