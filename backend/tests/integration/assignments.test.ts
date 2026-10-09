import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import {
  CAMPUS_1,
  CAMPUS_2,
  CTX,
  DEPT_1,
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
      const id = await RoleAssignmentService.grant(tx, ctx, GRANTEE_A, faculty, 'ORGANIZATION');
      expect(
        await status(RoleAssignmentService.grant(tx, ctx, GRANTEE_A, faculty, 'ORGANIZATION')),
      ).toBe(409);
      // the grant is effective immediately for the target (same transaction)
      const stored = await tx.query(
        'SELECT status, version FROM app.role_assignments WHERE id = $1',
        [id],
      );
      expect(stored.rows[0]).toMatchObject({ status: 'ACTIVE', version: 1 });
      await RoleAssignmentService.revoke(tx, ctx, id);
      const after = await tx.query(
        'SELECT status, version FROM app.role_assignments WHERE id = $1',
        [id],
      );
      expect(after.rows[0]).toMatchObject({ status: 'REVOKED', version: 2 });
      expect(await status(RoleAssignmentService.revoke(tx, ctx, id))).toBe(404);
    });
  });

  it('nobody can elevate themselves, and holders without the permission get 403', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(
        await status(
          RoleAssignmentService.grant(
            tx,
            ctx,
            STAFF_A,
            await roleId(tx, 'FACULTY'),
            'ORGANIZATION',
          ),
        ),
      ).toBe(403);
    });
    for (const actor of [CTX.studentA, CTX.noroleA, CTX.hodA, CTX.facultyA]) {
      await scratch(actor, async (tx, ctx) => {
        expect(
          await status(
            RoleAssignmentService.grant(
              tx,
              ctx,
              GRANTEE_A,
              await roleId(tx, 'STAFF'),
              'ORGANIZATION',
            ),
          ),
          actor.user,
        ).toBe(403);
      });
    }
  });

  it('grant rules and scope containment bound a CAMPUS_ADMIN (06 §5)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const g = (role: string, type: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT', sid?: string) =>
        status(RoleAssignmentService.grant(tx, ctx, GRANTEE_A, role, type, sid));
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
      expect(await status(RoleAssignmentService.revoke(tx, ctx, adminAssignment))).toBe(403);
    });
  });

  it('nobody revokes their own assignment', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const own = (
        await tx.query<{ id: string }>('SELECT id FROM app.role_assignments WHERE user_id = $1', [
          STAFF_A,
        ])
      ).rows[0]!.id;
      expect(await status(RoleAssignmentService.revoke(tx, ctx, own))).toBe(403);
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
      expect(
        await status(RoleAssignmentService.grant(tx, ctx, GRANTEE_A, roleB, 'ORGANIZATION')),
      ).toBe(404); // foreign role
      expect(
        await status(RoleAssignmentService.grant(tx, ctx, USER_B, staff, 'ORGANIZATION')),
      ).toBe(404); // foreign user
      expect(
        await status(
          RoleAssignmentService.grant(
            tx,
            ctx,
            '01939a00-0000-7000-8000-00000000ffff',
            staff,
            'ORGANIZATION',
          ),
        ),
      ).toBe(404);
      expect(
        await status(RoleAssignmentService.revoke(tx, ctx, '01939a00-0000-7000-8000-00000000ffff')),
      ).toBe(404);
    });
  });

  it('scope type and scope id must be coherent and valid for the role', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const g = (role: string, type: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT', sid?: string) =>
        status(RoleAssignmentService.grant(tx, ctx, GRANTEE_A, role, type, sid));
      expect(await g(await roleId(tx, 'HOD'), 'ORGANIZATION')).toBe(400); // HOD requires DEPARTMENT
      expect(await g(await roleId(tx, 'COLLEGE_ADMIN'), 'DEPARTMENT', DEPT_1)).toBe(400);
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT')).toBe(400); // missing id
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT', 'not-a-uuid')).toBe(400);
      expect(await g(await roleId(tx, 'STAFF'), 'ORGANIZATION', DEPT_1)).toBe(400); // org scope takes no id
      expect(await g(await roleId(tx, 'HOD'), 'DEPARTMENT', DEPT_1)).toBe(200);
    });
  });

  it('a granted assignment is effective for the target and a revoked one is not', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await RoleAssignmentService.grant(
        tx,
        ctx,
        GRANTEE_A,
        await roleId(tx, 'HOD'),
        'DEPARTMENT',
        DEPT_1,
      );
      const target = issueTrustedContext({
        tenantId: ORG_A,
        userId: GRANTEE_A,
        actorKind: 'STAFF',
      });
      // same transaction, evaluated for the target user
      expect(await AuthorizationEngine.hasPermission(tx, target, 'student.profile.read')).toBe(
        true,
      );
      await RoleAssignmentService.revoke(tx, ctx, id);
      expect(await AuthorizationEngine.hasPermission(tx, target, 'student.profile.read')).toBe(
        false,
      );
    });
  });
});
