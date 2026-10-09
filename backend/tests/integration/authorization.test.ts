import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  AuthorizationEngine,
  clearAssignedResolvers,
  registerAssignedResolver,
  type ResourceScope,
} from '../../src/shared/authorization/engine.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  CAMPUS_1,
  CAMPUS_2,
  CTX,
  DEPT_1,
  DEPT_2,
  DEPT_3,
  ORG_A,
  ORG_B,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
  TEMP_A,
  UNKNOWN_V7,
  type Ctx,
} from '../support/fixtures.js';
import { adminQuery } from '../support/db-harness.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';

type Outcome = 'ALLOW' | 403 | 404;

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

async function decide(actor: Ctx, permission: string, resource?: ResourceScope): Promise<Outcome> {
  const ctx = issueTrustedContext({
    tenantId: actor.tenant,
    userId: actor.user,
    actorKind: actor.kind,
  });
  return db.withTenant(ctx, async (tx) => {
    try {
      await AuthorizationEngine.assert(tx, ctx, permission, resource);
      return 'ALLOW';
    } catch (e) {
      if (e instanceof AppError) return e.statusCode as Outcome;
      throw e;
    }
  });
}

// Trusted attributes of "loaded" resources. Student programs/departments are future domain tables;
// these small fixtures stand in for the row a repository would have loaded under RLS.
const stu = (student_id: string, org: string, campus?: string, dept?: string): ResourceScope => ({
  student_id,
  organization_id: org,
  ...(campus ? { campus_id: campus } : {}),
  ...(dept ? { department_id: dept } : {}),
});
const A_DEPT1 = stu(STUDENT_A, ORG_A, CAMPUS_1, DEPT_1);
const B_DEPT2 = stu(STUDENT_B, ORG_A, CAMPUS_1, DEPT_2);
const X_DEPT3 = stu('01939a00-0000-7000-8000-00000000a5ff', ORG_A, CAMPUS_2, DEPT_3);
const C_ORGB = stu(STUDENT_C, ORG_B, CAMPUS_1, DEPT_1); // same campus/department ids, other tenant

