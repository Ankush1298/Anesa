import { describe, expect, it } from 'vitest';
import {
  CAMPUS_1,
  CAMPUS_2,
  CAMPUS_B1,
  CTX,
  DEPT_1,
  DEPT_2,
  DEPT_B1,
  HOD_A,
  ORG_A,
  ORG_B,
  STAFF_A,
  TEMP_A,
  UNKNOWN_V7,
  USER_A,
  USER_B,
} from '../support/fixtures.js';
import { adminQuery, ids, runAs, runStepsAs, runStepsAsMigrator } from '../support/db-harness.js';

// Layer 2 (PostgreSQL RLS) for the authorization tables, tested WITHOUT any application code and
// with queries that carry no tenant filter: the database alone must hold the boundary.
const ASSIGNMENT = '01939a00-0000-7000-8000-00000000d0a1';
const roleId = (org: string, code: string): Promise<string> =>
  adminQuery<{ id: string }>('SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2', [
    org,
    code,
  ]).then((r) => r[0]!.id);

describe('authorization tables: tenant isolation (RLS)', () => {
  it('staff of tenant A see only tenant A roles, role_permissions and role_assignments', async () => {
    for (const t of ['roles', 'role_permissions', 'role_assignments']) {
      const own = await runAs(CTX.staffA, `SELECT DISTINCT organization_id FROM app.${t}`);
      expect(
        own.rows.map((r) => r['organization_id']),
        t,
      ).toEqual([ORG_A]);
      const other = await runAs(CTX.staffB, `SELECT DISTINCT organization_id FROM app.${t}`);
      expect(
        other.rows.map((r) => r['organization_id']),
        t,
      ).toEqual([ORG_B]);
    }
  });

  it('a missing or malformed context sees nothing (fail closed)', async () => {
    for (const ctx of [{}, { tenant: 'not-a-uuid', user: STAFF_A, kind: 'STAFF' }]) {
      for (const t of ['roles', 'role_permissions', 'role_assignments']) {
        expect((await runAs(ctx, `SELECT 1 FROM app.${t}`)).rows, t).toEqual([]);
      }
    }
  });

  it('tenant A cannot insert an assignment into tenant B, nor point one at a foreign role/user', async () => {
    const roleB = await roleId(ORG_B, 'STUDENT');
    const roleA = await roleId(ORG_A, 'STUDENT');
    const cases: [string, readonly unknown[]][] = [
      // wrong organization_id (RLS WITH CHECK)
      [ORG_B, [ASSIGNMENT, ORG_B, USER_B, roleB]],
      // right org, role of another tenant (composite FK)
      [ORG_A, [ASSIGNMENT, ORG_A, TEMP_A, roleB]],
      // right org, user of another tenant (composite FK)
      [ORG_A, [ASSIGNMENT, ORG_A, USER_B, roleA]],
    ];
    for (const [, p] of cases) {
      const r = await runAs(
        CTX.staffA,
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
         VALUES ($1, $2, $3, $4, 'ORGANIZATION')`,
        p,
      );
      expect(r.error, JSON.stringify(p)).toBeDefined();
    }
  });
});

describe('authorization tables: student boundary (RLS)', () => {
  it('a student sees only their own assignment and cannot create or change any', async () => {
    const mine = await runAs(CTX.studentA, 'SELECT user_id FROM app.role_assignments');
    expect(mine.rows.map((r) => r['user_id'])).toEqual([USER_A]);

    const roleA = await roleId(ORG_A, 'COLLEGE_ADMIN');
    const ins = await runAs(
      CTX.studentA,
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
       VALUES ($1, $2, $3, $4, 'ORGANIZATION')`,
      [ASSIGNMENT, ORG_A, USER_A, roleA],
    );
    expect(ins.error?.code).toBe('42501'); // RLS WITH CHECK violation

    const upd = await runAs(CTX.studentA, `UPDATE app.role_assignments SET status = 'REVOKED'`);
    // their own row is visible, but the staff-only WITH CHECK refuses the write
    expect(upd.error?.code).toBe('42501');
  });

  it('a student can read the (non-sensitive) permission matrix of their tenant, nothing else', async () => {
    expect(
      (await runAs(CTX.studentA, 'SELECT 1 FROM app.role_permissions')).rowCount,
    ).toBeGreaterThan(0);
    const w = await runAs(CTX.studentA, `UPDATE app.role_permissions SET scope_mode = 'GRANTED'`);
    expect(w.error?.code).toBe('42501'); // no privilege at all
  });
});

describe('authorization tables: runtime privileges are least-privilege', () => {
  it('app_runtime cannot change the role matrix, delete assignments, or edit immutable columns', async () => {
    const roleA = await roleId(ORG_A, 'STUDENT');
    const denied = [
      `INSERT INTO app.roles (id, organization_id, code, name) VALUES ('${ASSIGNMENT}', '${ORG_A}', 'X', 'X')`,
      `UPDATE app.roles SET name = 'x'`,
      `DELETE FROM app.roles`,
      `UPDATE app.role_permissions SET scope_mode = 'GRANTED'`,
      `DELETE FROM app.role_permissions`,
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode) VALUES ('${ORG_A}', '${roleA}', 'org.settings.read', 'GRANTED')`,
      `DELETE FROM app.role_assignments`,
      `UPDATE app.role_assignments SET user_id = '${STAFF_A}'`,
      `UPDATE app.role_assignments SET role_id = '${roleA}'`,
      `UPDATE app.role_assignments SET scope_type = 'ORGANIZATION'`,
      `UPDATE app.role_assignments SET organization_id = '${ORG_B}'`,
    ];
    for (const sql of denied) {
      const r = await runAs(CTX.staffA, sql);
      expect(r.error?.code, sql).toBe('42501');
    }
  });

  it('the permission catalog is readable but not writable by the runtime role', async () => {
    expect((await runAs(CTX.studentA, 'SELECT code FROM platform.permissions')).rowCount).toBe(12);
    for (const sql of [
      `INSERT INTO platform.permissions (code, sensitivity) VALUES ('x.y.z', 'NORMAL')`,
      `UPDATE platform.permissions SET sensitivity = 'NORMAL'`,
      `DELETE FROM platform.permissions`,
    ]) {
      expect((await runAs(CTX.staffA, sql)).error?.code, sql).toBe('42501');
    }
  });

  it('a role_permission cannot reference a permission that is not in the catalog', async () => {
    const roleA = await roleId(ORG_A, 'STAFF');
    const r = await runStepsAsMigrator(CTX.staffA, [
      [
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode) VALUES ($1, $2, 'made.up.permission', 'SELF')`,
        [ORG_A, roleA],
      ],
    ]);
    expect(r.error).toBeDefined();
  });
});

