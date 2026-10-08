import { AppError } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { uuidv7 } from '../ids/uuidv7.js';
import { AuthorizationEngine } from './engine.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';

export class RoleAssignmentService {
  /**
   * Grants a role to a user.
   */
  static async grant(
    tx: TenantTx,
    ctx: TrustedContext,
    targetUserId: string,
    roleId: string,
    scopeType: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT',
    scopeId?: string,
  ): Promise<string> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    // 1. Assert the grantor has the 'role.assignment.grant' permission
    const grantScope: Record<string, string> = {};
    if (scopeType === 'CAMPUS' && scopeId) grantScope.campus_id = scopeId;
    if (scopeType === 'DEPARTMENT' && scopeId) grantScope.department_id = scopeId;

    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.grant', grantScope);

    // 2. Prevent self-elevation
    if (ctx.userId === targetUserId) {
      throw new AppError(403, 'FORBIDDEN', 'Self-elevation is not permitted');
    }

    // 3. Prevent duplicate assignments for the exact same active role/scope
    const existing = await tx.query(
      `
      SELECT 1 FROM app.role_assignments 
      WHERE user_id = $1 AND role_id = $2 AND status = 'ACTIVE' 
      AND (valid_until IS NULL OR valid_until > now())
      AND scope_type = $3 AND (scope_id = $4 OR (scope_id IS NULL AND $4 IS NULL))
    `,
      [targetUserId, roleId, scopeType, scopeId || null],
    );

    if ((existing.rowCount ?? 0) > 0) {
      throw new AppError(409, 'CONFLICT', 'User already has this role in this scope');
    }

    const id = uuidv7();
    await tx.query(
      `
      INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [id, ctx.tenantId, targetUserId, roleId, scopeType, scopeId || null],
    );

    // Bump user authz_version if supported (placeholder for future implementation)

    return id;
  }

  /**
   * Revokes a role assignment.
   */
  static async revoke(tx: TenantTx, ctx: TrustedContext, assignmentId: string): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    // Load the assignment to determine its scope
    const assignment = await tx.query(
      `
      SELECT user_id, scope_type, scope_id FROM app.role_assignments WHERE id = $1 AND status = 'ACTIVE'
    `,
      [assignmentId],
    );

    if (assignment.rowCount === 0) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Role assignment not found');
    }

    const row = assignment.rows[0];

    // Assert grantor has permission to revoke in the assignment's scope
    const revokeScope: Record<string, string> = {};
    if (row?.scope_type === 'CAMPUS' && row.scope_id)
      revokeScope.campus_id = row.scope_id as string;
    if (row?.scope_type === 'DEPARTMENT' && row.scope_id)
      revokeScope.department_id = row.scope_id as string;

    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.revoke', revokeScope);

    if (ctx.userId === row?.user_id) {
      throw new AppError(403, 'FORBIDDEN', 'Self-revocation is not permitted');
    }

    await tx.query(
      `
      UPDATE app.role_assignments SET status = 'REVOKED', updated_at = now() WHERE id = $1
    `,
      [assignmentId],
    );
  }
}
