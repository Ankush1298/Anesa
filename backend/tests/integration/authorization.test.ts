import { describe, it, expect, afterAll, inject } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { CTX, STUDENT_A, STUDENT_B } from '../support/fixtures.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';

describe('AuthorizationEngine', () => {
  const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
  const db = new Database(pool);

  afterAll(async () => {
    await db.close();
  });

  it('allows STUDENT role to access their own profile (SELF)', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.studentA.tenant,
      userId: CTX.studentA.user,
      actorKind: 'STUDENT',
    });

    await db.withTenant(ctx, async (tx) => {
      const hasPerm = await AuthorizationEngine.hasPermission(tx, ctx, 'student.profile.read');
      expect(hasPerm).toBe(true);

      // Should succeed for own student_id
      await expect(
        AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
          student_id: STUDENT_A,
        }),
      ).resolves.not.toThrow();

      // Should fail for other student_id (resource-not-found)
      const err = await AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
        student_id: STUDENT_B,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    });
  });

  it('allows CAMPUS_ADMIN role to access any profile in scope (GRANTED)', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.staffA.tenant,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });

    await db.withTenant(ctx, async (tx) => {
      const hasPerm = await AuthorizationEngine.hasPermission(tx, ctx, 'student.profile.read');
      expect(hasPerm).toBe(true);

      // Should succeed for any student in org (granted ORGANIZATION scope)
      await expect(
        AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
          student_id: STUDENT_A,
        }),
      ).resolves.not.toThrow();

      await expect(
        AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
          student_id: STUDENT_B,
        }),
      ).resolves.not.toThrow();
    });
  });

  it('denies access if permission not held at all', async () => {
    const ctx = issueTrustedContext({
      tenantId: CTX.studentA.tenant,
      userId: CTX.studentA.user,
      actorKind: 'STUDENT',
    });

    await db.withTenant(ctx, async (tx) => {
      const hasPerm = await AuthorizationEngine.hasPermission(tx, ctx, 'org.campus.manage');
      expect(hasPerm).toBe(false);

      const err = await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
    });
  });

  it('denies access if resource lacks required scope matching', async () => {
    // studentC trying to access studentA
    const ctx = issueTrustedContext({
      tenantId: CTX.studentC.tenant,
      userId: CTX.studentC.user,
      actorKind: 'STUDENT',
    });

    await db.withTenant(ctx, async (tx) => {
      // Trying to access another tenant's student will fail at the TenantTx level anyway,
      // but even if it was same tenant, the scope is SELF so it won't match student_id.
      // Let's assert studentC can't access STUDENT_A (which is different tenant, but structurally checks SELF)
      const err = await AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
        student_id: STUDENT_A,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    });
  });
});
