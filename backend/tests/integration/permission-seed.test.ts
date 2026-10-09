import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG } from '../../src/shared/authorization/catalog.js';
import { ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { seedTenantRoles } from '../../src/shared/authorization/seed.js';
import { adminQuery } from '../support/db-harness.js';
import { ORG_C } from '../support/fixtures.js';

// ORG_C is the tenant reserved for tests that commit writes.
const exec = {
  query: async (text: string, values?: readonly unknown[]) => ({
    rows: await adminQuery(text, values ?? []),
  }),
};
const snapshot = async (): Promise<string> =>
  JSON.stringify(
    await adminQuery(
      `SELECT r.id, r.code, r.version, p.permission_code, p.scope_mode FROM app.roles r
         LEFT JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id
        WHERE r.organization_id = $1 ORDER BY r.code, p.permission_code`,
      [ORG_C],
    ),
  );

describe('permission seed', () => {
  it('platform.permissions equals the code catalog exactly', async () => {
    const rows = await adminQuery<{ code: string; sensitivity: string }>(
      'SELECT code, sensitivity FROM platform.permissions ORDER BY code',
    );
    expect(rows).toEqual(
      [...PERMISSION_CATALOG]
        .sort((a, b) => a.code.localeCompare(b.code, 'en'))
        .map((p) => ({ code: p.code, sensitivity: p.sensitivity })),
    );
  });

  it('the seeded fixtures equal ROLE_MATRIX and seeding is idempotent (same rows, same ids, no version churn)', async () => {
    await seedTenantRoles(exec, ORG_C);
    const first = await snapshot();
    await seedTenantRoles(exec, ORG_C);
    expect(await snapshot()).toBe(first);

    const got = await adminQuery<{
      code: string;
      permission_code: string | null;
      scope_mode: string | null;
    }>(
      `SELECT r.code, p.permission_code, p.scope_mode FROM app.roles r
         LEFT JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id WHERE r.organization_id = $1`,
      [ORG_C],
    );
    const actual: Record<string, Record<string, string>> = {};
    for (const g of got) {
      actual[g.code] ??= {};
      if (g.permission_code && g.scope_mode) actual[g.code]![g.permission_code] = g.scope_mode;
    }
    expect(actual).toEqual(ROLE_MATRIX);
  });

  it('re-seeding removes a grant that is no longer in the matrix', async () => {
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT organization_id, id, 'org.settings.read', 'GRANTED' FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'`,
      [ORG_C],
    );
    await seedTenantRoles(exec, ORG_C);
    const left = await adminQuery(
      `SELECT 1 FROM app.role_permissions p JOIN app.roles r ON r.id = p.role_id WHERE r.organization_id = $1 AND r.code = 'STAFF' AND p.permission_code = 'org.settings.read'`,
      [ORG_C],
    );
    expect(left).toEqual([]);
  });
});
