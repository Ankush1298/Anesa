import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';

// A state-changing route that exists ONLY in this test file (no production route is needed to prove
// that the hook protects every authenticated mutation). It is registered on a test-built app.
const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP = 'https://app.campus.test';
const EVIL = 'https://evil.test';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const mk = (origins: string) =>
  buildApp({
    config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: origins }),
    db,
    logger: false,
  });
const app = mk(APP);
const devApp = mk(''); // development: same-host origin check only

for (const a of [app, devApp]) {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    a.route({
      method,
      url: '/t/mutate',
      config: { permission: 'session.revoke' },
      handler: () => ({ mutated: method }),
    });
  }
  a.get('/t/read', { config: { permission: 'session.read' } }, () => ({ read: true }));
}

let token = '';
let csrf = '';
let otherCsrf = '';
const login = async (a: typeof app, email: string) => {
  const r = await a.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
};
const mutate = (
  o: {
    cookie?: string;
    csrf?: string;
    origin?: string;
    site?: string;
    method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  } = {},
  a = app,
) =>
  a.inject({
    method: o.method ?? 'POST',
    url: '/t/mutate',
    cookies: o.cookie === undefined ? {} : { session_token: o.cookie },
    headers: {
      ...(o.csrf !== undefined ? { 'x-csrf-token': o.csrf } : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.site !== undefined ? { 'sec-fetch-site': o.site } : {}),
    },
  });
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code;

beforeAll(async () => {
  await Promise.all([app.ready(), devApp.ready()]);
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await adminQuery(
    `UPDATE platform.identities SET password_hash = $1 WHERE email IN ('staff.a@college-a.test','faculty.a@college-a.test')`,
    [hash],
  );
  ({ cookie: token, csrf } = await login(app, 'staff.a@college-a.test'));
  otherCsrf = (await login(app, 'faculty.a@college-a.test')).csrf;
});
afterAll(async () => {
  await Promise.all([app.close(), devApp.close()]);
  await pool.end().catch(() => undefined);
});

describe('CSRF: authenticated state-changing requests', () => {
  it('accepts a valid session + token + allowed origin, for every unsafe method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await mutate({ cookie: token, csrf, origin: APP, method });
      expect(r.statusCode, method).toBe(200);
      expect(r.json()).toEqual({ mutated: method });
    }
  });

  it('accepts a non-browser client (no Origin header) that presents the token', async () => {
    expect((await mutate({ cookie: token, csrf })).statusCode).toBe(200);
  });

  it('rejects a missing token, on every unsafe method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await mutate({ cookie: token, origin: APP, method });
      expect(r.statusCode, method).toBe(403);
      expect(code(r)).toBe('CSRF_REJECTED');
    }
  });

  it('rejects empty, malformed, truncated, case-changed and foreign tokens', async () => {
    const bad = [
      '',
      'x',
      csrf.slice(0, -1),
      csrf + 'a',
      csrf.toUpperCase(),
      token,
      otherCsrf,
      'A'.repeat(csrf.length),
    ];
    for (const t of bad) {
      const r = await mutate({ cookie: token, csrf: t, origin: APP });
      expect(r.statusCode, t.slice(0, 8)).toBe(403);
      expect(code(r)).toBe('CSRF_REJECTED');
    }
  });

  it("rejects another user's valid token (the token is bound to the session)", async () => {
    expect((await mutate({ cookie: token, csrf: otherCsrf, origin: APP })).statusCode).toBe(403);
  });

  it('rejects a cross-origin request even with a valid token, and a "null" origin', async () => {
    for (const origin of [
      EVIL,
      'null',
      'https://app.campus.test.evil.test',
      'http://app.campus.test',
      `${APP}:444`,
      'not a url',
    ]) {
      const r = await mutate({ cookie: token, csrf, origin });
      expect(r.statusCode, origin).toBe(403);
      expect(code(r)).toBe('CSRF_REJECTED');
    }
  });

  it('rejects Sec-Fetch-Site cross-site / same-site when no Origin is sent, allows same-origin', async () => {
    expect((await mutate({ cookie: token, csrf, site: 'cross-site' })).statusCode).toBe(403);
    expect((await mutate({ cookie: token, csrf, site: 'same-site' })).statusCode).toBe(403);
    expect((await mutate({ cookie: token, csrf, site: 'same-origin' })).statusCode).toBe(200);
  });

  it('an unauthenticated mutation is 401 (authentication first), a forged cookie is 401', async () => {
    expect((await mutate({ csrf, origin: APP })).statusCode).toBe(401);
    expect((await mutate({ cookie: token + 'x', csrf, origin: APP })).statusCode).toBe(401);
  });

  it('read-only routes stay usable without any CSRF proof, even cross-origin', async () => {
    for (const headers of [{}, { origin: EVIL }]) {
      const r = await app.inject({
        method: 'GET',
        url: '/t/read',
        cookies: { session_token: token },
        headers,
      });
      expect(r.statusCode).toBe(200);
    }
    expect(
      (
        await app.inject({ method: 'GET', url: '/t/read', cookies: { session_token: token } })
      ).json(),
    ).toEqual({ read: true });
  });

  it('the token is issued by login and /auth/me, is per-session, and is not the session token', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: token },
    });
    expect(me.json<{ csrf_token: string }>().csrf_token).toBe(csrf);
    expect(csrf).not.toBe(otherCsrf);
    expect(csrf).not.toBe(token);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('CSRF: public state-changing routes (login / logout) are origin-checked', () => {
  it('cross-origin login and logout are rejected; same-origin and no-Origin still work', async () => {
    const creds = { email: 'staff.a@college-a.test', password: PASSWORD };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: creds,
          headers: { origin: EVIL },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: creds,
          headers: { origin: APP },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/auth/login', payload: creds })).statusCode,
    ).toBe(200);
  });

  it('a cross-site forced logout is rejected and leaves the session alive', async () => {
    const s = await login(app, 'staff.a@college-a.test');
    const forced = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { session_token: s.cookie },
      headers: { origin: EVIL },
    });
    expect(forced.statusCode).toBe(403);
    const still = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: s.cookie },
    });
    expect(still.statusCode).toBe(200);
    const real = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { session_token: s.cookie },
      headers: { origin: APP },
    });
    expect(real.statusCode).toBe(200);
  });
});

describe('CSRF: logout invalidates the token with the session', () => {
  it('after logout the same cookie + token pair is rejected (401), not accepted', async () => {
    const s = await login(app, 'staff.a@college-a.test');
    expect((await mutate({ cookie: s.cookie, csrf: s.csrf, origin: APP })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { session_token: s.cookie } });
    expect((await mutate({ cookie: s.cookie, csrf: s.csrf, origin: APP })).statusCode).toBe(401);
  });
});

describe('CSRF: development mode (no APP_ORIGINS) falls back to same-host only', () => {
  it("allows the request's own origin, rejects any other", async () => {
    const s = await login(devApp, 'staff.a@college-a.test');
    expect(
      (await mutate({ cookie: s.cookie, csrf: s.csrf, origin: 'http://localhost:80' }, devApp))
        .statusCode,
    ).toBe(200);
    expect(
      (await mutate({ cookie: s.cookie, csrf: s.csrf, origin: EVIL }, devApp)).statusCode,
    ).toBe(403);
    expect(
      (await mutate({ cookie: s.cookie, csrf: 'bad', origin: 'http://localhost:80' }, devApp))
        .statusCode,
    ).toBe(403);
  });
});
