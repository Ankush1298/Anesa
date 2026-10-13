import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { seedTenantRoles } from '../../src/shared/authorization/seed.js';

/**
 * A brand-new tenant for tests that COMMIT rows (students, users, role assignments, audit events). Other integration
 * files assert things about tenant A as a whole (every ORG_A user is a known fixture, ORG_A audit counts do not move),
 * so a test that commits must never write there. The tenant is created on the shared disposable integration database
 * as the harness (superuser), with the real role seeder, so it behaves like any other tenant.
 *
 * Audit events are append-only by design and the organization row is referenced by them, so `cleanup` removes
 * everything it can (students, employees, assignments, sessions, idempotency records) and leaves the organization,
 * its users and its audit events in place.
 */
export interface IsolatedTenant {
  orgId: string;
  campusId: string;
  departmentId: string;
  /** user ids by name */
  users: Record<Name, string>;
  /** login emails by name */
  emails: Record<Name, string>;
  /** student ids of the two seeded students */
  students: { one: string; two: string };
  cleanup(): Promise<void>;
}
type Name =
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'faculty'
  | 'registrarOrg'
  | 'registrarCampus'
  | 'studentOne'
  | 'studentTwo';

export async function createIsolatedTenant(passwordHash: string): Promise<IsolatedTenant> {
  const run = randomBytes(4).toString('hex');
  const orgId = uuidv7();
  const campusId = uuidv7();
  const departmentId = uuidv7();
  const names: Name[] = [
    'admin',
    'campusAdmin',
    'hod',
    'faculty',
    'registrarOrg',
    'registrarCampus',
    'studentOne',
    'studentTwo',
  ];
  const users = Object.fromEntries(names.map((n) => [n, uuidv7()])) as Record<Name, string>;
  const emails = Object.fromEntries(
    names.map((n) => [n, `${n.toLowerCase()}.${run}@isolated.test`]),
  ) as Record<Name, string>;
  const students = { one: uuidv7(), two: uuidv7() };

  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO app.organizations (id, name, slug) VALUES ($1, $2, $3)`, [
      orgId,
      `Isolated ${run}`,
      `isolated-${run}`,
    ]);
    for (const n of names) {
      await c.query(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
        [users[n], emails[n], passwordHash],
      );
      await c.query(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
        [users[n], orgId, emails[n], n],
      );
    }
    await seedTenantRoles({ query: (text, values) => c.query(text, [...(values ?? [])]) }, orgId);
    await c.query(
      `INSERT INTO app.campuses (id, organization_id, name, code, timezone)
       VALUES ($1, $2, 'Isolated campus', 'IC', 'Asia/Kolkata')`,
      [campusId, orgId],
    );
    await c.query(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code)
       VALUES ($1, $2, $3, 'Isolated department', 'ID')`,
      [departmentId, orgId, campusId],
    );
    const assign = async (
      user: string,
      role: string,
      scopeType: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT',
      scopeId: string | null,
    ): Promise<void> => {
      await c.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
                CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
           FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
        [uuidv7(), orgId, user, role, scopeType, scopeId],
      );
    };
    await assign(users.admin, 'COLLEGE_ADMIN', 'ORGANIZATION', null);
    await assign(users.campusAdmin, 'CAMPUS_ADMIN', 'CAMPUS', campusId);
    await assign(users.hod, 'HOD', 'DEPARTMENT', departmentId);
    await assign(users.faculty, 'FACULTY', 'ORGANIZATION', null);
    await assign(users.registrarOrg, 'REGISTRAR', 'ORGANIZATION', null);
    await assign(users.registrarCampus, 'REGISTRAR', 'CAMPUS', campusId);
    await assign(users.studentOne, 'STUDENT', 'ORGANIZATION', null);
    await assign(users.studentTwo, 'STUDENT', 'ORGANIZATION', null);
    await c.query(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
       VALUES ($1, $3, $4, $6, '2024-07-01', 'ACTIVE'), ($2, $3, $5, $7, '2024-07-01', 'ACTIVE')`,
      [
        students.one,
        students.two,
        orgId,
        users.studentOne,
        users.studentTwo,
        `I${run}-1`,
        `I${run}-2`,
      ],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }

  return {
    orgId,
    campusId,
    departmentId,
    users,
    emails,
    students,
    async cleanup() {
      const k = new pg.Client({ connectionString: inject('dbAdminUrl') });
      await k.connect();
      try {
        for (const table of [
          'app.idempotency_keys',
          'app.students',
          'app.employees',
          'app.role_assignments',
        ]) {
          await k.query(`DELETE FROM ${table} WHERE organization_id = $1`, [orgId]);
        }
        await k
          .query(`DELETE FROM platform.auth_sessions WHERE identity_id = ANY($1::uuid[])`, [
            Object.values(users),
          ])
          .catch(() => undefined);
      } finally {
        await k.end();
      }
    },
  };
}
