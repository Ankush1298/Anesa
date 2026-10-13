import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CTX, NOROLE_A, ORG_A, USER_A } from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';

// Migration 0020: the database backstop of the person-identity invariant. Catalogue facts (function properties,
// trigger definitions, privileges) and behaviour through the REAL runtime role. Every runAs / runStepsAs call is rolled
// back, so the shared fixtures stay pristine. The raw-writer, race and predicate-parity tests are in
// tests/integration/person-identity-invariant.test.ts.

const sql0020 = readFileSync(
  join(
    resolve(import.meta.dirname, '../../..'),
    'database/migrations/0020_student_staff_role_exclusivity.sql',
  ),
  'utf8',
);

const FUNCTIONS = [
  'enforce_student_staff_role_exclusive_on_assignment',
  'enforce_student_staff_role_exclusive_on_student',
];

describe('the two trigger functions', () => {
  it('are SECURITY INVOKER, VOLATILE, owned by the migrator, with a pinned search_path, not executable by PUBLIC or the runtime role', async () => {
    const r = await adminQuery(
      `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY($1::text[])
        ORDER BY 1`,
      [FUNCTIONS],
    );
    expect(r).toEqual(
      FUNCTIONS.map((proname) => ({
        proname,
        prosecdef: false,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog'],
        owner: 'app_migrator',
        public_exec: false,
        runtime_exec: false,
      })),
    );
  });

  it('use the 0016 lock key and the single predicate (text pins on the migration, comments removed)', () => {
    const code = sql0020.replace(/--[^\n]*/g, '');
    const keys = code.match(
      /'app\.person_record_exclusive:' \|\| NEW\.organization_id::text \|\| ':' \|\| NEW\.user_id::text/g,
    );
    expect(keys).toHaveLength(2);
    expect(code.match(/r\.code <> 'STUDENT'/g)).toHaveLength(1); // student-side function; the other tests the role code
    expect(code).toMatch(/assigned_role = 'STUDENT'/);
    expect(code).toMatch(/ra\.status = 'ACTIVE'/);
    expect(code).toMatch(/ra\.valid_until IS NULL OR ra\.valid_until > pg_catalog\.now\(\)/);
    expect(code).not.toMatch(/valid_from/); // valid_from is deliberately ignored
    expect(code).toMatch(/ERRCODE = 'exclusion_violation'/);
    expect(code.match(/CONSTRAINT = 'person_record_exclusive'/g)).toHaveLength(2);
    expect(code).not.toMatch(/SECURITY DEFINER/i);
  });
});

describe('the triggers', () => {
  it('exist with the intended timing, events and WHEN clauses', async () => {
    const r = await adminQuery<{ tgname: string; def: string }>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_exclusive\\_%' ESCAPE '\\'
          AND (t.tgrelid = 'app.role_assignments'::regclass OR t.tgrelid = 'app.students'::regclass)
          AND t.tgname NOT LIKE '%person%'
        ORDER BY 1`,
    );
    expect(r.map((x) => x.tgname)).toEqual([
      'role_assignments_student_exclusive_ins',
      'role_assignments_student_exclusive_upd',
      'students_staff_role_exclusive_ins',
      'students_staff_role_exclusive_upd',
    ]);
    const d = Object.fromEntries(r.map((x) => [x.tgname, x.def]));
    expect(d['role_assignments_student_exclusive_ins']).toMatch(
      /BEFORE INSERT ON app\.role_assignments FOR EACH ROW/,
    );
    expect(d['role_assignments_student_exclusive_upd']).toMatch(
      /BEFORE UPDATE OF valid_until ON app\.role_assignments FOR EACH ROW WHEN \(\(old\.valid_until IS DISTINCT FROM new\.valid_until\)\)/,
    );
    expect(d['students_staff_role_exclusive_ins']).toMatch(
      /BEFORE INSERT ON app\.students FOR EACH ROW/,
    );
    expect(d['students_staff_role_exclusive_upd']).toMatch(
      /BEFORE UPDATE OF user_id ON app\.students FOR EACH ROW WHEN \(\(\(old\.user_id\)::uuid IS DISTINCT FROM \(new\.user_id\)::uuid\)\)/,
    );
  });

  it('are enabled (not disabled or replica-only)', async () => {
    const r = await adminQuery<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN ('role_assignments_student_exclusive_ins','role_assignments_student_exclusive_upd',
                                             'students_staff_role_exclusive_ins','students_staff_role_exclusive_upd')`,
    );
    expect(r).toHaveLength(4);
    expect(r.every((x) => x.tgenabled === 'O')).toBe(true);
  });
});

