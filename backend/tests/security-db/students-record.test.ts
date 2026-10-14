import { describe, expect, it } from 'vitest';
import { CTX, NOROLE_A, STUDENT_A, USER_A } from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';

// students (0017): STAFF-only updates, column privileges, admission-number immutability, status_changed_at, and the
// NOT VALID checks. Every runAs / runStepsAs call is rolled back, so the shared fixtures stay pristine; failing
// statements persist nothing. Nothing here may commit a row to the shared database (other files count students).

const NEW_STUDENT_ID = '01939a00-0000-7000-8000-00000000d5f1';

describe('students: who may update what (0017)', () => {
  it('a STUDENT cannot change their own status: the STAFF-only policy filters the row, nothing changes', async () => {
    const r = await runStepsAs(CTX.studentA, [
      ["UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1", [STUDENT_A]],
      ['SELECT status FROM app.students WHERE id = $1', [STUDENT_A]],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([{ status: 'ACTIVE' }]); // still readable (self-read intact), still ACTIVE

    const upd = await runAs(
      CTX.studentA,
      "UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1",
      [STUDENT_A],
    );
    expect(upd.error).toBeUndefined();
    expect(upd.rowCount).toBe(0);
  });

  it('a STUDENT keeps reading their own row (and only theirs)', async () => {
    const r = await runAs(CTX.studentA, 'SELECT id, user_id FROM app.students');
    expect(r.rows).toEqual([{ id: STUDENT_A, user_id: USER_A }]);
  });

  it('the runtime role can update NO student column except status (column privileges)', async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'app' AND table_name = 'students' AND grantee = 'app_runtime'
          AND privilege_type = 'UPDATE' ORDER BY 1`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(['status']);

    for (const [label, sql] of [
      ['user_id', "UPDATE app.students SET user_id = '01939a00-0000-7000-8000-00000000aa04'"],
      ['admission_number', "UPDATE app.students SET admission_number = 'CHANGED'"],
      ['admission_date', "UPDATE app.students SET admission_date = '2000-01-01'"],
      ['status_changed_at', 'UPDATE app.students SET status_changed_at = now()'],
    ] as const) {
      for (const ctx of [CTX.staffA, CTX.studentA]) {
        const r = await runAs(ctx, sql);
        expect(r.error?.code, `${ctx.kind} updating ${label}`).toBe('42501');
        expect(r.error?.message).toMatch(/permission denied/);
      }
    }
  });

  it('a STAFF actor can still change status at the database-policy level (the audited service comes later)', async () => {
    // The version bump is compared with the version read by the same statement (its snapshot predates the update), so
    // an unrelated committed update of this fixture row by another test file cannot make the assertion flaky.
    const r = await runStepsAs(CTX.staffA, [
      [
        `UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1
          RETURNING status,
                    version = (SELECT s.version FROM app.students s WHERE s.id = $1) + 1 AS bumped,
                    status_changed_at = now() AS stamped`,
        [STUDENT_A],
      ],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toEqual({ status: 'SUSPENDED', bumped: true, stamped: true });
  });

  it('status_changed_at moves only when status changes', async () => {
    const same = await runStepsAs(CTX.staffA, [
      [
        'UPDATE app.students SET status = status WHERE id = $1 RETURNING status_changed_at = now() AS stamped',
        [STUDENT_A],
      ],
    ]);
    expect(same.error).toBeUndefined();
    expect(same.rows[0]).toEqual({ stamped: false });
  });

  it('a new row gets status_changed_at from the default; admission_date must be supplied', async () => {
    const ok = await runStepsAs(CTX.staffA, [
      [
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date)
         VALUES ($1, $2, $3, 'REC-1', '2024-07-01')
         RETURNING status, status_changed_at = now() AS stamped`,
        [NEW_STUDENT_ID, CTX.staffA.tenant, NOROLE_A],
      ],
    ]);
    expect(ok.error).toBeUndefined();
    expect(ok.rows[0]).toEqual({ status: 'ADMITTED', stamped: true });

    // NOT NULL (migration 0019 replaced the NOT VALID check of 0017): refused for new rows (nothing is persisted)
    const missing = await runAs(
      CTX.staffA,
      `INSERT INTO app.students (id, organization_id, user_id, admission_number)
       VALUES ($1, $2, $3, 'REC-2')`,
      [NEW_STUDENT_ID, CTX.staffA.tenant, NOROLE_A],
    );
    expect(missing.error?.code).toBe('23502');
    expect(missing.error?.message).toMatch(/admission_date/);
  });
});

