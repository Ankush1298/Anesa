import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { LoginRateLimiter } from '../../src/modules/auth/login-limiter.js';
import { adminQuery } from '../support/db-harness.js';
import { LOCK_A as TEMP_A } from '../support/fixtures.js';

const GOOD = /* secret-scan:allow */ 'CorrectPassword123!';
const VICTIM = 'faculty.a@college-a.test';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 3 });
const db = new Database(pool);

let t = Date.now();
const limiter = new LoginRateLimiter({ now: () => t });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db,
  logger: false,
  loginLimiter: limiter,
});
const proxied = buildApp({
  config: loadConfig({ DATABASE_URL: url, TRUST_PROXY: 'true' }),
  db,
  logger: false,
  loginLimiter: new LoginRateLimiter(),
});

const login = (
  a: typeof app,
  email: string,
  password: string,
  ip: string,
  headers: Record<string, string> = {},
) =>
  a.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    remoteAddress: ip,
    headers,
  });
const shape = (r: { statusCode: number; json: () => { error: { requestId?: string } } }) => {
  const b = r.json();
  delete b.error.requestId;
  return { s: r.statusCode, b };
};

beforeAll(async () => {
  await Promise.all([app.ready(), proxied.ready()]);
  await adminQuery('UPDATE platform.identities SET password_hash = $1 WHERE email = $2', [
    await argon2.hash(GOOD, { type: argon2.argon2id }),
    VICTIM,
  ]);
});
afterAll(async () => {
  await adminQuery(
    'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE email = $1',
    [VICTIM],
  );
  await Promise.all([app.close(), proxied.close()]);
  await pool.end().catch(() => undefined);
});

describe('per-IP login rate limiting (HTTP)', () => {
  // isolate the per-IP limiter from the database lock that failures also feed
  beforeEach(async () => {
    await adminQuery(
      'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE email = $1',
      [VICTIM],
    );
  });

  it('5 failures from one IP for one account -> 429 + Retry-After, even for the correct password', async () => {
    for (let i = 0; i < 5; i++)
      expect((await login(app, VICTIM, 'bad', '10.1.0.1')).statusCode).toBe(401);
    const blocked = await login(app, VICTIM, GOOD, '10.1.0.1');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } });
    expect(blocked.cookies).toHaveLength(0);
  });

  it("the attacker cannot lock the victim out: the victim logs in from another IP while the attacker's IP is blocked", async () => {
    expect((await login(app, VICTIM, GOOD, '10.1.0.1')).statusCode).toBe(429);
    const ok = await login(app, VICTIM, GOOD, '10.1.0.2');
    expect(ok.statusCode).toBe(200);
  });

  it('the block expires and a legitimate login then succeeds', async () => {
    expect((await login(app, VICTIM, GOOD, '10.1.0.1')).statusCode).toBe(429);
    t += 15 * 60_000 + 1;
    expect((await login(app, VICTIM, GOOD, '10.1.0.1')).statusCode).toBe(200);
  });

  it('no account enumeration: blocked responses are identical for existing and nonexistent accounts', async () => {
    for (let i = 0; i < 5; i++) {
      await login(app, 'ghost@college-a.test', 'bad', '10.2.0.1');
      await login(app, VICTIM, 'bad', '10.2.0.2');
    }
    const ghost = await login(app, 'ghost@college-a.test', GOOD, '10.2.0.1');
    const real = await login(app, VICTIM, GOOD, '10.2.0.2');
    expect(ghost.statusCode).toBe(429);
    expect(shape(ghost)).toEqual(shape(real));
  });

  it('forwarded-IP headers are ignored unless TRUST_PROXY is configured', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login(app, VICTIM, 'bad', '10.3.0.1', {
        'x-forwarded-for': `203.0.113.${i}`,
      });
      expect(r.statusCode).toBe(401);
    }
    // rotating X-Forwarded-For does not buy a fresh budget
    expect(
      (await login(app, VICTIM, 'bad', '10.3.0.1', { 'x-forwarded-for': '198.51.100.77' }))
        .statusCode,
    ).toBe(429);
  });

  it('with TRUST_PROXY the forwarded client IP is the key (a proxy-validated header)', async () => {
    for (let i = 0; i < 5; i++) {
      await login(proxied, VICTIM, 'bad', '10.4.0.1', { 'x-forwarded-for': '203.0.113.50' });
    }
    expect(
      (await login(proxied, VICTIM, GOOD, '10.4.0.1', { 'x-forwarded-for': '203.0.113.50' }))
        .statusCode,
    ).toBe(429);
    expect(
      (await login(proxied, VICTIM, GOOD, '10.4.0.1', { 'x-forwarded-for': '203.0.113.51' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('per-account lock (database) cannot be abused to lock a victim out indefinitely', () => {
  const email = 'lock.a@college-a.test';
  const row = () =>
    adminQuery<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM platform.identities WHERE id = $1',
      [TEMP_A],
    );
  beforeAll(async () => {
    await adminQuery(
      'UPDATE platform.identities SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE id = $2',
      [await argon2.hash(GOOD, { type: argon2.argon2id }), TEMP_A],
    );
  });
  afterAll(async () => {
    await adminQuery(
      'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [TEMP_A],
    );
  });

  it('10 failures (from different IPs) lock for 15 minutes; failures during the lock do not extend it; the counter restarts after expiry', async () => {
    const fresh = buildApp({
      config: loadConfig({ DATABASE_URL: url }),
      db,
      logger: false,
      loginLimiter: new LoginRateLimiter(),
    });
    await fresh.ready();
    try {
      for (let i = 0; i < 9; i++) await login(fresh, email, 'bad', `10.5.0.${i + 1}`);
      expect((await row())[0]!.locked_until).toBeNull();
      await login(fresh, email, 'bad', '10.5.0.10');
      const locked = (await row())[0]!;
      expect(locked.failed_login_count).toBe(10);
      const until = locked.locked_until!.getTime();
      expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);

      // correct password during the lock: refused with the standard invalid-credentials answer
      const during = await login(fresh, email, GOOD, '10.5.0.50');
      expect(during.statusCode).toBe(401);
      expect(during.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
      // more failures while locked do NOT extend the lock
      for (let i = 0; i < 3; i++) await login(fresh, email, 'bad', `10.5.1.${i + 1}`);
      expect((await row())[0]!.locked_until!.getTime()).toBe(until);

      // lock expires -> a single new failure restarts the count at 1 (no instant re-lock) and login works again
      await adminQuery(
        `UPDATE platform.identities SET locked_until = now() - interval '1 second' WHERE id = $1`,
        [TEMP_A],
      );
      await login(fresh, email, 'bad', '10.5.2.1');
      expect(await row()).toEqual([{ failed_login_count: 1, locked_until: null }]);
      expect((await login(fresh, email, GOOD, '10.5.2.2')).statusCode).toBe(200);
      expect((await row())[0]!.failed_login_count).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
