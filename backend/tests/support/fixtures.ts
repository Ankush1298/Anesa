import pg from 'pg';

/**
 * Deterministic security fixtures (all UUIDv7-shaped). Relationships:
 *
 *   Tenant A (ORG_A)                              Tenant B (ORG_B)
 *     USER_A   login of  STUDENT_A  ── GUARDIAN_A    USER_B   login of  STUDENT_C ── GUARDIAN_C
 *     USER_A2  login of  STUDENT_B  ── GUARDIAN_B    STAFF_B  staff account (no student)
 *     STAFF_A  staff account (no student)
 */
export const ORG_A = '01939a00-0000-7000-8000-000000000a01';
export const ORG_B = '01939a00-0000-7000-8000-000000000b01';

export const USER_A = '01939a00-0000-7000-8000-00000000aa01';
export const USER_A2 = '01939a00-0000-7000-8000-00000000aa02';
export const STAFF_A = '01939a00-0000-7000-8000-00000000aa03';
export const USER_B = '01939a00-0000-7000-8000-00000000bb01';
export const STAFF_B = '01939a00-0000-7000-8000-00000000bb03';

export const STUDENT_A = '01939a00-0000-7000-8000-00000000a501';
export const STUDENT_B = '01939a00-0000-7000-8000-00000000a502';
export const STUDENT_C = '01939a00-0000-7000-8000-00000000b501';

export const GUARDIAN_A = '01939a00-0000-7000-8000-00000000a601';
export const GUARDIAN_B = '01939a00-0000-7000-8000-00000000a602';
export const GUARDIAN_C = '01939a00-0000-7000-8000-00000000b601';

/** Tenant C exists only for tests that COMMIT writes, so they cannot disturb the A/B assertions. */
export const ORG_C = '01939a00-0000-7000-8000-000000000c01';
export const STAFF_C = '01939a00-0000-7000-8000-00000000cc03';

export interface Ctx {
  tenant: string;
  user: string;
  kind: 'STUDENT' | 'STAFF';
}
/** Valid, server-trusted contexts for each fixture principal. */
export const CTX = {
  studentA: { tenant: ORG_A, user: USER_A, kind: 'STUDENT' },
  studentB: { tenant: ORG_A, user: USER_A2, kind: 'STUDENT' },
  staffA: { tenant: ORG_A, user: STAFF_A, kind: 'STAFF' },
  studentC: { tenant: ORG_B, user: USER_B, kind: 'STUDENT' },
  staffB: { tenant: ORG_B, user: STAFF_B, kind: 'STAFF' },
  staffC: { tenant: ORG_C, user: STAFF_C, kind: 'STAFF' },
} as const satisfies Record<string, Ctx>;

/** A well-formed UUIDv7 that exists nowhere. */
export const UNKNOWN_V7 = '01939a00-0000-7000-8000-00000000ffff';
/** A random-looking UUIDv4: syntactically a UUID, but not a valid identifier for this system. */
export const SOME_V4 = '3b241101-e2bb-4255-8caf-4136c566a962';

