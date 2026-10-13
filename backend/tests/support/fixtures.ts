import pg from 'pg';
import { seedTenantRoles } from '../../src/shared/authorization/seed.js';

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

export const FACULTY_A = '01939a00-0000-7000-8000-00000000aa04';
export const HOD_A = '01939a00-0000-7000-8000-00000000aa05';
export const CAMPUS_ADMIN_A = '01939a00-0000-7000-8000-00000000aa06';
export const NOROLE_A = '01939a00-0000-7000-8000-00000000aa07';
/** Holds no assignment; tests give it assignments in various states and clean up. */
export const TEMP_A = '01939a00-0000-7000-8000-00000000aa08';
/** Dedicated to the database-lock test so parallel test files never share a locked identity. */
export const LOCK_A = '01939a00-0000-7000-8000-00000000aa09';
/** Grant/revoke target for the (rolled-back) assignment-service tests; no other test touches it. */
export const GRANTEE_A = '01939a00-0000-7000-8000-00000000aa0a';
export const EXTRA_A_USER_IDS = [
  FACULTY_A,
  HOD_A,
  CAMPUS_ADMIN_A,
  NOROLE_A,
  TEMP_A,
  LOCK_A,
  GRANTEE_A,
];
const EXTRA_A_USERS: [string, string][] = [
  [FACULTY_A, 'faculty.a@college-a.test'],
  [HOD_A, 'hod.a@college-a.test'],
  [CAMPUS_ADMIN_A, 'campus.admin.a@college-a.test'],
  [NOROLE_A, 'norole.a@college-a.test'],
  [TEMP_A, 'temp.a@college-a.test'],
  [LOCK_A, 'lock.a@college-a.test'],
  [GRANTEE_A, 'grantee.a@college-a.test'],
];

/** Scope identifiers: real rows in app.campuses / app.departments (tenant A), created by seedFixtures. */
export const CAMPUS_1 = '01939a00-0000-7000-8000-00000000ca01';
export const CAMPUS_2 = '01939a00-0000-7000-8000-00000000ca02';
export const DEPT_1 = '01939a00-0000-7000-8000-00000000de01'; // in CAMPUS_1
export const DEPT_2 = '01939a00-0000-7000-8000-00000000de02'; // in CAMPUS_1
export const DEPT_3 = '01939a00-0000-7000-8000-00000000de03'; // in CAMPUS_2
/** A campus/department of tenant B: valid ids that tenant A must never be able to scope a role to. */
export const CAMPUS_B1 = '01939a00-0000-7000-8000-00000000cb01';
export const DEPT_B1 = '01939a00-0000-7000-8000-00000000db01'; // in CAMPUS_B1

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
  facultyA: { tenant: ORG_A, user: FACULTY_A, kind: 'STAFF' },
  hodA: { tenant: ORG_A, user: HOD_A, kind: 'STAFF' },
  campusAdminA: { tenant: ORG_A, user: CAMPUS_ADMIN_A, kind: 'STAFF' },
  noroleA: { tenant: ORG_A, user: NOROLE_A, kind: 'STAFF' },
  tempA: { tenant: ORG_A, user: TEMP_A, kind: 'STAFF' },
} as const satisfies Record<string, Ctx>;

/** A well-formed UUIDv7 that exists nowhere. */
export const UNKNOWN_V7 = '01939a00-0000-7000-8000-00000000ffff';
/** A random-looking UUIDv4: syntactically a UUID, but not a valid identifier for this system. */
export const SOME_V4 = '3b241101-e2bb-4255-8caf-4136c566a962';

export interface SeedFixturesOptions {
  /**
   * Seed the students in the shape that existed BEFORE migration 0017 (no admission_date column). Only for tests that
   * deliberately build a database at an older schema and need rows written under it (tests/integration/
   * migration-contract.test.ts, legacyDatabase). Every other caller seeds a fully migrated database and must leave this off.
   */
  legacyStudentShape?: boolean;
}