describe('role_assignments integrity (database-level)', () => {
  // The typed scope column matching the scope type is derived from the scope id, as RoleAssignmentService does.
  const insert = `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, valid_from, valid_until, status)
                  SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $4::text, $5::uuid,
                         CASE WHEN $4::text = 'CAMPUS' THEN $5::uuid END, CASE WHEN $4::text = 'DEPARTMENT' THEN $5::uuid END,
                         $6::timestamptz, $7::timestamptz, $8 FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $9`;
  // Fully explicit typed columns, for the inconsistent combinations the derived form can never produce.
  const insertRaw = `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
                     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $4::text, $5::uuid, $6::uuid, $7::uuid FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'HOD'`;
  const asAdmin = async (sql: string, p: readonly unknown[]): Promise<string | undefined> => {
    try {
      await adminQuery(sql, p);
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  it('scope type/id pairing and the validity window are enforced', async () => {
    const mk = (type: string, id: string | null, from: string, until: string | null) =>
      asAdmin(insert, [ASSIGNMENT, ORG_A, TEMP_A, type, id, from, until, 'ACTIVE', 'HOD']);
    expect(await mk('DEPARTMENT', null, '2030-01-01', null)).toBe('23514'); // dept needs an id
    expect(await mk('ORGANIZATION', CAMPUS_1, '2030-01-01', null)).toBe('23514'); // org must not have one
    expect(await mk('CAMPUS', CAMPUS_1, '2030-01-02', '2030-01-01')).toBe('23514'); // until <= from
    expect(await mk('CAMPUS', CAMPUS_1, '2030-01-01', '2030-01-01')).toBe('23514');
    expect(
      await asAdmin(insert, [
        ASSIGNMENT,
        ORG_A,
        TEMP_A,
        'CAMPUS',
        CAMPUS_1,
        '2030-01-01',
        null,
        'BOGUS',
        'HOD',
      ]),
    ).toBe('23514');
  });

  it('user, role, scope and start are immutable; REVOKED/EXPIRED are terminal; updated_at/version move', async () => {
    await adminQuery(insert, [
      ASSIGNMENT,
      ORG_A,
      TEMP_A,
      'DEPARTMENT',
      DEPT_1,
      '2020-01-01',
      null,
      'ACTIVE',
      'HOD',
    ]);
    try {
      for (const set of [
        `user_id = '${HOD_A}'`,
        `scope_id = '${USER_A}'`,
        `scope_id = '${DEPT_2}'`,
        `department_id = '${DEPT_2}'`, // typed columns are immutable too, even when still consistent elsewhere
        `department_id = NULL`,
        `campus_id = '${CAMPUS_1}'`,
        `scope_type = 'CAMPUS'`,
        `valid_from = now()`,
      ]) {
        expect(
          await asAdmin(`UPDATE app.role_assignments SET ${set} WHERE id = $1`, [ASSIGNMENT]),
          set,
        ).toBe('23001');
      }
      const before = (
        await adminQuery<{ updated_at: Date; version: number }>(
          'SELECT updated_at, version FROM app.role_assignments WHERE id = $1',
          [ASSIGNMENT],
        )
      )[0]!;
      await adminQuery(`UPDATE app.role_assignments SET status = 'REVOKED' WHERE id = $1`, [
        ASSIGNMENT,
      ]);
      const after = (
        await adminQuery<{ updated_at: Date; version: number }>(
          'SELECT updated_at, version FROM app.role_assignments WHERE id = $1',
          [ASSIGNMENT],
        )
      )[0]!;
      expect(after.version).toBe(before.version + 1);
      expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
      expect(
        await asAdmin(`UPDATE app.role_assignments SET status = 'ACTIVE' WHERE id = $1`, [
          ASSIGNMENT,
        ]),
      ).toBe('23001');
    } finally {
      await adminQuery('DELETE FROM app.role_assignments WHERE id = $1', [ASSIGNMENT]);
    }
  });

  it('typed scope columns must agree with scope_type and scope_id (ra_scope_integrity_ck, 0009)', async () => {
    const mk = (type: string, sid: string | null, campus: string | null, dept: string | null) =>
      asAdmin(insertRaw, [ASSIGNMENT, ORG_A, TEMP_A, type, sid, campus, dept]);
    try {
      // consistent combinations are accepted (and removed again)
      const accepted: [string, string | null, string | null, string | null][] = [
        ['ORGANIZATION', null, null, null],
        ['CAMPUS', CAMPUS_1, CAMPUS_1, null],
        ['DEPARTMENT', DEPT_1, null, DEPT_1],
      ];
      for (const ok of accepted) {
        expect(await mk(ok[0], ok[1], ok[2], ok[3]), ok.join()).toBeUndefined();
        await adminQuery('DELETE FROM app.role_assignments WHERE id = $1', [ASSIGNMENT]);
      }
      // every inconsistent combination is a CHECK violation
      expect(await mk('CAMPUS', CAMPUS_1, null, null), 'CAMPUS without campus_id').toBe('23514');
      expect(await mk('DEPARTMENT', DEPT_1, null, null), 'DEPARTMENT without department_id').toBe(
        '23514',
      );
      expect(await mk('CAMPUS', CAMPUS_1, CAMPUS_2, null), 'campus_id <> scope_id').toBe('23514');
      expect(await mk('DEPARTMENT', DEPT_1, null, DEPT_2), 'department_id <> scope_id').toBe(
        '23514',
      );
      expect(await mk('CAMPUS', CAMPUS_1, CAMPUS_1, DEPT_1), 'CAMPUS with department_id').toBe(
        '23514',
      );
      expect(await mk('DEPARTMENT', DEPT_1, CAMPUS_1, DEPT_1), 'DEPARTMENT with campus_id').toBe(
        '23514',
      );
      expect(await mk('ORGANIZATION', null, CAMPUS_1, null), 'ORGANIZATION with campus_id').toBe(
        '23514',
      );
      expect(await mk('ORGANIZATION', null, null, DEPT_1), 'ORGANIZATION with department_id').toBe(
        '23514',
      );
    } finally {
      await adminQuery('DELETE FROM app.role_assignments WHERE id = $1', [ASSIGNMENT]);
    }
  });

  it('a typed scope column cannot point at another tenant (composite foreign keys)', async () => {
    const mk = (type: string, id: string, campus: string | null, dept: string | null) =>
      asAdmin(insertRaw, [ASSIGNMENT, ORG_A, TEMP_A, type, id, campus, dept]);
    try {
      expect(await mk('CAMPUS', CAMPUS_B1, CAMPUS_B1, null)).toBe('23503');
      expect(await mk('DEPARTMENT', DEPT_B1, null, DEPT_B1)).toBe('23503');
      expect(await mk('CAMPUS', UNKNOWN_V7, UNKNOWN_V7, null)).toBe('23503');
    } finally {
      await adminQuery('DELETE FROM app.role_assignments WHERE id = $1', [ASSIGNMENT]);
    }
  });

  it('the runtime role cannot write the typed scope columns after creation', async () => {
    for (const col of ['campus_id', 'department_id', 'scope_id']) {
      const r = await runAs(CTX.staffA, `UPDATE app.role_assignments SET ${col} = NULL`);
      expect(r.error?.code, col).toBe('42501');
    }
  });

  it('id and organization_id are immutable', async () => {
    expect(await asAdmin(`UPDATE app.role_assignments SET organization_id = '${ORG_B}'`, [])).toBe(
      '23001',
    );
  });
});

describe('no accidental probe or debug objects', () => {
  it('every object the migrations added to app/platform is intended', async () => {
    const fns = await adminQuery<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app','platform') ORDER BY 1`,
    );
    expect(fns.map((f) => f.proname)).toEqual([
      'context_ok',
      'current_actor_kind',
      'current_tenant_id',
      'current_user_id',
      'enforce_immutable_keys',
      'get_identity_memberships',
      'reject_audit_mutation',
      'role_assignments_guard',
      'touch_row',
    ]);
    const rels = await adminQuery<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform' AND c.relkind IN ('r','v','m') ORDER BY 1`,
    );
    expect(rels.map((r) => r.relname)).toEqual([
      'auth_sessions',
      'identities',
      'permissions',
      'schema_migrations',
    ]);
  });

  it('sessions carry no authorization data (permissions are resolved server-side per request)', async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'auth_sessions'`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'identity_id',
      'revoked_at',
      'tenant_id',
      'token_hash',
      'version',
    ]);
  });

  it('app_runtime still cannot bypass RLS and is not a superuser', async () => {
    const r = await runAs(
      CTX.staffA,
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
    expect(ids(await runAs({}, 'SELECT organization_id AS id FROM app.role_assignments'))).toEqual(
      [],
    );
    // unused import guard
    expect(runStepsAs).toBeTypeOf('function');
  });
});