describe('through the real runtime role (STAFF actor of the tenant), rolled back', () => {
  const insertRole = (code: string, user: string, extra = '') =>
    [
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id${extra ? ', ' + extra.split('|')[0] : ''})
       SELECT '01939a00-0000-7000-8000-00000000d7f1', $1::uuid, $2::uuid, r.id, 'ORGANIZATION', NULL${extra ? ', ' + extra.split('|')[1] : ''}
         FROM app.roles r WHERE r.organization_id = $1::uuid AND r.code = $3`,
      [ORG_A, user, code],
    ] as const;

  it('a staff role for a STUDENT account is refused: 23P01 person_record_exclusive (USER_A is a seeded student)', async () => {
    for (const code of ['FACULTY', 'COLLEGE_ADMIN']) {
      const r = await runAs(CTX.staffA, ...insertRole(code, USER_A));
      expect(r.error?.code, code).toBe('23P01');
      expect(r.error?.message).toMatch(
        /student record cannot hold a staff-capable role assignment/,
      );
    }
  });

  it('a future-dated staff role for a student account is refused too (valid_from is ignored)', async () => {
    const r = await runAs(
      CTX.staffA,
      ...insertRole('FACULTY', USER_A, "valid_from|now() + interval '1 day'"),
    );
    expect(r.error?.code).toBe('23P01');
  });

  it('a STUDENT role for a student account, and a staff role for an account WITHOUT a student record, are accepted', async () => {
    expect((await runAs(CTX.staffA, ...insertRole('STUDENT', USER_A))).error).toBeUndefined();
    expect((await runAs(CTX.staffA, ...insertRole('FACULTY', NOROLE_A))).error).toBeUndefined();
  });

  it('an ended-window or non-ACTIVE staff row for a student account is accepted (never conflicts)', async () => {
    const ended = await runAs(
      CTX.staffA,
      ...insertRole(
        'FACULTY',
        USER_A,
        "valid_from, valid_until|now() - interval '3 days', now() - interval '1 day'",
      ),
    );
    expect(ended.error).toBeUndefined();
    const revoked = await runAs(CTX.staffA, ...insertRole('FACULTY', USER_A, "status|'REVOKED'"));
    expect(revoked.error).toBeUndefined();
  });

  it('the runtime role extending valid_until of an ended staff window on a student account is refused (revival); an ordinary revoke is not', async () => {
    const steps = (update: string) =>
      [
        [
          `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until)
           SELECT '01939a00-0000-7000-8000-00000000d7f2', $1::uuid, $2::uuid, r.id, 'ORGANIZATION', NULL,
                  now() - interval '3 days', now() - interval '1 day'
             FROM app.roles r WHERE r.organization_id = $1::uuid AND r.code = 'FACULTY'`,
          [ORG_A, USER_A],
        ],
        [update, ['01939a00-0000-7000-8000-00000000d7f2']],
      ] as const;
    const revive = await runStepsAs(
      CTX.staffA,
      steps(
        "UPDATE app.role_assignments SET valid_until = now() + interval '30 days' WHERE id = $1",
      ),
    );
    expect(revive.error?.code).toBe('23P01');
    const revoke = await runStepsAs(
      CTX.staffA,
      steps("UPDATE app.role_assignments SET status = 'REVOKED' WHERE id = $1"),
    );
    expect(revoke.error).toBeUndefined();
  });

  it('a STUDENT actor inserting a staff role for its own account gets the trigger answer (23P01) before RLS: documented order of BEFORE ROW triggers', async () => {
    const r = await runAs(CTX.studentA, ...insertRole('COLLEGE_ADMIN', USER_A));
    expect(r.error?.code).toBe('23P01');
  });
});
