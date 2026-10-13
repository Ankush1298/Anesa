import { describe, expect, it } from 'vitest';
import {
  CTX,
  GUARDIAN_A,
  GUARDIAN_B,
  GUARDIAN_C,
  ORG_A,
  ORG_B,
  STAFF_A,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
  USER_A,
  USER_A2,
  USER_B,
} from '../support/fixtures.js';
import { ids, runAs, snapshot } from '../support/db-harness.js';

// Same tenant, different students: the database must separate them using only the authenticated
// user -> student mapping, never a client-supplied student id.
describe('Student isolation (same tenant) — Invariant B', () => {
  it('[9] Student A can read Student A data', async () => {
    expect(ids(await runAs(CTX.studentA, 'SELECT id FROM app.students'))).toEqual([STUDENT_A]);
    expect(ids(await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians'))).toEqual([
      GUARDIAN_A,
    ]);
    expect(ids(await runAs(CTX.studentA, 'SELECT id FROM app.users'))).toEqual([USER_A]);
    expect(ids(await runAs(CTX.studentA, 'SELECT id FROM app.organizations'))).toEqual([ORG_A]);
    // and by explicit id, exactly as an API handler would
    expect(
      ids(await runAs(CTX.studentA, 'SELECT id FROM app.students WHERE id = $1', [STUDENT_A])),
    ).toEqual([STUDENT_A]);
  });

  it('[10] Student A cannot read Student B data (same tenant)', async () => {
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.students WHERE id = $1', [STUDENT_B])).rows,
    ).toEqual([]);
    expect(
      (
        await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians WHERE id = $1', [
          GUARDIAN_B,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians WHERE student_id = $1', [
          STUDENT_B,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.users WHERE id = $1', [USER_A2])).rows,
    ).toEqual([]);
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.users WHERE id = $1', [STAFF_A])).rows,
    ).toEqual([]);
    // unfiltered and joined queries must not leak either
    expect(
      (await runAs(CTX.studentA, 'SELECT count(*)::int AS n FROM app.students')).rows[0],
    ).toEqual({ n: 1 });
    const joined = await runAs(
      CTX.studentA,
      'SELECT g.id FROM app.student_guardians g JOIN app.students s ON s.id = g.student_id',
    );
    expect(ids(joined)).toEqual([GUARDIAN_A]);
    // the symmetric direction
    expect(ids(await runAs(CTX.studentB, 'SELECT id FROM app.students'))).toEqual([STUDENT_B]);
  });

  it('[11] Student A cannot read Student C data (other tenant)', async () => {
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.students WHERE id = $1', [STUDENT_C])).rows,
    ).toEqual([]);
    expect(
      (
        await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians WHERE id = $1', [
          GUARDIAN_C,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.users WHERE id = $1', [USER_B])).rows,
    ).toEqual([]);
  });

  it('[12] Student A cannot update Student B (control: can update own rows)', async () => {
    const before = await snapshot();
    expect(
      (
        await runAs(CTX.studentA, "UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1", [
          STUDENT_B,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(
          CTX.studentA,
          "UPDATE app.student_guardians SET phone = '+19999999999' WHERE id = $1",
          [GUARDIAN_B],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(
          CTX.studentA,
          "UPDATE app.student_guardians SET phone = '+19999999999' WHERE student_id = $1",
          [STUDENT_B],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(CTX.studentA, "UPDATE app.users SET display_name = 'pwned' WHERE id = $1", [
          USER_A2,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await runAs(CTX.studentA, "UPDATE app.student_guardians SET phone = '+19999999999'"))
        .rowCount,
    ).toBe(1); // blanket update hits only A's row
    // positive controls
    expect(
      (
        await runAs(
          CTX.studentA,
          "UPDATE app.student_guardians SET phone = '+10000000011' WHERE id = $1",
          [GUARDIAN_A],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runAs(CTX.studentA, "UPDATE app.users SET display_name = 'Alice' WHERE id = $1", [
          USER_A,
        ])
      ).rowCount,
    ).toBe(1);
    expect(await snapshot()).toBe(before);
  });

  it('[13] Student A cannot delete Student B data (control: can delete own row)', async () => {
    expect(
      (await runAs(CTX.studentA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_B]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(CTX.studentA, 'DELETE FROM app.student_guardians WHERE student_id = $1', [
          STUDENT_B,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await runAs(CTX.studentA, 'DELETE FROM app.student_guardians')).rowCount).toBe(1); // only A's row
    expect(
      (await runAs(CTX.studentA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_A]))
        .rowCount,
    ).toBe(1);
  });

  it('[14] Student A cannot insert data pretending to belong to Student B (control: own works)', async () => {
    const insert =
      "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ($1, $2, $3, 'Impostor', '+10000000077', 'AUNT')";
    const forgedForB = await runAs(CTX.studentA, insert, [
      '01939a00-0000-7000-8000-00000000d101',
      ORG_A,
      STUDENT_B,
    ]);
    expect(forgedForB.error?.code).toBe('42501');
    expect(forgedForB.error?.message).toMatch(/row-level security/);
    const forgedForC = await runAs(CTX.studentA, insert, [
      '01939a00-0000-7000-8000-00000000d102',
      ORG_B,
      STUDENT_C,
    ]);
    expect(forgedForC.error?.code).toBe('42501');
    const own = await runAs(CTX.studentA, insert, [
      '01939a00-0000-7000-8000-00000000d103',
      ORG_A,
      STUDENT_A,
    ]);
    expect(own.error).toBeUndefined();
    expect(own.rowCount).toBe(1);
  });

  it("[15] Student A cannot change a record's student ownership to Student B", async () => {
    const r = await runAs(
      CTX.studentA,
      'UPDATE app.student_guardians SET student_id = $1 WHERE id = $2',
      [STUDENT_B, GUARDIAN_A],
    );
    expect(r.error?.code).toBe('42501');
    expect(r.error?.message).toMatch(/row-level security/);
    const toC = await runAs(
      CTX.studentA,
      'UPDATE app.student_guardians SET student_id = $1 WHERE id = $2',
      [STUDENT_C, GUARDIAN_A],
    );
    expect(toC.error).toBeDefined();
    // taking over Student B's record by flipping ownership TO A is also impossible: B's row is invisible
    const steal = await runAs(
      CTX.studentA,
      'UPDATE app.student_guardians SET student_id = $1 WHERE id = $2',
      [STUDENT_A, GUARDIAN_B],
    );
    expect(steal.error).toBeUndefined();
    expect(steal.rowCount).toBe(0);
    // re-pointing the account mapping of one's own student record to someone else's login
    for (const target of [USER_A2, STAFF_A]) {
      const remap = await runAs(
        CTX.studentA,
        'UPDATE app.students SET user_id = $1 WHERE id = $2',
        [target, STUDENT_A],
      );
      expect(remap.error?.code, `remap to ${target}`).toBe('42501');
      // 0017 revoked UPDATE (user_id) from the runtime role: the refusal is now a column privilege, which is checked
      // before row-level security. (Before 0017 it was the students_student_self WITH CHECK.)
      expect(remap.error?.message).toMatch(/permission denied/);
    }
  });

  it('a student can never create students or accounts (INSERT is restricted to staff actors)', async () => {
    const stu = await runAs(
      CTX.studentA,
      "INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ('01939a00-0000-7000-8000-00000000d201', $1, $2, 'SELF-1', '2024-07-01')",
      [ORG_A, USER_A],
    );
    expect(stu.error?.code).toBe('42501');
    const usr = await runAs(
      CTX.studentA,
      "INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ('01939a00-0000-7000-8000-00000000d202', $1, 'new@college-a.test', 'New', 'ACTIVE')",
      [ORG_A],
    );
    expect(usr.error?.code).toBe('42501');
    // the same inserts are fine for a staff actor in the same tenant (the restriction is about the actor, not the data)
    const staff = await runAs(
      CTX.staffA,
      "INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ('01939a00-0000-7000-8000-00000000d203', $1, 'new@college-a.test', 'New', 'ACTIVE')",
      [ORG_A],
    );
    expect(staff.error).toBeUndefined();
  });

  it('a student actor cannot make itself a staff actor in the DATABASE by naming a different user', async () => {
    // claiming STUDENT with someone else's user id yields that user's view only if the mapping matches
    const asB = await runAs(
      { tenant: ORG_A, user: USER_A2, kind: 'STUDENT' },
      'SELECT id FROM app.students',
    );
    expect(ids(asB)).toEqual([STUDENT_B]);
    // a staff user claiming STUDENT sees no student record at all (STAFF_A is not mapped to a student)
    const staffAsStudent = await runAs(
      { tenant: ORG_A, user: STAFF_A, kind: 'STUDENT' },
      'SELECT id FROM app.students',
    );
    expect(staffAsStudent.rows).toEqual([]);
    const sg = await runAs(
      { tenant: ORG_A, user: STAFF_A, kind: 'STUDENT' },
      'SELECT id FROM app.student_guardians',
    );
    expect(sg.rows).toEqual([]);
  });
});
