import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';
import { CTX, FACULTY_A, ORG_A, ORG_B, STAFF_A, STAFF_B } from '../support/fixtures.js';

// app.idempotency_keys (0018): tenant scope, principal scope, least privilege, constraints. Rows committed here use the
// key prefix below (they are deleted afterwards); every other statement runs in a transaction that is rolled back.
// Only app.idempotency_keys is written: the shared snapshot (organizations, users, students, guardians) stays pristine.

const P = 'secdb-idem-';
const KEY_STAFF_A = `${P}staff-a-0000000001`;
const HASH = 'a'.repeat(64);
const insertSql = (user: string, key: string): string =>
  `INSERT INTO app.idempotency_keys (organization_id, user_id, key, operation, request_hash, expires_at)
   VALUES ($1, '${user}', '${key}', 'POST /x', '${HASH}', now() + interval '1 hour')`;

beforeAll(async () => {
  await adminQuery(
    `INSERT INTO app.idempotency_keys (organization_id, user_id, key, operation, request_hash, expires_at)
     VALUES ($1, $2, $3, 'POST /x', $4, now() + interval '1 hour')`,
    [ORG_A, STAFF_A, KEY_STAFF_A, HASH],
  );
});
afterAll(async () => {
  await adminQuery('DELETE FROM app.idempotency_keys WHERE key LIKE $1', [`${P}%`]);
});