describe('students: admission number immutability and the guard function (0017)', () => {
  it('admission_number cannot change, not even for the superuser (restrict_violation)', async () => {
    let code: string | undefined;
    try {
      await adminQuery("UPDATE app.students SET admission_number = 'CHANGED' WHERE id = $1", [
        STUDENT_A,
      ]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23001');
    const [row] = await adminQuery<{ admission_number: string }>(
      'SELECT admission_number FROM app.students WHERE id = $1',
      [STUDENT_A],
    );
    expect(row?.admission_number).toBe('A-0001');
  });

  it('the guard is a SECURITY INVOKER, VOLATILE trigger function with a pinned search_path, not executable by PUBLIC', async () => {
    const r = await adminQuery(
      `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'students_guard'`,
    );
    expect(r).toEqual([
      {
        prosecdef: false,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog'],
        owner: 'app_migrator',
        public_exec: false,
      },
    ]);
    const t = await adminQuery<{ def: string }>(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'app.students'::regclass AND tgname = 'students_guard_upd' AND NOT tgisinternal`,
    );
    expect(t).toHaveLength(1);
    expect(t[0]?.def).toMatch(/BEFORE UPDATE ON app\.students FOR EACH ROW/);
  });
});

describe('students: schema shape after the expand (0017) and contract (0019) steps', () => {
  it('admission_date has no default; status_changed_at has a default; both are NOT NULL since the 0019 contract step', async () => {
    const cols = await adminQuery<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'students'
          AND column_name IN ('admission_date', 'status_changed_at') ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: 'admission_date', is_nullable: 'NO', column_default: null },
      { column_name: 'status_changed_at', is_nullable: 'NO', column_default: 'now()' },
    ]);
  });

  it('the temporary NOT VALID checks of 0017 are gone: 0019 validated them, set NOT NULL and dropped them', async () => {
    // The expand-step shape (nullable columns, NOT VALID checks) is proved on a legacy database by
    // tests/integration/migration-0017.test.ts; the contract step by tests/integration/migration-0019.test.ts.
    const c = await adminQuery(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'app.students'::regclass AND conname IN ('students_admission_date_ck', 'students_status_changed_at_ck')`,
    );
    expect(c).toEqual([]);
  });

  it('student.record.create is catalogued as SENSITIVE', async () => {
    const p = await adminQuery(
      "SELECT code, sensitivity FROM platform.permissions WHERE code = 'student.record.create'",
    );
    expect(p).toEqual([{ code: 'student.record.create', sensitivity: 'SENSITIVE' }]);
  });
});

describe('student.directory.search (0023)', () => {
  it('is registered as SENSITIVE', async () => {
    const p = await adminQuery(
      "SELECT code, sensitivity FROM platform.permissions WHERE code = 'student.directory.search'",
    );
    expect(p).toEqual([{ code: 'student.directory.search', sensitivity: 'SENSITIVE' }]);
  });
});

describe('student.program.assign (0022)', () => {
  it('is registered as SENSITIVE', async () => {
    const p = await adminQuery(
      "SELECT code, sensitivity FROM platform.permissions WHERE code = 'student.program.assign'",
    );
    expect(p).toEqual([{ code: 'student.program.assign', sensitivity: 'SENSITIVE' }]);
  });
});

describe('students: policy set (0017)', () => {
  it('adds one RESTRICTIVE UPDATE policy for app_runtime and leaves the permissive set and the self policy intact', async () => {
    const pol = await adminQuery<{
      policyname: string;
      permissive: string;
      cmd: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
        WHERE schemaname = 'app' AND tablename = 'students' ORDER BY policyname`,
    );
    const staff = pol.find((p) => p.policyname === 'students_staff_update');
    expect(staff).toMatchObject({
      permissive: 'RESTRICTIVE',
      cmd: 'UPDATE',
      roles: '{app_runtime}',
    });
    expect(staff?.qual).toMatch(/STAFF/);
    expect(staff?.with_check).toMatch(/STAFF/);
    expect(pol.find((p) => p.policyname === 'students_student_self')).toMatchObject({
      permissive: 'RESTRICTIVE',
      cmd: 'ALL',
    });
    expect(
      pol
        .filter((p) => p.permissive === 'PERMISSIVE')
        .map((p) => p.cmd)
        .sort(),
    ).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
