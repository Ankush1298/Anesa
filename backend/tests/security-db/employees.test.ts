import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CTX,
  ORG_A,
  ORG_B,
  ORG_C,
  STAFF_B,
  STAFF_C,
  FACULTY_A,
  TEMP_A,
} from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';

// employees (0015): tenant isolation, STUDENT refusal, least privilege, tenant-scoped FK and check constraints,
// proven against the real database. Runtime statements run in rolled-back transactions; the two seed rows are
// committed by the superuser (this project has its own database) and removed afterwards.
const E_A = '01939a00-0000-7000-8000-00000000ee01';
const E_B = '01939a00-0000-7000-8000-00000000ee02';
const E_NEW = '01939a00-0000-7000-8000-00000000ee03';

beforeAll(async () => {
  await adminQuery(
    `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date) VALUES
       ($1, $3, $5, 'SEC-A', 'FACULTY', '2024-01-01'),
       ($2, $4, $6, 'SEC-B', 'STAFF',   '2024-01-01')`,
    [E_A, E_B, ORG_A, ORG_B, FACULTY_A, STAFF_B],
  );
});
afterAll(async () => {
  await adminQuery('DELETE FROM app.employees');
});

const insert = (org: string, user: string, over: Record<string, string> = {}): string => {
  const v = {
    code: 'SEC-N',
    type: 'STAFF',
    status: 'ACTIVE',
    joining: '2024-01-01',
    leaving: 'NULL',
    ...over,
  };
  const leaving = v.leaving === 'NULL' ? 'NULL' : `'${v.leaving}'`;
  return `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date, leaving_date, status)
          VALUES ('${E_NEW}', '${org}', '${user}', '${v.code}', '${v.type}', '${v.joining}', ${leaving}, '${v.status}')`;
};

describe('employees: tenant isolation and actor kind', () => {
  it('staff see only their own tenant rows', async () => {
    const a = await runAs(CTX.staffA, 'SELECT id FROM app.employees');
    expect(a.rows.map((r) => r['id'])).toEqual([E_A]);
    const b = await runAs(CTX.staffB, 'SELECT id FROM app.employees');
    expect(b.rows.map((r) => r['id'])).toEqual([E_B]);
  });

  it('no tenant context ⇒ no rows (fail closed)', async () => {
    expect((await runAs({}, 'SELECT id FROM app.employees')).rows).toEqual([]);
  });

  it('a STUDENT session can neither read nor write employees (database-enforced)', async () => {
    expect((await runAs(CTX.studentA, 'SELECT id FROM app.employees')).rows).toEqual([]);
    const ins = await runAs(CTX.studentA, insert(ORG_A, TEMP_A));
    expect(ins.error?.code).toBe('42501');
    const upd = await runAs(CTX.studentA, "UPDATE app.employees SET status = 'ON_LEAVE'");
    expect(upd.rowCount).toBe(0);
  });

  it("staff cannot insert a row into another tenant, nor point at another tenant's user", async () => {
    expect((await runAs(CTX.staffA, insert(ORG_B, STAFF_B))).error?.code).toBe('42501'); // RLS WITH CHECK
    const fk = await runAs(CTX.staffA, insert(ORG_A, STAFF_B)); // user of tenant B under tenant A
    expect(fk.error?.code).toBe('23503'); // composite FK (organization_id, user_id)
  });

  it("staff cannot update another tenant's row (0 rows affected)", async () => {
    const r = await runAs(
      CTX.staffA,
      `UPDATE app.employees SET status = 'ON_LEAVE' WHERE id = '${E_B}'`,
    );
    expect(r.rowCount).toBe(0);
  });
});

