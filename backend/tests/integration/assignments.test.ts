import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import {
  CAMPUS_1,
  CAMPUS_2,
  CAMPUS_B1,
  CTX,
  DEPT_1,
  DEPT_2,
  DEPT_3,
  DEPT_B1,
  UNKNOWN_V7,
  ORG_A,
  ORG_B,
  STAFF_A,
  GRANTEE_A,
  USER_B,
  type Ctx,
} from '../support/fixtures.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { createPool } from '../../src/shared/database/pool.js';

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

class Rollback extends Error {}
/** Runs `fn` in a tenant transaction that is ALWAYS rolled back, so tests leave no trace. */
async function scratch(
  actor: Ctx,
  fn: (tx: TenantTx, ctx: TrustedContext) => Promise<void>,
): Promise<void> {
  const ctx = issueTrustedContext({
    tenantId: actor.tenant,
    userId: actor.user,
    actorKind: actor.kind,
  });
  await db
    .withTenant(ctx, async (tx) => {
      await fn(tx, ctx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
const REASON = 'Granted during the quarterly access review';
const grantRole = (
  tx: TenantTx,
  ctx: TrustedContext,
  targetUserId: string,
  roleId: string,
  scopeType: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT',
  scopeId?: string,
) =>
  RoleAssignmentService.grant(tx, ctx, {
    targetUserId,
    roleId,
    scopeType,
    ...(scopeId === undefined ? {} : { scopeId }),
    reason: REASON,
  });
const revokeRole = (tx: TenantTx, ctx: TrustedContext, assignmentId: string) =>
  RoleAssignmentService.revoke(tx, ctx, assignmentId, REASON);
const roleId = async (tx: TenantTx, code: string): Promise<string> =>
  (await tx.query<{ id: string }>('SELECT id FROM app.roles WHERE code = $1', [code])).rows[0]!.id;
const status = (p: Promise<unknown>): Promise<number | undefined> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : undefined),
  );

describe('RoleAssignmentService.grant / revoke', () => {
  it('COLLEGE_ADMIN grants, duplicates are 409, revoke works once, then 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const faculty = await roleId(tx, 'FACULTY');
      const id = await grantRole(tx, ctx, GRANTEE_A, faculty, 'ORGANIZATION');
      expect(await status(grantRole(tx, ctx, GRANTEE_A, faculty, 'ORGANIZATION'))).toBe(409);
      // the grant is effective immediately for the target (same transaction)
      const stored = await tx.query(
        'SELECT status, version FROM app.role_assignments WHERE id = $1',
        [id],
      );
      expect(stored.rows[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
      await revokeRole(tx, ctx, id);
      const after = await tx.query(
        'SELECT status, version FROM app.role_assignments WHERE id = $1',
        [id],
      );
      expect(after.rows[0]).toMatchObject({ status: 'REVOKED', version: 2 });
      expect(await status(revokeRole(tx, ctx, id))).toBe(404);
    });
  });

  it('nobody can elevate themselves, and holders without the permission get 403', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(
        await status(grantRole(tx, ctx, STAFF_A, await roleId(tx, 'FACULTY'), 'ORGANIZATION')),
      ).toBe(403);
    });
    for (const actor of [CTX.studentA, CTX.noroleA, CTX.hodA, CTX.facultyA]) {
      await scratch(actor, async (tx, ctx) => {
        expect(
          await status(grantRole(tx, ctx, GRANTEE_A, await roleId(tx, 'STAFF'), 'ORGANIZATION')),
          actor.user,
        ).toBe(403);
      });
    }
  });

  it('grant rules and scope containment bound a CAMPUS_ADMIN (06 §5)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const g = (role: string, type: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT', sid?: string) =>
        status(grantRole(tx, ctx, GRANTEE_A, role, type, sid));
      const staff = await roleId(tx, 'STAFF');
      expect(await g(staff, 'CAMPUS', CAMPUS_1)).toBe(200); // inside own campus, allowed role
      expect(await g(staff, 'CAMPUS', CAMPUS_2)).toBe(403); // another campus
      expect(await g(staff, 'ORGANIZATION')).toBe(403); // wider than own scope
      expect(await g(await roleId(tx, 'FACULTY'), 'DEPARTMENT', DEPT_1)).toBe(403); // dept ⊂ campus cannot be proven yet: fail closed
      expect(await g(await roleId(tx, 'COLLEGE_ADMIN'), 'ORGANIZATION')).toBe(403); // not grantable by campus admin
      expect(await g(await roleId(tx, 'CAMPUS_ADMIN'), 'CAMPUS', CAMPUS_1)).toBe(403); // peers cannot mint peers
    });
  });

  it('a campus admin cannot revoke an organization-wide administrator', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const adminAssignment = (
        await tx.query<{ id: string }>(
          `SELECT ra.id FROM app.role_assignments ra JOIN app.roles r ON r.id = ra.role_id
            WHERE ra.user_id = $1 AND r.code = 'COLLEGE_ADMIN'`,
          [STAFF_A],
        )
      ).rows[0]!.id;
      expect(await status(revokeRole(tx, ctx, adminAssignment))).toBe(403);
    });
  });

  it('nobody revokes their own assignment', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const own = (
        await tx.query<{ id: string }>('SELECT id FROM app.role_assignments WHERE user_id = $1', [
          STAFF_A,
        ])
      ).rows[0]!.id;
      expect(await status(revokeRole(tx, ctx, own))).toBe(403);
    });
  });

  it('role/user ownership: other-tenant or unknown ids are the same 404', async () => {
    const roleB = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'`,
        [ORG_B],
      )
    )[0]!.id;
    await scratch(CTX.staffA, async (tx, ctx) => {
      const staff = await roleId(tx, 'STAFF');
      expect(await status(grantRole(tx, ctx, GRANTEE_A, roleB, 'ORGANIZATION'))).toBe(404); // foreign role
      expect(await status(grantRole(tx, ctx, USER_B, staff, 'ORGANIZATION'))).toBe(404); // foreign user
      expect(
        await status(
          grantRole(tx, ctx, '01939a00-0000-7000-8000-00000000ffff', staff, 'ORGANIZATION'),
        ),
      ).toBe(404);
      expect(await status(revokeRole(tx, ctx, '01939a00-0000-7000-8000-00000000ffff'))).toBe(404);
    });
  });

  it('scope type and scope id must be coherent and valid for the role', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const g = (role: string, type: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT', sid?: string) =>
        status(grantRole(tx, ctx, GRANTEE_A, role, type, sid));
      expect(await g(await roleId(tx, 'HOD'), 'ORGANIZATION')).toBe(400); // HOD requires DEPARTMENT
      expect(await g(await roleId(tx, 'COLLEGE_ADMIN'), 'DEPARTMENT', DEPT_1)).toBe(400);
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT')).toBe(400); // missing id
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT', 'not-a-uuid')).toBe(400);
      expect(await g(await roleId(tx, 'STAFF'), 'ORGANIZATION', DEPT_1)).toBe(400); // org scope takes no id
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT', DEPT_1)).toBe(200);
    });
  });

  it('scoped grants write scope_id AND the matching typed column, nothing else', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const typed = async (id: string) =>
        (
          await tx.query(
            'SELECT scope_type, scope_id, campus_id, department_id FROM app.role_assignments WHERE id = $1',
            [id],
          )
        ).rows[0];
      const staff = await roleId(tx, 'STAFF');
      const org = await grantRole(tx, ctx, GRANTEE_A, staff, 'ORGANIZATION');
      expect(await typed(org)).toEqual({
        scope_type: 'ORGANIZATION',
        scope_id: null,
        campus_id: null,
        department_id: null,
      });
      const campus = await grantRole(tx, ctx, GRANTEE_A, staff, 'CAMPUS', CAMPUS_1);
      expect(await typed(campus)).toEqual({
        scope_type: 'CAMPUS',
        scope_id: CAMPUS_1,
        campus_id: CAMPUS_1,
        department_id: null,
      });
      const dept = await grantRole(
        tx,
        ctx,
        GRANTEE_A,
        await roleId(tx, 'HOD'),
        'DEPARTMENT',
        DEPT_1,
      );
      expect(await typed(dept)).toEqual({
        scope_type: 'DEPARTMENT',
        scope_id: DEPT_1,
        campus_id: null,
        department_id: DEPT_1,
      });
    });
  });

  it('an unknown, other-tenant or deleted campus/department is the same safe 404, not a database error', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const g = (role: string, type: 'CAMPUS' | 'DEPARTMENT', sid: string) =>
        status(grantRole(tx, ctx, GRANTEE_A, role, type, sid));
      const staff = await roleId(tx, 'STAFF');
      const hod = await roleId(tx, 'HOD');
      expect(await g(staff, 'CAMPUS', UNKNOWN_V7)).toBe(404);
      expect(await g(staff, 'CAMPUS', CAMPUS_B1)).toBe(404); // exists, but in tenant B
      expect(await g(hod, 'DEPARTMENT', UNKNOWN_V7)).toBe(404);
      expect(await g(hod, 'DEPARTMENT', DEPT_B1)).toBe(404);
      expect(await g(hod, 'DEPARTMENT', CAMPUS_1)).toBe(404); // a campus id is not a department id
      expect(await g(staff, 'CAMPUS', DEPT_1)).toBe(404); // a department id is not a campus id
      // a soft-deleted department is gone as far as new grants are concerned
      await tx.query('UPDATE app.departments SET deleted_at = now() WHERE id = $1', [DEPT_1]);
      expect(await g(hod, 'DEPARTMENT', DEPT_1)).toBe(404);
    });
  });

  it('new grants to inactive scopes are the same 404; existing assignments and revoke are unaffected', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const g = (role: string, type: 'CAMPUS' | 'DEPARTMENT', sid: string) =>
        status(grantRole(tx, ctx, GRANTEE_A, role, type, sid));
      const staff = await roleId(tx, 'STAFF');
      const hod = await roleId(tx, 'HOD');
      // granted while active, then the scopes are deactivated
      const onCampus = await grantRole(tx, ctx, GRANTEE_A, staff, 'CAMPUS', CAMPUS_2);
      const onDept = await grantRole(tx, ctx, GRANTEE_A, hod, 'DEPARTMENT', DEPT_3);

      await tx.query(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [DEPT_2]);
      expect(await g(hod, 'DEPARTMENT', DEPT_2)).toBe(404); // inactive department
      expect(await g(hod, 'DEPARTMENT', DEPT_1)).toBe(200); // sibling in the same campus is fine

      await tx.query(`UPDATE app.campuses SET status = 'INACTIVE' WHERE id = $1`, [CAMPUS_2]);
      expect(await g(staff, 'CAMPUS', CAMPUS_2)).toBe(404); // inactive campus
      expect(await g(hod, 'DEPARTMENT', DEPT_3)).toBe(404); // ACTIVE department under an inactive campus

      const stored = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM app.role_assignments WHERE id = ANY($1::uuid[])',
        [[onCampus, onDept]],
      );
      expect(stored.rows.map((r) => r.status)).toEqual(['ACTIVE', 'ACTIVE']);
      await revokeRole(tx, ctx, onCampus); // revoke still works on an inactive scope
      await revokeRole(tx, ctx, onDept);
    });
  });

  it('scope existence is not revealed to a grantor who may not manage that scope', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const staff = await roleId(tx, 'STAFF');
      // outside the admin's campus: 403 whether the campus exists (CAMPUS_2, CAMPUS_B1) or not
      for (const id of [CAMPUS_2, CAMPUS_B1, UNKNOWN_V7]) {
        expect(await status(grantRole(tx, ctx, GRANTEE_A, staff, 'CAMPUS', id)), id).toBe(403);
      }
    });
  });

  it('a granted assignment is effective for the target and a revoked one is not', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await grantRole(tx, ctx, GRANTEE_A, await roleId(tx, 'HOD'), 'DEPARTMENT', DEPT_1);
      const target = issueTrustedContext({
        tenantId: ORG_A,
        userId: GRANTEE_A,
        actorKind: 'STAFF',
      });
      // same transaction, evaluated for the target user
      expect(await AuthorizationEngine.hasPermission(tx, target, 'student.profile.read')).toBe(
        true,
      );
      await revokeRole(tx, ctx, id);
      expect(await AuthorizationEngine.hasPermission(tx, target, 'student.profile.read')).toBe(
        false,
      );
    });
  });
});
