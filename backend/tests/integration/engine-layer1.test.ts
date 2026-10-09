import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { openTenantTx, closeTenantTx, type TenantTx } from '../../src/shared/database/tenant-tx.js';
import { ORG_A, ORG_B, STAFF_B, STUDENT_A, STUDENT_C, USER_A } from '../support/fixtures.js';

// LAYER 1 IN ISOLATION. A superuser connection bypasses RLS entirely, so here the engine's OWN
// tenant predicates are the only thing standing between a context and another tenant's grants.
// (Under app_runtime, RLS would mask a missing predicate; this file exists so that cannot hide it.)
let client: pg.Client;
let tx: TenantTx;
beforeAll(async () => {
  client = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await client.connect();
  tx = openTenantTx(client as never);
});
afterAll(async () => {
  closeTenantTx(tx);
  await client.end();
});

describe('engine tenant boundary without RLS', () => {
  it('grants held in tenant B are never used for a tenant-A context (hasPermission + assert)', async () => {
    // STAFF_B is COLLEGE_ADMIN of tenant B. The context claims tenant A.
    const ctx = issueTrustedContext({ tenantId: ORG_A, userId: STAFF_B, actorKind: 'STAFF' });
    const sanity = issueTrustedContext({ tenantId: ORG_B, userId: STAFF_B, actorKind: 'STAFF' });
    expect(await AuthorizationEngine.hasPermission(tx, sanity, 'student.profile.read')).toBe(true);

    expect(await AuthorizationEngine.hasPermission(tx, ctx, 'student.profile.read')).toBe(false);
    await expect(
      AuthorizationEngine.assert(tx, ctx, 'role.assignment.grant'),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
        organization_id: ORG_A,
        student_id: STUDENT_A,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a student's SELF grant of tenant A is not usable from a tenant-B context", async () => {
    const ctx = issueTrustedContext({ tenantId: ORG_B, userId: USER_A, actorKind: 'STUDENT' });
    await expect(
      AuthorizationEngine.assert(tx, ctx, 'student.profile.read', { student_id: STUDENT_A }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await AuthorizationEngine.hasPermission(tx, ctx, 'session.read')).toBe(false);
  });

  it('the resource tenant claim is checked in the engine too (no RLS involved)', async () => {
    const adminB = issueTrustedContext({ tenantId: ORG_B, userId: STAFF_B, actorKind: 'STAFF' });
    // a tenant-A resource presented to a tenant-B administrator
    await expect(
      AuthorizationEngine.assert(tx, adminB, 'student.profile.read', {
        organization_id: ORG_A,
        student_id: STUDENT_A,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      AuthorizationEngine.assert(tx, adminB, 'student.profile.read', {
        organization_id: ORG_B,
        student_id: STUDENT_C,
      }),
    ).resolves.toBeUndefined();
  });
});
