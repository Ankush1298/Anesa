import { AppError, resourceNotFound } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { uuidv7, isUuidV7 } from '../ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { SCOPE_TYPES, type ScopeType } from './catalog.js';
import { AuthorizationEngine, scopeContains, type Scope } from './engine.js';
import { GRANT_RULES, ROLE_SCOPE_TYPES, isRoleCode, type RoleCode } from './role-matrix.js';

function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Access denied.');
}

/**
 * The only writer of role_assignments. Authorization for a grant/revoke is decided here from
 * server-side state: the grantor's permission, the grantor's own assignments (scope containment +
 * grant rules, 06 §5) and the target role/user rows read inside the tenant transaction.
 */
export class RoleAssignmentService {
  /** The grantor must hold one active assignment whose role may grant `target` and whose scope contains `scope`. */
  private static async assertMayManage(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: 'role.assignment.grant' | 'role.assignment.revoke',
    targetRole: RoleCode,
    scope: Scope,
  ): Promise<void> {
    await AuthorizationEngine.assert(tx, ctx, permission); // 403 if the permission is not held at all

    const mine = await tx.query<{ code: string; scope_type: ScopeType; scope_id: string | null }>(
      `SELECT r.code, ra.scope_type, ra.scope_id
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())`,
      [ctx.tenantId, ctx.userId],
    );
    const ok = mine.rows.some(
      (a) =>
        (GRANT_RULES[a.code] ?? []).includes(targetRole) &&
        scopeContains({ type: a.scope_type, id: a.scope_id }, scope),
    );
    if (!ok) throw forbidden();
  }

  static async grant(
    tx: TenantTx,
    ctx: TrustedContext,
    targetUserId: string,
    roleId: string,
    scopeType: ScopeType,
    scopeId?: string,
  ): Promise<string> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!SCOPE_TYPES.includes(scopeType)) throw forbidden();
    if (scopeType === 'ORGANIZATION' ? scopeId !== undefined : !scopeId || !isUuidV7(scopeId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid scope.');
    }
    const scope: Scope = { type: scopeType, id: scopeId ?? null };

    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.grant');
    if (ctx.userId === targetUserId) throw forbidden(); // no self-elevation

    // Target user and role must exist in THIS tenant (RLS hides other tenants: same 404 as absent).
    const user = await tx.query('SELECT 1 FROM app.users WHERE organization_id = $1 AND id = $2', [
      ctx.tenantId,
      targetUserId,
    ]);
    const role = await tx.query<{ code: string }>(
      'SELECT code FROM app.roles WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, roleId],
    );
    const roleCode = role.rows[0]?.code;
    if (user.rowCount === 0 || !roleCode || !isRoleCode(roleCode)) throw resourceNotFound();

    if (!ROLE_SCOPE_TYPES[roleCode].includes(scopeType)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Scope type is not valid for this role.');
    }
    await this.assertMayManage(tx, ctx, 'role.assignment.grant', roleCode, scope);

    const existing = await tx.query(
      `SELECT 1 FROM app.role_assignments
        WHERE organization_id = $1 AND user_id = $2 AND role_id = $3 AND status = 'ACTIVE'
          AND (valid_until IS NULL OR valid_until > now())
          AND scope_type = $4 AND scope_id IS NOT DISTINCT FROM $5::uuid`,
      [ctx.tenantId, targetUserId, roleId, scopeType, scopeId ?? null],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new AppError(409, 'CONFLICT', 'User already has this role in this scope.');
    }

    const id = uuidv7();
    await tx.query(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, ctx.tenantId, targetUserId, roleId, scopeType, scopeId ?? null],
    );
    return id;
  }

  static async revoke(tx: TenantTx, ctx: TrustedContext, assignmentId: string): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.revoke');

    const found = await tx.query<{
      user_id: string;
      code: string;
      scope_type: ScopeType;
      scope_id: string | null;
    }>(
      `SELECT ra.user_id, r.code, ra.scope_type, ra.scope_id
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.id = $2 AND ra.status = 'ACTIVE'
        FOR UPDATE OF ra`,
      [ctx.tenantId, assignmentId],
    );
    const row = found.rows[0];
    if (!row || !isRoleCode(row.code)) throw resourceNotFound();

    if (row.user_id === ctx.userId) throw forbidden(); // no self-revocation
    await this.assertMayManage(tx, ctx, 'role.assignment.revoke', row.code, {
      type: row.scope_type,
      id: row.scope_id,
    });

    // Last-admin protection (06 §5) needs no extra query: only an effective COLLEGE_ADMIN may revoke a
    // COLLEGE_ADMIN (GRANT_RULES) and may not revoke their own assignment, so one always remains.

    await tx.query(
      `UPDATE app.role_assignments SET status = 'REVOKED' WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, assignmentId],
    );
  }
}
