import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 2 });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db: new Database(pool),
  logger: false,
});
const hash = (c: string) => c;

beforeAll(async () => {
  await app.ready();
  await adminQuery('UPDATE platform.identities SET password_hash = $1 WHERE email = $2', [
    await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    'campus.admin.a@college-a.test',
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

const parse = (setCookie: string): { name: string; value: string; attrs: string[] } => {
  const [pair, ...attrs] = setCookie.split(';').map((x) => x.trim());
  const i = pair!.indexOf('=');
  return { name: pair!.slice(0, i), value: pair!.slice(i + 1), attrs };
};

describe('session cookie', () => {
  it('login sets an opaque, unsigned HttpOnly + Secure + SameSite=Lax + Path=/ cookie with no Domain', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'campus.admin.a@college-a.test', password: PASSWORD },
    });
    const raw = [r.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(raw).toHaveLength(1);
    const c = parse(raw[0]!);
    expect(c.name).toBe('session_token');
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url; not signed (no ".sig")
    const attrs = c.attrs.map((a) => a.toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/']));
    expect(attrs.some((a) => a.startsWith('domain'))).toBe(false);
    expect(attrs.some((a) => a.startsWith('max-age=43200'))).toBe(true);
    // the client-visible JSON never contains the session token
    expect(r.body).not.toContain(c.value);
  });

  it('logout clears the exact cookie (same name, path, Secure, HttpOnly, SameSite), revokes the session, and the old cookie stops working', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'campus.admin.a@college-a.test', password: PASSWORD },
    });
    const set = parse([login.headers['set-cookie']].flat()[0]!);
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { session_token: set.value },
    });
    expect(out.statusCode).toBe(200);
    const cleared = parse([out.headers['set-cookie']].flat()[0]!);
    expect(cleared.name).toBe('session_token');
    expect(cleared.value).toBe('');
    const a = cleared.attrs.map((x) => x.toLowerCase());
    expect(a).toEqual(
      expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/', 'max-age=0']),
    );
    expect(a.some((x) => x.startsWith('expires=thu, 01 jan 1970'))).toBe(true);
    // every attribute that identifies the cookie matches how it was set
    for (const k of ['httponly', 'secure', 'samesite=lax', 'path=/']) {
      expect(set.attrs.map((x) => x.toLowerCase())).toContain(k);
    }
    // server side: the session row is revoked and the old token is dead
    const rows = await adminQuery<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM platform.auth_sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [Buffer.from(hash(set.value))],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: set.value },
    });
    expect(me.statusCode).toBe(401);
  });

  it('logout without a session is harmless and still clears the cookie', async () => {
    const out = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(out.statusCode).toBe(200);
    expect(parse([out.headers['set-cookie']].flat()[0]!).value).toBe('');
  });

  it('an expired session is rejected', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'campus.admin.a@college-a.test', password: PASSWORD },
    });
    const tok = parse([login.headers['set-cookie']].flat()[0]!).value;
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', cookies: { session_token: tok } }))
        .statusCode,
    ).toBe(200);
    await adminQuery(
      `UPDATE platform.auth_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [Buffer.from(tok)],
    );
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', cookies: { session_token: tok } }))
        .statusCode,
    ).toBe(401);
  });
});