interface Row {
  actor: keyof typeof CTX;
  role: string;
  permission: string;
  scope: string;
  resource: string;
  res?: ResourceScope;
  expect: Outcome;
}
const P = 'student.profile.read';
const matrix: Row[] = [
  // ---- student: SELF
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'own profile',
    res: A_DEPT1,
    expect: 'ALLOW',
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'other student, same tenant',
    res: B_DEPT2,
    expect: 404,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'student of another tenant',
    res: C_ORGB,
    expect: 404,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'nonexistent student',
    res: stu(UNKNOWN_V7, ORG_A),
    expect: 404,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'own id but foreign tenant claim',
    res: stu(STUDENT_A, ORG_B),
    expect: 404,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'student.profile.read_sensitive',
    scope: 'SELF',
    resource: 'own sensitive data',
    res: A_DEPT1,
    expect: 'ALLOW',
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'student.profile.read_sensitive',
    scope: 'SELF',
    resource: 'other student sensitive',
    res: B_DEPT2,
    expect: 404,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'session.read',
    scope: 'SELF',
    resource: 'own session list',
    res: { user_id: CTX.studentA.user, organization_id: ORG_A },
    expect: 'ALLOW',
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'session.read',
    scope: 'SELF',
    resource: "another user's sessions",
    res: { user_id: CTX.studentB.user, organization_id: ORG_A },
    expect: 404,
  },
  {
    actor: 'studentB',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'own profile (student B)',
    res: B_DEPT2,
    expect: 'ALLOW',
  },
  {
    actor: 'studentB',
    role: 'STUDENT',
    permission: P,
    scope: 'SELF',
    resource: 'student A profile',
    res: A_DEPT1,
    expect: 404,
  },
  // ---- missing permission / role without permission
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'org.campus.manage',
    scope: '-',
    resource: 'action endpoint',
    expect: 403,
  },
  {
    actor: 'studentA',
    role: 'STUDENT',
    permission: 'org.campus.manage',
    scope: '-',
    resource: 'campus resource',
    res: stu(UNKNOWN_V7, ORG_A, CAMPUS_1),
    expect: 404,
  },
  {
    actor: 'noroleA',
    role: '(none)',
    permission: P,
    scope: '-',
    resource: 'action endpoint',
    expect: 403,
  },
  {
    actor: 'noroleA',
    role: '(none)',
    permission: P,
    scope: '-',
    resource: 'student A profile',
    res: A_DEPT1,
    expect: 404,
  },
  {
    actor: 'facultyA',
    role: 'FACULTY',
    permission: P,
    scope: '- (not seeded until M3)',
    resource: 'student A profile',
    res: A_DEPT1,
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: 'student.profile.read_sensitive',
    scope: '-',
    resource: 'dept-1 student, sensitive',
    res: A_DEPT1,
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: 'role.assignment.grant',
    scope: '-',
    resource: 'action endpoint',
    expect: 403,
  },
  // ---- HOD: GRANTED within DEPARTMENT(DEPT_1)
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'student in D1',
    res: A_DEPT1,
    expect: 'ALLOW',
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'student in D2 (same campus)',
    res: B_DEPT2,
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'student in D3 (other campus)',
    res: X_DEPT3,
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'student with no department',
    res: stu(STUDENT_A, ORG_A, CAMPUS_1),
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'D1 id but other tenant',
    res: C_ORGB,
    expect: 404,
  },
  {
    actor: 'hodA',
    role: 'HOD',
    permission: P,
    scope: 'GRANTED/DEPARTMENT D1',
    resource: 'no organization_id supplied',
    res: { student_id: STUDENT_A, department_id: DEPT_1 },
    expect: 404,
  },
  // ---- CAMPUS_ADMIN: GRANTED within CAMPUS(CAMPUS_1)
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: P,
    scope: 'GRANTED/CAMPUS C1',
    resource: 'student in C1/D1',
    res: A_DEPT1,
    expect: 'ALLOW',
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: P,
    scope: 'GRANTED/CAMPUS C1',
    resource: 'student in C1/D2',
    res: B_DEPT2,
    expect: 'ALLOW',
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: P,
    scope: 'GRANTED/CAMPUS C1',
    resource: 'student in C2',
    res: X_DEPT3,
    expect: 404,
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: P,
    scope: 'GRANTED/CAMPUS C1',
    resource: 'department id only (no campus)',
    res: stu(STUDENT_A, ORG_A, undefined, DEPT_1),
    expect: 404,
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: P,
    scope: 'GRANTED/CAMPUS C1',
    resource: 'C1 id but other tenant',
    res: C_ORGB,
    expect: 404,
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: 'org.settings.read',
    scope: 'GRANTED/CAMPUS C1',
    resource: 'org settings of own tenant, campus C1',
    res: { organization_id: ORG_A, campus_id: CAMPUS_1 },
    expect: 'ALLOW',
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: 'org.campus.manage',
    scope: 'GRANTED/CAMPUS C1',
    resource: 'own campus C1',
    res: { organization_id: ORG_A, campus_id: CAMPUS_1 },
    expect: 'ALLOW',
  },
  {
    actor: 'campusAdminA',
    role: 'CAMPUS_ADMIN',
    permission: 'org.campus.manage',
    scope: 'GRANTED/CAMPUS C1',
    resource: 'another campus C2',
    res: { organization_id: ORG_A, campus_id: CAMPUS_2 },
    expect: 404,
  },

  // ---- COLLEGE_ADMIN: GRANTED within ORGANIZATION
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'any student of own org (C1/D1)',
    res: A_DEPT1,
    expect: 'ALLOW',
  },
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'any student of own org (C2/D3)',
    res: X_DEPT3,
    expect: 'ALLOW',
  },
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'student of another tenant',
    res: C_ORGB,
    expect: 404,
  },
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'no organization_id supplied',
    res: { student_id: STUDENT_A },
    expect: 404,
  },
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: 'org.campus.manage',
    scope: 'GRANTED/ORGANIZATION',
    resource: 'campus of own org',
    res: { organization_id: ORG_A, campus_id: CAMPUS_2 },
    expect: 'ALLOW',
  },
  {
    actor: 'staffB',
    role: 'COLLEGE_ADMIN (tenant B)',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'student of tenant A',
    res: A_DEPT1,
    expect: 404,
  },
  {
    actor: 'staffB',
    role: 'COLLEGE_ADMIN (tenant B)',
    permission: P,
    scope: 'GRANTED/ORGANIZATION',
    resource: 'own tenant student',
    res: C_ORGB,
    expect: 'ALLOW',
  },
  {
    actor: 'staffA',
    role: 'COLLEGE_ADMIN',
    permission: 'role.assignment.grant',
    scope: 'GRANTED/ORGANIZATION',
    resource: 'action endpoint',
    expect: 'ALLOW',
  },
];

