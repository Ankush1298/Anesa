import { AppError } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import type { ScopeMode } from './catalog.js';

export interface ResourceScope {
  student_id?: string;
  user_id?: string;
  campus_id?: string;
  department_id?: string;
}

export class AuthorizationEngine {
  /**
   * Fast check for route guards: does the user hold this permission in ANY scope mode?
   */
  static async hasPermission(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
  ): Promise<boolean> {
    if (!isTrustedContext(ctx)) return false;

    const res = await tx.query(
      `
      SELECT 1 FROM app.role_assignments ra
      JOIN app.role_permissions rp ON ra.role_id = rp.role_id
      WHERE ra.user_id = $1 AND rp.permission_code = $2
        AND ra.status = 'ACTIVE'
        AND ra.valid_from <= now()
        AND (ra.valid_until IS NULL OR ra.valid_until > now())
    `,
      [ctx.userId, permission],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Asserts the user has the required permission for the given resource.
   * Throws 403 if they don't hold the permission at all.
   * Throws 404 if they hold the permission but the resource is out of scope.
   */
  static async assert(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
    resource?: ResourceScope,
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    const grants = await tx.query<{
      scope_mode: ScopeMode;
      scope_type: string;
      scope_id: string | null;
    }>(
      `
      SELECT rp.scope_mode, ra.scope_type, ra.scope_id
      FROM app.role_assignments ra
      JOIN app.role_permissions rp ON ra.role_id = rp.role_id
      WHERE ra.user_id = $1 AND rp.permission_code = $2
        AND ra.status = 'ACTIVE'
        AND ra.valid_from <= now()
        AND (ra.valid_until IS NULL OR ra.valid_until > now())
    `,
      [ctx.userId, permission],
    );

    if (grants.rowCount === 0) {
      if (resource) {
        // "deny ⇒ 404 for out-of-scope resources whose existence is private ...
        // 403 for permission-level denial on collection/action endpoints"
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
      }
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }

    if (!resource) {
      // Permission exists, and no resource scope was provided (collection/action endpoint)
      return;
    }

    let allowed = false;
    for (const grant of grants.rows) {
      if (grant.scope_mode === 'SELF') {
        if (ctx.actorKind === 'STUDENT' && resource.student_id) {
          const st = await tx.query('SELECT id FROM app.students WHERE user_id = $1', [ctx.userId]);
          if (st.rowCount && st.rows[0]?.id === resource.student_id) {
            allowed = true;
            break;
          }
        }
        if (resource.user_id && resource.user_id === ctx.userId) {
          allowed = true;
          break;
        }
      } else if (grant.scope_mode === 'GRANTED') {
        if (grant.scope_type === 'ORGANIZATION') {
          allowed = true;
          break;
        } else if (grant.scope_type === 'CAMPUS' && resource.campus_id === grant.scope_id) {
          allowed = true;
          break;
        } else if (grant.scope_type === 'DEPARTMENT' && resource.department_id === grant.scope_id) {
          allowed = true;
          break;
        }
      } else if (grant.scope_mode === 'ASSIGNED') {
        // Placeholder for M3/M4 assigned resolution.
      }
    }

    if (!allowed) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    }
  }
}