describe('idempotency_keys: row security (tenant AND principal)', () => {
  it('the owner principal sees its own record', async () => {
    const r = await runAs(CTX.staffA, 'SELECT key FROM app.idempotency_keys WHERE key LIKE $1', [
      `${P}%`,
    ]);
    expect(r.rows).toEqual([{ key: KEY_STAFF_A }]);
  });

  it('another user of the SAME tenant cannot see it (principal scope)', async () => {
    const r = await runAs(CTX.facultyA, 'SELECT key FROM app.idempotency_keys WHERE key LIKE $1', [
      `${P}%`,
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([]);
  });

  it('an admin of ANOTHER tenant cannot see it (tenant scope)', async () => {
    const r = await runAs(CTX.staffB, 'SELECT key FROM app.idempotency_keys WHERE key LIKE $1', [
      `${P}%`,
    ]);
    expect(r.rows).toEqual([]);
  });

  it('no context at all sees nothing (fail closed)', async () => {
    const r = await runAs({}, 'SELECT count(*)::int AS n FROM app.idempotency_keys');
    expect(r.error ? [{ n: 0 }] : r.rows).toEqual([{ n: 0 }]); // either refused outright or zero rows
  });

  it('a session cannot write a record for another user, nor for another tenant', async () => {
    const otherUser = await runAs(CTX.staffA, insertSql(FACULTY_A, `${P}x-other-user-0001`), [
      ORG_A,
    ]);
    expect(otherUser.error?.code).toBe('42501'); // RESTRICTIVE principal policy
    expect(otherUser.error?.message).toMatch(/row-level security/);

    const otherTenant = await runAs(CTX.staffA, insertSql(STAFF_B, `${P}x-other-org-00001`), [
      ORG_B,
    ]);
    expect(otherTenant.error?.code).toBe('42501');
    expect(otherTenant.error?.message).toMatch(/row-level security/);
  });

  it('a session can write its own record, and it is readable inside the same transaction', async () => {
    const r = await runStepsAs(CTX.staffA, [
      [insertSql(STAFF_A, `${P}own-insert-0000001`), [ORG_A]],
      ['SELECT key FROM app.idempotency_keys WHERE key = $1', [`${P}own-insert-0000001`]],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([{ key: `${P}own-insert-0000001` }]);
  });
});

describe('idempotency_keys: least privilege', () => {
  it('the runtime role has SELECT and INSERT, UPDATE on exactly the protocol columns, and no DELETE/TRUNCATE', async () => {
    const upd = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'app' AND table_name = 'idempotency_keys' AND grantee = 'app_runtime'
          AND privilege_type = 'UPDATE' ORDER BY 1`,
    );
    expect(upd.map((c) => c.column_name)).toEqual([
      'created_at',
      'expires_at',
      'operation',
      'request_hash',
      'response_body',
      'response_status',
    ]);
    for (const priv of ['SELECT', 'INSERT']) {
      const [r] = await adminQuery<{ ok: boolean }>('SELECT has_table_privilege($1,$2,$3) AS ok', [
        'app_runtime',
        'app.idempotency_keys',
        priv,
      ]);
      expect(r?.ok, priv).toBe(true);
    }
    for (const priv of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const [r] = await adminQuery<{ ok: boolean }>('SELECT has_table_privilege($1,$2,$3) AS ok', [
        'app_runtime',
        'app.idempotency_keys',
        priv,
      ]);
      expect(r?.ok, priv).toBe(false);
    }
  });

  it('identity columns cannot be updated and rows cannot be deleted (42501), even for the owner principal', async () => {
    for (const sql of [
      `UPDATE app.idempotency_keys SET key = '${P}renamed-000000001' WHERE key = $1`,
      `UPDATE app.idempotency_keys SET user_id = '${FACULTY_A}' WHERE key = $1`,
      `UPDATE app.idempotency_keys SET organization_id = '${ORG_B}' WHERE key = $1`,
      'DELETE FROM app.idempotency_keys WHERE key = $1',
    ]) {
      const r = await runAs(CTX.staffA, sql, [KEY_STAFF_A]);
      expect(r.error?.code, sql).toBe('42501');
    }
    const still = await adminQuery('SELECT 1 FROM app.idempotency_keys WHERE key = $1', [
      KEY_STAFF_A,
    ]);
    expect(still).toHaveLength(1);
  });

  it('the protocol columns can be updated by the owner principal only (another user matches zero rows)', async () => {
    const own = await runStepsAs(CTX.staffA, [
      [
        `UPDATE app.idempotency_keys SET response_status = 201, response_body = '{"ok":true}'::jsonb
          WHERE key = $1 RETURNING response_status`,
        [KEY_STAFF_A],
      ],
    ]);
    expect(own.error).toBeUndefined();
    expect(own.rows).toEqual([{ response_status: 201 }]);

    const other = await runAs(
      CTX.facultyA,
      `UPDATE app.idempotency_keys SET response_status = 200, response_body = '{}'::jsonb WHERE key = $1`,
      [KEY_STAFF_A],
    );
    expect(other.error).toBeUndefined();
    expect(other.rowCount).toBe(0);
  });
});

describe('idempotency_keys: constraints', () => {
  const attempt = (columns: string, values: string): Promise<{ code?: string; message?: string }> =>
    adminQuery(
      `INSERT INTO app.idempotency_keys (organization_id, user_id, ${columns}) VALUES ($1, $2, ${values})`,
      [ORG_A, STAFF_A],
    ).then(
      async () => {
        await adminQuery('DELETE FROM app.idempotency_keys WHERE key LIKE $1', [`${P}c-%`]);
        return {};
      },
      (e: { code?: string; message?: string }) => e,
    );
  const base = `'${P}c-0000000000001', 'POST /x', '${HASH}', now() + interval '1 hour'`;
  const cols = 'key, operation, request_hash, expires_at';

  it('rejects malformed keys, hashes and operations (23514)', async () => {
    for (const bad of [
      `'short', 'POST /x', '${HASH}', now() + interval '1 hour'`, // key too short
      `'${P}c-has space 0001', 'POST /x', '${HASH}', now() + interval '1 hour'`, // key charset
      `'${P}c-0000000000001', '', '${HASH}', now() + interval '1 hour'`, // empty operation
      `'${P}c-0000000000001', 'POST /x', '${'A'.repeat(64)}', now() + interval '1 hour'`, // uppercase hex
      `'${P}c-0000000000001', 'POST /x', '${'a'.repeat(63)}', now() + interval '1 hour'`, // 63 chars
    ]) {
      expect((await attempt(cols, bad)).code, bad).toBe('23514');
    }
  });

  it('accepts a well-formed record (the same statements, valid)', async () => {
    expect(await attempt(cols, base)).toEqual({});
  });

  it('requires expires_at after created_at, and response status/body to be set together or not at all', async () => {
    expect(
      (
        await attempt(
          'key, operation, request_hash, expires_at',
          `'${P}c-0000000000002', 'o', '${HASH}', now() - interval '1 hour'`,
        )
      ).code,
    ).toBe('23514');
    expect((await attempt(`${cols}, response_status`, `${base}, 201`)).code).toBe('23514');
    expect((await attempt(`${cols}, response_body`, `${base}, '{}'::jsonb`)).code).toBe('23514');
    expect(
      (await attempt(`${cols}, response_status, response_body`, `${base}, 404, '{}'::jsonb`)).code,
    ).toBe('23514');
    expect(
      await attempt(`${cols}, response_status, response_body`, `${base}, 201, '{}'::jsonb`),
    ).toEqual({});
  });

  it('the principal must be a user of the SAME tenant (composite FK) and the key is unique per principal', async () => {
    const fk = await adminQuery(
      `INSERT INTO app.idempotency_keys (organization_id, user_id, key, operation, request_hash, expires_at)
       VALUES ($1, $2, '${P}c-0000000000003', 'o', '${HASH}', now() + interval '1 hour')`,
      [ORG_A, STAFF_B],
    ).then(
      () => ({}),
      (e: { code?: string }) => e,
    );
    expect(fk).toMatchObject({ code: '23503' });

    const dup = await adminQuery(
      `INSERT INTO app.idempotency_keys (organization_id, user_id, key, operation, request_hash, expires_at)
       VALUES ($1, $2, $3, 'o', '${HASH}', now() + interval '1 hour')`,
      [ORG_A, STAFF_A, KEY_STAFF_A],
    ).then(
      () => ({}),
      (e: { code?: string }) => e,
    );
    expect(dup).toMatchObject({ code: '23505' });
  });
});