describe('authorization matrix (real PostgreSQL, real engine)', () => {
  it.each(matrix)('$actor [$role] $permission [$scope] on $resource -> $expect', async (row) => {
    expect(await decide(CTX[row.actor], row.permission, row.res)).toBe(row.expect);
  });

  it('out-of-scope and nonexistent resources are the same AppError (status, code, message)', async () => {
    const ctx = issueTrustedContext({
      tenantId: ORG_A,
      userId: CTX.studentA.user,
      actorKind: 'STUDENT',
    });
    const grab = (r: ResourceScope) =>
      db.withTenant(ctx, async (tx) => {
        const e = await AuthorizationEngine.assert(tx, ctx, P, r).then(
          () => 'ALLOWED' as const,
          (x: unknown) => x,
        );
        expect(e, 'access must be denied').toBeInstanceOf(AppError);
        const err = e as AppError;
        return { s: err.statusCode, c: err.code, m: err.message };
      });
    const hidden = await grab(B_DEPT2);
    expect(await grab(stu(UNKNOWN_V7, ORG_A))).toEqual(hidden);
    expect(await grab(C_ORGB)).toEqual(hidden);
    expect(hidden).toMatchObject({ s: 404, c: 'RESOURCE_NOT_FOUND' });
  });

  it('rejects an unknown permission code and an uncatalogued role-name shortcut', async () => {
    const ctx = issueTrustedContext({
      tenantId: ORG_A,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });
    await db.withTenant(ctx, async (tx) => {
      await expect(AuthorizationEngine.assert(tx, ctx, 'admin')).rejects.toMatchObject({
        statusCode: 500,
      });
      await expect(AuthorizationEngine.hasPermission(tx, ctx, 'made.up')).rejects.toMatchObject({
        statusCode: 500,
      });
    });
  });

  it('refuses a context that was not issued by the trusted issuer', async () => {
    const forged = { tenantId: ORG_A, userId: CTX.staffA.user, actorKind: 'STAFF' } as never;
    await expect(db.withTenant(forged, () => Promise.resolve())).rejects.toMatchObject({
      code: 'UNTRUSTED_CONTEXT',
    });
    const real = issueTrustedContext({
      tenantId: ORG_A,
      userId: CTX.noroleA.user,
      actorKind: 'STAFF',
    });
    await db.withTenant(real, async (tx) => {
      expect(await AuthorizationEngine.hasPermission(tx, forged, 'org.settings.read')).toBe(false);
      await expect(
        AuthorizationEngine.assert(tx, forged, 'org.settings.read'),
      ).rejects.toMatchObject({ code: 'UNTRUSTED_CONTEXT' });
    });
  });
});

describe('ASSIGNED scope (resolver contract, stub relationship)', () => {
  let facultyRole: string;
  beforeAll(async () => {
    // FACULTY student.profile.read is intentionally not in the seeded matrix (doc 10 ¹); the contract is
    // exercised with an explicit test-only grant, removed afterwards.
    facultyRole = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'FACULTY'`,
        [ORG_A],
      )
    )[0]!.id;
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode) VALUES ($1, $2, 'student.profile.read', 'ASSIGNED')`,
      [ORG_A, facultyRole],
    );
  });
  afterAll(async () => {
    clearAssignedResolvers();
    await adminQuery(
      `DELETE FROM app.role_permissions WHERE role_id = $1 AND permission_code = 'student.profile.read'`,
      [facultyRole],
    );
  });
  afterEach(clearAssignedResolvers);

  it('with no resolver registered ASSIGNED denies everything (fail closed)', async () => {
    expect(await decide(CTX.facultyA, P, A_DEPT1)).toBe(404);
  });

  it('allows exactly the resources the resolver proves are assigned to the actor', async () => {
    const assigned = new Set([STUDENT_A]); // stub "faculty_assignments"
    registerAssignedResolver(P, (_tx, ctx, r) =>
      Promise.resolve(
        ctx.userId === CTX.facultyA.user && !!r.student_id && assigned.has(r.student_id),
      ),
    );
    expect(await decide(CTX.facultyA, P, A_DEPT1)).toBe('ALLOW');
    expect(await decide(CTX.facultyA, P, B_DEPT2)).toBe(404);
    expect(await decide(CTX.facultyA, P, C_ORGB)).toBe(404);
    // another actor holding no ASSIGNED grant is not helped by the resolver existing
    expect(await decide(CTX.noroleA, P, A_DEPT1)).toBe(404);
    expect(await decide(CTX.studentB, P, A_DEPT1)).toBe(404);
  });
});

