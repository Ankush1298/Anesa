import { uuidv7 } from '../ids/uuidv7.js';
import { ROLE_MATRIX } from './role-matrix.js';

/** Anything with a pg-style `query` (a TenantTx, or a provisioning client). */
export interface SqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Seeds (or re-syncs) the system roles and their permissions for one tenant. Idempotent: running it
 * twice yields the same rows. Roles/role_permissions are not writable by app_runtime, so this is a
 * provisioning operation (platform tooling or tests), not something request handlers call.
 */
export async function seedTenantRoles(db: SqlExecutor, organizationId: string): Promise<void> {
  const registeredRes = await db.query('SELECT code FROM platform.permissions');
  const registeredCodes = new Set(registeredRes.rows.map((r) => r['code'] as string));

  for (const [code, perms] of Object.entries(ROLE_MATRIX)) {
    await db.query(
      `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, $3, $3)
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [uuidv7(), organizationId, code],
    );
    const res = await db.query(
      'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
      [organizationId, code],
    );
    const roleId = res.rows[0]?.['id'] as string;

    // Re-sync: drop grants that left the matrix, upsert the rest (constrained to registered permissions in DB).
    const permsToSync = Object.entries(perms).filter(([p]) => registeredCodes.has(p));
    await db.query(
      `DELETE FROM app.role_permissions
        WHERE organization_id = $1 AND role_id = $2 AND NOT (permission_code = ANY($3::text[]))`,
      [organizationId, roleId, permsToSync.map(([p]) => p)],
    );
    for (const [permission, mode] of permsToSync) {
      await db.query(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = EXCLUDED.scope_mode
           WHERE app.role_permissions.scope_mode IS DISTINCT FROM EXCLUDED.scope_mode`,
        [organizationId, roleId, permission, mode],
      );
    }
  }
}