describe('employees: least privilege', () => {
  it('no DELETE / TRUNCATE for the runtime role', async () => {
    for (const priv of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const [r] = await adminQuery<{ ok: boolean }>(
        'SELECT has_table_privilege($1, $2, $3) AS ok',
        ['app_runtime', 'app.employees', priv],
      );
      expect(r?.ok, priv).toBe(false);
    }
    expect((await runAs(CTX.staffA, 'DELETE FROM app.employees')).error?.code).toBe('42501');
  });

  it('UPDATE is limited to the four employment facts', async () => {
    const cols = await adminQuery<{ column_name: string; ok: boolean }>(
      `SELECT column_name::text, has_column_privilege('app_runtime', 'app.employees', column_name, 'UPDATE') AS ok
         FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'employees' ORDER BY ordinal_position`,
    );
    expect(cols.filter((c) => c.ok).map((c) => c.column_name)).toEqual([
      'employee_type',
      'joining_date',
      'leaving_date',
      'status',
    ]);
    for (const col of ['id', 'organization_id', 'user_id', 'employee_code', 'version']) {
      const r = await runAs(CTX.staffA, `UPDATE app.employees SET ${col} = ${col}`);
      expect(r.error?.code, col).toBe('42501');
    }
  });

  it('the touch and immutable-keys triggers bump the version and protect the keys', async () => {
    const r = await runStepsAs(CTX.staffA, [
      ["UPDATE app.employees SET status = 'ON_LEAVE' WHERE id = $1", [E_A]],
      ['SELECT version FROM app.employees WHERE id = $1', [E_A]],
    ]);
    expect(r.rows[0]).toEqual({ version: 2 });
  });
});

describe('employees: integrity constraints', () => {
  it.each([
    ['unknown type', { type: 'DEAN' }],
    ['unknown status', { status: 'FIRED' }],
    ['leaving before joining', { status: 'SEPARATED', leaving: '2023-12-31' }],
    ['empty code', { code: '' }],
    ['code of 51 characters', { code: 'x'.repeat(51) }],
  ])('rejects %s (23514)', async (_n, over) => {
    expect((await runAs(CTX.staffA, insert(ORG_A, TEMP_A, over))).error?.code).toBe('23514');
  });

  // 01 §3.4: leaving_date is optional and no status coupling is specified, so neither combination is a constraint
  // violation. Only date ordering (08 §4 "Dates ordered") is enforced.
  it('does not couple status and leaving_date: SEPARATED without a date and ACTIVE with a date are both accepted', async () => {
    const sepNoDate = await runAs(CTX.staffA, insert(ORG_A, TEMP_A, { status: 'SEPARATED' }));
    expect(sepNoDate.error).toBeUndefined();
    const activeWithDate = await runAs(
      CTX.staffA,
      insert(ORG_A, TEMP_A, { leaving: '2025-01-01' }),
    );
    expect(activeWithDate.error).toBeUndefined();
    const sepWithDate = await runAs(
      CTX.staffA,
      insert(ORG_A, TEMP_A, { status: 'SEPARATED', leaving: '2025-01-01' }),
    );
    expect(sepWithDate.error).toBeUndefined();
  });

  it('allows leaving on the joining day and still rejects a day earlier', async () => {
    const same = await runAs(CTX.staffA, insert(ORG_A, TEMP_A, { leaving: '2024-01-01' }));
    expect(same.error).toBeUndefined();
    const before = await runAs(CTX.staffA, insert(ORG_A, TEMP_A, { leaving: '2023-12-31' }));
    expect(before.error?.code).toBe('23514');
  });

  it('the separation constraint no longer exists (only the date-order check remains)', async () => {
    const rows = await adminQuery<{ conname: string }>(
      `SELECT conname::text FROM pg_constraint
        WHERE conrelid = 'app.employees'::regclass AND contype = 'c' ORDER BY conname`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).toContain('employees_dates_ck');
    expect(names).not.toContain('employees_separation_ck');
  });

  it('enforces unique code per tenant and one record per user (23505), but the same code is free in another tenant', async () => {
    expect((await runAs(CTX.staffA, insert(ORG_A, TEMP_A, { code: 'SEC-A' }))).error?.code).toBe(
      '23505',
    );
    expect((await runAs(CTX.staffA, insert(ORG_A, FACULTY_A, { code: 'SEC-Z' }))).error?.code).toBe(
      '23505',
    );
    // SEC-A is taken in tenant A; tenant C may use it.
    const other = await runAs(CTX.staffC, insert(ORG_C, STAFF_C, { code: 'SEC-A' }));
    expect(other.error).toBeUndefined();
  });
});