describe('assignment validity (revoked / expired / future / multiple roles)', () => {
  const inserted: string[] = [];
  let n = 0;
  const give = async (
    role: string,
    scopeType: string,
    scopeId: string | null,
    o: { status?: string; from?: string; until?: string | null } = {},
  ): Promise<void> => {
    const id = `01939a00-0000-7000-8000-00000000e${String(++n).padStart(3, '0')}`;
    inserted.push(id);
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, status, valid_from, valid_until)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $4::text, $5::uuid,
              CASE WHEN $4::text = 'CAMPUS' THEN $5::uuid END, CASE WHEN $4::text = 'DEPARTMENT' THEN $5::uuid END,
              $6, ${o.from ?? 'now()'}, ${o.until === undefined || o.until === null ? 'NULL' : o.until}
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $7`,
      [id, ORG_A, TEMP_A, scopeType, scopeId, o.status ?? 'ACTIVE', role],
    );
  };
  afterEach(async () => {
    await adminQuery('DELETE FROM app.role_assignments WHERE id = ANY($1::uuid[])', [
      inserted.splice(0),
    ]);
  });

  it.each([
    ['active, open-ended', {}, 'ALLOW'],
    ['active, ends in the future', { until: "now() + interval '1 day'" }, 'ALLOW'],
    ['starts one day ago', { from: "now() - interval '1 day'" }, 'ALLOW'],
    ['status REVOKED', { status: 'REVOKED' }, 404],
    ['status EXPIRED', { status: 'EXPIRED' }, 404],
    [
      'ended in the past (status still ACTIVE)',
      { from: "now() - interval '2 days'", until: "now() - interval '1 day'" },
      404,
    ],
    ['future-dated (not started yet)', { from: "now() + interval '1 day'" }, 404],
  ] as const)('COLLEGE_ADMIN assignment: %s -> %s', async (_name, opts, expected) => {
    await give('COLLEGE_ADMIN', 'ORGANIZATION', null, opts);
    expect(await decide(CTX.tempA, P, A_DEPT1)).toBe(expected);
  });

  it('a user with no effective assignment has no capability at all (403 on action endpoints)', async () => {
    await give('COLLEGE_ADMIN', 'ORGANIZATION', null, { status: 'REVOKED' });
    expect(await decide(CTX.tempA, 'role.assignment.grant')).toBe(403);
  });

  it('multiple roles resolve as a union, independent of assignment order', async () => {
    await give('HOD', 'DEPARTMENT', DEPT_1);
    await give('HOD', 'DEPARTMENT', DEPT_2);
    await give('STAFF', 'ORGANIZATION', null);
    const first = [
      await decide(CTX.tempA, P, A_DEPT1),
      await decide(CTX.tempA, P, B_DEPT2),
      await decide(CTX.tempA, P, X_DEPT3),
    ];
    expect(first).toEqual(['ALLOW', 'ALLOW', 404]);
    await adminQuery('DELETE FROM app.role_assignments WHERE id = ANY($1::uuid[])', [
      inserted.splice(0),
    ]);
    await give('STAFF', 'ORGANIZATION', null);
    await give('HOD', 'DEPARTMENT', DEPT_2);
    await give('HOD', 'DEPARTMENT', DEPT_1);
    expect([
      await decide(CTX.tempA, P, A_DEPT1),
      await decide(CTX.tempA, P, B_DEPT2),
      await decide(CTX.tempA, P, X_DEPT3),
    ]).toEqual(first);
  });

  it('a revoked broad role does not hide a still-active narrow one', async () => {
    await give('COLLEGE_ADMIN', 'ORGANIZATION', null, { status: 'REVOKED' });
    await give('HOD', 'DEPARTMENT', DEPT_1);
    expect(await decide(CTX.tempA, P, A_DEPT1)).toBe('ALLOW');
    expect(await decide(CTX.tempA, P, X_DEPT3)).toBe(404);
  });
});