export async function seedFixtures(adminUrl: string): Promise<void> {
  // Seeded as the superuser, which bypasses RLS: this is the test harness acting as the platform.
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO app.organizations (id, name, slug) VALUES ($1, 'College A', 'college-a'), ($2, 'College B', 'college-b')`,
      [ORG_A, ORG_B],
    );

    // Create identities for the users
    await c.query(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES
         ($1, 'user.a@college-a.test', 'test-hash', 'ACTIVE'),
         ($2, 'user.a2@college-a.test', 'test-hash', 'ACTIVE'),
         ($3, 'staff.a@college-a.test', 'test-hash', 'ACTIVE'),
         ($4, 'user.b@college-b.test', 'test-hash', 'ACTIVE'),
         ($5, 'staff.b@college-b.test', 'test-hash', 'ACTIVE')`,
      [USER_A, USER_A2, STAFF_A, USER_B, STAFF_B],
    );

    await c.query(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES
         ($1, $6, 'user.a@college-a.test',  'User A',  'ACTIVE', $1),
         ($2, $6, 'user.a2@college-a.test', 'User A2', 'ACTIVE', $2),
         ($3, $6, 'staff.a@college-a.test', 'Staff A', 'ACTIVE', $3),
         ($4, $7, 'user.b@college-b.test',  'User B',  'ACTIVE', $4),
         ($5, $7, 'staff.b@college-b.test', 'Staff B', 'ACTIVE', $5)`,
      [USER_A, USER_A2, STAFF_A, USER_B, STAFF_B, ORG_A, ORG_B],
    );
    await c.query(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, status) VALUES
         ($1, $4, $5, 'A-0001', 'ACTIVE'),
         ($2, $4, $6, 'A-0002', 'ACTIVE'),
         ($3, $7, $8, 'B-0001', 'ACTIVE')`,
      [STUDENT_A, STUDENT_B, STUDENT_C, ORG_A, USER_A, USER_A2, ORG_B, USER_B],
    );
    await c.query(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation, is_primary) VALUES
         ($1, $4, $5, 'Guardian of A', '+10000000001', 'MOTHER', true),
         ($2, $4, $6, 'Guardian of B', '+10000000002', 'FATHER', true),
         ($3, $7, $8, 'Guardian of C', '+10000000003', 'MOTHER', true)`,
      [GUARDIAN_A, GUARDIAN_B, GUARDIAN_C, ORG_A, STUDENT_A, STUDENT_B, ORG_B, STUDENT_C],
    );
    await c.query(
      `INSERT INTO app.organizations (id, name, slug) VALUES ($1, 'College C', 'college-c')`,
      [ORG_C],
    );
    await c.query(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'staff.c@college-c.test', 'test-hash', 'ACTIVE')`,
      [STAFF_C],
    );
    await c.query(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'staff.c@college-c.test', 'Staff C', 'ACTIVE', $1)`,
      [STAFF_C, ORG_C],
    );

    // Roles and permissions
    for (const org of [ORG_A, ORG_B]) {
      const p = org === ORG_A ? 'a' : 'b';
      const roleStudent = `01939a00-0000-7000-8000-00000000${p}701`;
      const roleFaculty = `01939a00-0000-7000-8000-00000000${p}702`;
      const roleAdmin = `01939a00-0000-7000-8000-00000000${p}703`;

      // Seed roles for each org
      await c.query(`
        INSERT INTO app.roles (id, organization_id, code, name) VALUES
          ('${roleStudent}', '${org}', 'STUDENT', 'STUDENT'),
          ('${roleFaculty}', '${org}', 'FACULTY', 'FACULTY'),
          ('${roleAdmin}', '${org}', 'CAMPUS_ADMIN', 'CAMPUS_ADMIN')
      `);

      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleStudent}', 'student.profile.read', 'SELF')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleStudent}', 'session.read', 'SELF')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleFaculty}', 'attendance.session.mark', 'ASSIGNED')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleFaculty}', 'session.read', 'SELF')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleAdmin}', 'student.profile.read', 'GRANTED')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleAdmin}', 'role.assignment.grant', 'GRANTED')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleAdmin}', 'role.assignment.revoke', 'GRANTED')
      `);
      await c.query(`
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ('${org}', '${roleAdmin}', 'session.read', 'SELF')
      `);
    }

    // Role Assignments
    await c.query(`
      INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
      VALUES ('01939a00-0000-7000-8000-00000000a801', '${ORG_A}', '${USER_A}', '01939a00-0000-7000-8000-00000000a701', 'ORGANIZATION')
    `);
    await c.query(`
      INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
      VALUES ('01939a00-0000-7000-8000-00000000a802', '${ORG_A}', '${STAFF_A}', '01939a00-0000-7000-8000-00000000a703', 'ORGANIZATION')
    `);
    await c.query(`
      INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
      VALUES ('01939a00-0000-7000-8000-00000000b801', '${ORG_B}', '${USER_B}', '01939a00-0000-7000-8000-00000000b701', 'ORGANIZATION')
    `);

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}
