import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import { TEMP_A } from '../support/fixtures.js';

const GOOD = /* secret-scan:allow */ 'CorrectPassword123!';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 2 });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db: new Database(pool),
  logger: false,
});
const login = (password: string, ip = '10.9.9.9') =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'temp.a@college-a.test', password },
    remoteAddress: ip,
  });

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(GOOD, { type: argon2.argon2id });
  await adminQuery('UPDATE platform.identities SET password_hash = $1 WHERE id = $2', [
    hash,
    TEMP_A,
  ]);
});
afterAll(async () => {
  await adminQuery(
    'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [TEMP_A],
  );
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('failed-login lockout actually persists', () => {
  it('10 failures (from different IPs) lock the account: even the correct password is then refused with the same error', async () => {
    expect((await login(GOOD)).statusCode).toBe(200);
    for (let i = 0; i < 10; i++)
      expect((await login('wrong-password', `10.9.0.${i + 1}`)).statusCode).toBe(401);
    const [row] = await adminQuery<{ failed_login_count: number; locked_until: Date | null }>(
      'SELECT failed_login_count, locked_until FROM platform.identities WHERE id = $1',
      [TEMP_A],
    );
    expect(row!.failed_login_count).toBe(10);
    expect(row!.locked_until!.getTime()).toBeGreaterThan(Date.now());
    const locked = await login(GOOD);
    const wrong = await login('wrong-password');
    expect(locked.statusCode).toBe(401);
    const strip = (r: typeof locked) => {
      const b = r.json<{ error: { requestId?: string } }>();
      delete b.error.requestId;
      return b;
    };
    expect(strip(locked)).toEqual(strip(wrong)); // a locked account is indistinguishable
  });
});