export async function seedFixtures(
  adminUrl: string,
  options: SeedFixturesOptions = {},
): Promise<void> {
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
    const studentParams = [STUDENT_A, STUDENT_B, STUDENT_C, ORG_A, USER_A, USER_A2, ORG_B, USER_B];
    if (options.legacyStudentShape) {
      await c.query(
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, status) VALUES
           ($1, $4, $5, 'A-0001', 'ACTIVE'),
           ($2, $4, $6, 'A-0002', 'ACTIVE'),
           ($3, $7, $8, 'B-0001', 'ACTIVE')`,
        studentParams,
      );
    } else {
      await c.query(
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status) VALUES
           ($1, $4, $5, 'A-0001', '2024-07-01', 'ACTIVE'),
           ($2, $4, $6, 'A-0002', '2024-07-01', 'ACTIVE'),
           ($3, $7, $8, 'B-0001', '2024-07-01', 'ACTIVE')`,
        studentParams,
      );
    }
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

    // Extra ORG_A principals for the authorization matrix (identity + user + assignment each).
    for (const [id, email] of EXTRA_A_USERS) {
      await c.query(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
        [id, email],
      );
      await c.query(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
        [id, ORG_A, email],
      );
    }

    // Roles come from the REAL seeder, so the tests exercise the real matrix.
    const exec = {
      query: (text: string, values?: readonly unknown[]) => c.query(text, [...(values ?? [])]),
    };
    for (const org of [ORG_A, ORG_B, ORG_C]) await seedTenantRoles(exec, org);

    // Academic structure first: scoped role assignments below reference these rows (typed FKs, 0008/0009).
    await c.query(
      `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES
         ($1, $4, 'Campus 1', 'C1', 'Asia/Kolkata'),
         ($2, $4, 'Campus 2', 'C2', 'Asia/Kolkata'),
         ($3, $5, 'Campus B1', 'CB1', 'Asia/Kolkata')`,
      [CAMPUS_1, CAMPUS_2, CAMPUS_B1, ORG_A, ORG_B],
    );
    await c.query(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES
         ($1, $5, $4, 'Department 1', 'D1'),
         ($2, $5, $4, 'Department 2', 'D2'),
         ($3, $5, $6, 'Department 3', 'D3'),
         ($7, $8, $9, 'Department B1', 'DB1')`,
      [DEPT_1, DEPT_2, DEPT_3, CAMPUS_1, ORG_A, CAMPUS_2, DEPT_B1, ORG_B, CAMPUS_B1],
    );

    const assign = async (
      org: string,
      user: string,
      role: string,
      scopeType: string,
      scopeId: string | null,
      n: number,
    ): Promise<void> => {
      await c.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
                CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
           FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
        [
          `01939a00-0000-7000-8000-00000000d${String(n).padStart(3, '0')}`,
          org,
          user,
          role,
          scopeType,
          scopeId,
        ],
      );
    };
    await assign(ORG_A, USER_A, 'STUDENT', 'ORGANIZATION', null, 1);
    await assign(ORG_A, USER_A2, 'STUDENT', 'ORGANIZATION', null, 2);
    await assign(ORG_A, STAFF_A, 'COLLEGE_ADMIN', 'ORGANIZATION', null, 3);
    await assign(ORG_A, FACULTY_A, 'FACULTY', 'ORGANIZATION', null, 4);
    await assign(ORG_A, HOD_A, 'HOD', 'DEPARTMENT', DEPT_1, 5);
    await assign(ORG_A, CAMPUS_ADMIN_A, 'CAMPUS_ADMIN', 'CAMPUS', CAMPUS_1, 6);
    await assign(ORG_B, USER_B, 'STUDENT', 'ORGANIZATION', null, 7);
    await assign(ORG_B, STAFF_B, 'COLLEGE_ADMIN', 'ORGANIZATION', null, 8);
    await assign(ORG_C, STAFF_C, 'COLLEGE_ADMIN', 'ORGANIZATION', null, 9);
    // NOROLE_A and TEMP_A deliberately hold no assignment.

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}
