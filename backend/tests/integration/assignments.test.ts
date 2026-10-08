import { describe, it, expect, afterAll, inject } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { CTX, USER_A, USER_B } from '../support/fixtures.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';

describe('RoleAssignmentService', () => {
  const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
  const db = new Database(pool);

  afterAll(async () => {
    await db.close();
  });

  it('allows CAMPUS_ADMIN to grant a role', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.staffA.tenant,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });

    await db.withTenant(ctx, async (tx) => {
      // Find a role to grant
      const res = await tx.query(`SELECT id FROM app.roles WHERE code = 'FACULTY' LIMIT 1`);
      const roleId = res.rows[0]?.id as string;

      // Grant FACULTY to USER_A
      const assignmentId = await RoleAssignmentService.grant(
        tx,
        ctx,
        USER_A,
        roleId,
        'ORGANIZATION',
      );
      expect(assignmentId).toBeDefined();

      // Attempt duplicate
      const err = await RoleAssignmentService.grant(tx, ctx, USER_A, roleId, 'ORGANIZATION').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);

      // Revoke
      await expect(RoleAssignmentService.revoke(tx, ctx, assignmentId)).resolves.not.toThrow();

      // Revoke again should fail (404)
      const err2 = await RoleAssignmentService.revoke(tx, ctx, assignmentId).catch(
        (e: unknown) => e,
      );
      expect(err2).toBeInstanceOf(AppError);
      expect((err2 as AppError).statusCode).toBe(404);
    });
  });

  it('prevents self-elevation', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.staffA.tenant,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });

    await db.withTenant(ctx, async (tx) => {
      const res = await tx.query(`SELECT id FROM app.roles WHERE code = 'FACULTY' LIMIT 1`);
      const roleId = res.rows[0]?.id as string;

      const err = await RoleAssignmentService.grant(
        tx,
        ctx,
        CTX.staffA.user,
        roleId,
        'ORGANIZATION',
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
    });
  });

  it('prevents users without grant permissions from granting', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.studentA.tenant,
      userId: CTX.studentA.user,
      actorKind: 'STUDENT',
    });

    await db.withTenant(ctx, async (tx) => {
      const res = await tx.query(`SELECT id FROM app.roles WHERE code = 'FACULTY' LIMIT 1`);
      const roleId = res.rows[0]?.id as string;

      const err = await RoleAssignmentService.grant(tx, ctx, USER_B, roleId, 'ORGANIZATION').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    });
  });
});
