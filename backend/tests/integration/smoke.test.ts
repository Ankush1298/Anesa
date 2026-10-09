import { afterAll, describe, expect, inject, it, beforeAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import * as argon2 from 'argon2';
import { EXTRA_A_USER_IDS, ORG_A, ORG_B, STAFF_A, USER_A, USER_B } from '../support/fixtures.js';

import type { Pool } from 'pg';

describe('End-to-End Authentication Smoke Test', () => {
  let app: ReturnType<typeof buildApp>;
  let pool: Pool;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const url = inject('dbRuntimeUrl') as string;
    const config = loadConfig({ DATABASE_URL: url });
    pool = createPool({ connectionString: url, ssl: false, max: 2 });
    const db = new Database(pool);
    app = buildApp({ config, db, logger: false });

    app.get(
      '/test-rls',
      {
        config: {
          public: false,
          permission: 'session.read',
          extractScope: (req) => ({ user_id: req.tenantContext!.userId }),
        },
      },
      async (req, reply) => {
        const users = await db.withTenant(req.tenantContext!, async (tx) => {
          return (await tx.query('SELECT id FROM app.users')).rows;
        });
        return reply.send({ users });
      },
    );

    await app.ready();

    const passwordHash = await argon2.hash('CorrectPassword123!', { type: argon2.argon2id });

    // Update STAFF_A and USER_B to have real passwords
    await adminQuery(
      `UPDATE platform.identities SET password_hash = $1 WHERE email IN ('staff.a@college-a.test', 'user.b@college-b.test')`,
      [passwordHash],
    );

    // Create Suspended and Disabled identities
    const suspendedId = '01939a00-0000-7000-8000-00000000dd01';
    const disabledId = '01939a00-0000-7000-8000-00000000dd02';
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'SUSPENDED')`,
      [suspendedId, 'suspended@org-a.test', passwordHash],
    );
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'DISABLED')`,
      [disabledId, 'disabled@org-a.test', passwordHash],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end().catch(() => undefined);
  });

  let sessionTokenA: string;

  it('1. Valid login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'staff.a@college-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });

    const body = res.json<{
      success: boolean;
      tenant_id: string;
      user_id: string;
      error?: { code: string };
    }>();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.tenant_id).toBe(ORG_A);
    const cookie = res.cookies.find((c) => c.name === 'session_token');
    expect(cookie).toBeDefined();
    sessionTokenA = cookie!.value;
  });

  it('2. Wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'staff.a@college-a.test',
        password: /* secret-scan:allow */ 'WrongPassword!',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('3. Unknown account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'unknown@test.com', password: /* secret-scan:allow */ 'WrongPassword!' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('4. Equivalency', async () => {
    const wrongPass = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'staff.a@college-a.test',
        password: /* secret-scan:allow */ 'WrongPassword!',
      },
    });
    const unknownAcct = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'unknown@test.com', password: /* secret-scan:allow */ 'WrongPassword!' },
    });
    const wrongPassBody = wrongPass.json<{ error: { requestId?: string } }>();
    const unknownAcctBody = unknownAcct.json<{ error: { requestId?: string } }>();
    delete wrongPassBody.error.requestId;
    delete unknownAcctBody.error.requestId;
    expect(wrongPass.statusCode).toBe(unknownAcct.statusCode);
    expect(wrongPassBody).toEqual(unknownAcctBody);
  });

  it('5. Suspended account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'suspended@org-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('6. Disabled account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'disabled@org-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('7 & 8. GET /auth/me', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: sessionTokenA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      tenant_id: string;
      user_id: string;
      error?: { code: string };
    }>();
    expect(body.user_id).toBe(STAFF_A);
    expect(body.tenant_id).toBe(ORG_A);
  });

  it('9. Tampered session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: sessionTokenA + 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('11. Logout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { session_token: sessionTokenA },
    });
    expect(res.statusCode).toBe(200);
  });

  it('12. Reuse logged out', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: sessionTokenA },
    });
    expect(res.statusCode).toBe(401);
  });

  it('13, 14, 15, 16. Cannot tamper tenant/user via request data', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'staff.a@college-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });
    const freshToken = login.cookies.find((c) => c.name === 'session_token')!.value;

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me?tenant_id=' + ORG_B + '&user_id=' + USER_B,
      cookies: { session_token: freshToken },
      headers: { 'x-tenant-id': ORG_B, 'x-user-id': USER_B },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      tenant_id: string;
      user_id: string;
      error?: { code: string };
    }>();
    expect(body.tenant_id).toBe(ORG_A);
    expect(body.user_id).toBe(STAFF_A);
  });

  it('17, 18, 19. TrustedContext / RLS integration', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'staff.a@college-a.test',
        password: /* secret-scan:allow */ 'CorrectPassword123!',
      },
    });
    const freshToken = login.cookies.find((c) => c.name === 'session_token')!.value;

    const res = await app.inject({
      method: 'GET',
      url: '/test-rls',
      cookies: { session_token: freshToken },
    });
    expect(res.statusCode).toBe(200);
    const users = res.json<{ users: { id: string }[] }>().users;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(
        [USER_A, STAFF_A, '01939a00-0000-7000-8000-00000000aa02', ...EXTRA_A_USER_IDS].includes(
          u.id,
        ),
      ).toBe(true);
    }
  });
});
