import { describe, expect, it } from 'vitest';
import { CAMPUS_1, CAMPUS_B1, CTX, DEPT_1, ORG_A, ORG_B } from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';

// campuses / departments (0008): least privilege, staff-only writes and tenant isolation, proven against the
// real database. Every statement runs in a transaction that is rolled back.
const NEW_CAMPUS = '01939a00-0000-7000-8000-00000000ca09';
const NEW_DEPT = '01939a00-0000-7000-8000-00000000de09';
const insertCampus = (org: string): string =>
  `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ('${NEW_CAMPUS}', '${org}', 'New', 'N1', 'Asia/Kolkata')`;
const insertDept = (org: string, campus: string): string =>
  `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ('${NEW_DEPT}', '${org}', '${campus}', 'New', 'N1')`;

describe('campuses and departments: runtime privileges', () => {
  it.each(['campuses', 'departments'])(
    '%s: the runtime role cannot DELETE or TRUNCATE',
    async (t) => {
      for (const priv of ['DELETE', 'TRUNCATE']) {
        const [r] = await adminQuery<{ ok: boolean }>(
          'SELECT has_table_privilege($1, $2, $3) AS ok',
          ['app_runtime', `app.${t}`, priv],
        );
        expect(r?.ok, `${priv} on ${t}`).toBe(false);
      }
      const del = await runAs(CTX.staffA, `DELETE FROM app.${t}`);
      expect(del.error?.code).toBe('42501');
    },
  );

  it('departments: UPDATE is limited to name, status and deleted_at (no table-wide UPDATE)', async () => {
    const [t] = await adminQuery<{ ok: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'app.departments', 'UPDATE') AS ok`,
    );
    expect(t?.ok).toBe(false);
    const cols = await adminQuery<{ column_name: string; ok: boolean }>(
      `SELECT column_name::text, has_column_privilege('app_runtime', 'app.departments', column_name, 'UPDATE') AS ok
         FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'departments' ORDER BY ordinal_position`,
    );
    expect(cols.filter((c) => c.ok).map((c) => c.column_name)).toEqual([
      'name',
      'status',
      'deleted_at',
    ]);
    for (const col of [
      'id',
      'organization_id',
      'campus_id',
      'parent_department_id',
      'code',
      'kind',
    ]) {
      const r = await runAs(CTX.staffA, `UPDATE app.departments SET ${col} = ${col}`);
      expect(r.error?.code, col).toBe('42501');
    }
    const ok = await runAs(
      CTX.staffA,
      `UPDATE app.departments SET name = 'Renamed' WHERE id = '${DEPT_1}'`,
    );
    expect(ok.error).toBeUndefined();
    expect(ok.rowCount).toBe(1);
  });

  it('campuses: UPDATE is limited to name, address and status (no table-wide UPDATE)', async () => {
    const [t] = await adminQuery<{ ok: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'app.campuses', 'UPDATE') AS ok`,
    );
    expect(t?.ok).toBe(false);
    const cols = await adminQuery<{ column_name: string; ok: boolean }>(
      `SELECT column_name::text, has_column_privilege('app_runtime', 'app.campuses', column_name, 'UPDATE') AS ok
         FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'campuses' ORDER BY ordinal_position`,
    );
    expect(cols.filter((c) => c.ok).map((c) => c.column_name)).toEqual([
      'name',
      'address',
      'status',
    ]);
    // identity, business key and timezone are refused by the privilege layer itself (before any trigger)
    for (const col of ['id', 'organization_id', 'code', 'timezone']) {
      const r = await runAs(CTX.staffA, `UPDATE app.campuses SET ${col} = ${col}`);
      expect(r.error?.code, col).toBe('42501');
    }
  });

  it('campuses: staff can edit name, address and status; touch_row still advances version', async () => {
    const r = await runStepsAs(CTX.staffA, [
      [
        `UPDATE app.campuses SET name = 'Renamed', address = '{"city":"Pune"}', status = 'INACTIVE' WHERE id = '${CAMPUS_1}'`,
      ],
      [`SELECT name, status, version FROM app.campuses WHERE id = '${CAMPUS_1}'`],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual({ name: 'Renamed', status: 'INACTIVE', version: 2 });
  });

  it('campuses: the immutable-keys trigger is installed (second layer behind the column grants)', async () => {
    const [r] = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger WHERE tgrelid = 'app.campuses'::regclass AND tgname = 'campuses_immutable'`,
    );
    expect(r?.n).toBe('1');
  });
});

describe('campuses and departments: policies', () => {
  it.each(['campuses', 'departments'])(
    '%s: tenant policies for SELECT/INSERT/UPDATE, staff-only RESTRICTIVE INSERT/UPDATE, no DELETE policy',
    async (t) => {
      const pol = await adminQuery<{
        cmd: string;
        permissive: string;
        roles: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'app' AND tablename = $1`,
        [t],
      );
      const by = (permissive: string): string[] =>
        pol
          .filter((p) => p.permissive === permissive && p.roles === '{app_runtime}')
          .map((p) => p.cmd)
          .sort();
      expect(by('PERMISSIVE')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      expect(by('RESTRICTIVE')).toEqual(['INSERT', 'UPDATE']);
      expect(pol.every((p) => p.roles === '{app_runtime}')).toBe(true);
      for (const p of pol.filter((x) => x.permissive === 'RESTRICTIVE')) {
        expect(`${p.qual ?? ''}${p.with_check ?? ''}`, `${t} ${p.cmd}`).toContain(
          'current_actor_kind',
        );
      }
      for (const p of pol.filter((x) => x.permissive === 'PERMISSIVE')) {
        expect(`${p.qual ?? ''}${p.with_check ?? ''}`, `${t} ${p.cmd}`).toContain(
          'current_tenant_id',
        );
      }
    },
  );
});

describe('campuses and departments: behaviour under RLS', () => {
  it('tenant isolation: each tenant sees only its own campuses and departments', async () => {
    for (const [ctx, org] of [
      [CTX.staffA, ORG_A],
      [CTX.staffB, ORG_B],
    ] as const) {
      for (const t of ['campuses', 'departments']) {
        const r = await runAs(ctx, `SELECT DISTINCT organization_id FROM app.${t}`);
        expect(
          r.rows.map((x) => x['organization_id']),
          t,
        ).toEqual([org]);
      }
    }
    expect((await runAs({}, 'SELECT 1 FROM app.campuses')).rowCount).toBe(0);
    expect((await runAs({}, 'SELECT 1 FROM app.departments')).rowCount).toBe(0);
  });

  it('staff can create in their own tenant but not in another', async () => {
    expect((await runAs(CTX.staffA, insertCampus(ORG_A))).error).toBeUndefined();
    expect((await runAs(CTX.staffA, insertCampus(ORG_B))).error?.code).toBe('42501');
    expect((await runAs(CTX.staffA, insertDept(ORG_A, CAMPUS_1))).error).toBeUndefined();
    expect((await runAs(CTX.staffA, insertDept(ORG_B, CAMPUS_B1))).error?.code).toBe('42501');
  });

  it('a department cannot hang under another tenant’s campus (composite foreign key)', async () => {
    expect((await runAs(CTX.staffA, insertDept(ORG_A, CAMPUS_B1))).error?.code).toBe('23503');
  });

  it('a STUDENT session can read the structure but the database refuses every write', async () => {
    expect((await runAs(CTX.studentA, 'SELECT 1 FROM app.campuses')).rowCount).toBeGreaterThan(0);
    expect((await runAs(CTX.studentA, 'SELECT 1 FROM app.departments')).rowCount).toBeGreaterThan(
      0,
    );
    expect((await runAs(CTX.studentA, insertCampus(ORG_A))).error?.code).toBe('42501');
    expect((await runAs(CTX.studentA, insertDept(ORG_A, CAMPUS_1))).error?.code).toBe('42501');
    // The restrictive UPDATE policy's USING clause hides the rows from a STUDENT session: the statement is not an
    // error, it simply matches nothing. Assert the effect (no row changed), not an error code.
    const campus = await runAs(CTX.studentA, `UPDATE app.campuses SET name = 'x'`);
    const dept = await runAs(CTX.studentA, `UPDATE app.departments SET name = 'x'`);
    expect(campus.error).toBeUndefined();
    expect(campus.rowCount).toBe(0);
    expect(dept.error).toBeUndefined();
    expect(dept.rowCount).toBe(0);
    const names = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM (SELECT name FROM app.campuses UNION ALL SELECT name FROM app.departments) t WHERE name = 'x'`,
    );
    expect(names).toEqual([{ n: '0' }]);
  });
});
