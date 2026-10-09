import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import { USER_A } from '../support/fixtures.js';

describe('actor kind is derived server-side from the student mapping', () => {
  const url = inject('dbRuntimeUrl');
  const pool = createPool({ connectionString: url, ssl: false, max: 2 });
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: url }),
    db: new Database(pool),
    logger: false,
  });

  beforeAll(async () => {
    await app.ready();
    const hash = await argon2.hash('CorrectPassword123!', { type: argon2.argon2id });
    await adminQuery(`UPDATE platform.identities SET password_hash = $1 WHERE id = $2`, [
      hash,
      USER_A,
    ]);
  });
  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => undefined);
  });

  it('a student login yields actor_kind STUDENT (so the student RLS backstop applies)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'user.a@college-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });
    expect(login.statusCode).toBe(200);
    const token = login.cookies.find((c) => c.name === 'session_token')!.value;
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ actor_kind: string }>().actor_kind).toBe('STUDENT');
  });
});
