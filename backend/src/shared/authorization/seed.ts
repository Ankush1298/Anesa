import { uuidv7 } from '../ids/uuidv7.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { ROLE_MATRIX } from './role-matrix.js';

export async function seedTenantRoles(tx: TenantTx, organizationId: string): Promise<void> {
  for (const [code, perms] of Object.entries(ROLE_MATRIX)) {
    const roleId = uuidv7();
    const res = await tx.query<{ id: string }>(
      `
      INSERT INTO app.roles (id, organization_id, code, name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `,
      [roleId, organizationId, code, code],
    );

    const actualRoleId = res.rows[0]!.id;

    for (const [permCode, scopeMode] of Object.entries(perms)) {
      await tx.query(
        `
        INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = EXCLUDED.scope_mode
      `,
        [organizationId, actualRoleId, permCode, scopeMode],
      );
    }
  }
}
