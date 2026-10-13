import { AppError, resourceNotFound } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import type { ScopeMode, ScopeType } from './catalog.js';
import { PERMISSION_CODES } from './catalog.js';

/**
 * Attributes of ONE resource, read by the server from a tenant-scoped row. Never copy request
 * parameters into the scope-bearing fields (organization_id / campus_id / department_id): those are
 * the trusted facts the grant is compared against. `student_id` / `user_id` may carry the *target*
 * identifier from the URL, because they are only ever compared to the actor's server-side identity.
 */
export interface ResourceScope {
  organization_id?: string;
  student_id?: string;
  user_id?: string;
  campus_id?: string;
  department_id?: string;
}

/** ASSIGNED relationship proof, registered by the module that owns the relationship (M3/M4). */
export type AssignedResolver = (
  tx: TenantTx,
  ctx: TrustedContext,
  resource: ResourceScope,
) => Promise<boolean>;
const assignedResolvers = new Map<string, AssignedResolver>();

export function registerAssignedResolver(permission: string, resolver: AssignedResolver): void {
  assignedResolvers.set(permission, resolver);
}
export function clearAssignedResolvers(): void {
  assignedResolvers.clear();
}

export interface Grant {
  scope_mode: ScopeMode;
  scope_type: ScopeType;
  scope_id: string | null;
}

export interface Scope {
  type: ScopeType;
  id: string | null;
}

/** Does an assignment scope contain a target scope? ORG ⊇ everything; CAMPUS/DEPARTMENT only themselves. */
export function scopeContains(held: Scope, target: Scope): boolean {
  if (held.type === 'ORGANIZATION') return true;
  return held.type === target.type && held.id !== null && held.id === target.id;
}

function requireKnownPermission(permission: string): void {
  if (!PERMISSION_CODES.has(permission)) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Unknown permission code.');
  }
}

/**
 * The single authorization decision point (06 §2 steps 2–8). Everything is resolved server-side:
 * the actor from the TrustedContext, roles/permissions/scopes from the database, the student
 * identity from the students mapping. Evaluation is a pure union over effective grants, so the
 * outcome does not depend on row order.
 */
export class AuthorizationEngine {
  /** Effective (ACTIVE, started, not ended) grants of the actor for one permission, this tenant only. */
  public static async loadGrants(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
  ): Promise<Grant[]> {
    const res = await tx.query<Grant>(
      `SELECT rp.scope_mode, ra.scope_type, ra.scope_id
         FROM app.role_assignments ra
         JOIN app.role_permissions rp
           ON rp.organization_id = ra.organization_id AND rp.role_id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND rp.permission_code = $3
          AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now()
          AND (ra.valid_until IS NULL OR ra.valid_until > now())
        ORDER BY rp.scope_mode, ra.scope_type, ra.scope_id`,
      [ctx.tenantId, ctx.userId, permission],
    );
    return res.rows;
  }

  /**
   * Does the account hold a STAFF-CAPABLE role assignment? THE conflict predicate of the person-identity invariant
   * (docs/architecture/v3/21-students.md §6): a role other than STUDENT (any other code, known or not: fail closed),
   * `status = 'ACTIVE'` and not ended (`valid_until` NULL or in the future). `valid_from` is deliberately IGNORED: a
   * future-dated assignment becomes effective later without any write, so it conflicts now. Revoked, expired and
   * ended-window rows never conflict. The same predicate is written in migration 0020's triggers and in the preflight
   * SQL of docs/runbooks/students-contract-rollout.md; tests/security-db/person-identity-triggers.test.ts pins parity.
   * Not an authorization decision, and NOT the engine's "effective grant" rule (that one requires valid_from <= now()).
   */
  static async hasStaffCapableAssignment(
    tx: TenantTx,
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const res = await tx.query(
      `SELECT 1 FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2
          AND r.code <> 'STUDENT'
          AND ra.status = 'ACTIVE'
          AND (ra.valid_until IS NULL OR ra.valid_until > now())
        LIMIT 1`,
      [organizationId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * What the actor can do, for UI rendering only (menus). Resolved server-side per request from the
   * same effective-assignment rule as every decision; it is NOT an authorization decision: each
   * action is still checked by assert(). Sorted, so the answer is deterministic.
   */
  static async describeActor(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<{ roleCodes: string[]; capabilities: string[] }> {
    if (!isTrustedContext(ctx)) return { roleCodes: [], capabilities: [] };
    const roles = await tx.query<{ code: string }>(
      `SELECT DISTINCT r.code
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())
        ORDER BY r.code`,
      [ctx.tenantId, ctx.userId],
    );
    const caps = await tx.query<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code
         FROM app.role_assignments ra
         JOIN app.role_permissions rp
           ON rp.organization_id = ra.organization_id AND rp.role_id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())
        ORDER BY rp.permission_code`,
      [ctx.tenantId, ctx.userId],
    );
    return {
      roleCodes: roles.rows.map((r) => r.code),
      capabilities: caps.rows.map((c) => c.permission_code),
    };
  }

  /** Does the actor hold the permission in any scope? (route-level / capability check) */
  static async hasPermission(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
  ): Promise<boolean> {
    if (!isTrustedContext(ctx)) return false;
    requireKnownPermission(permission);
    return (await this.loadGrants(tx, ctx, permission)).length > 0;
  }

  /**
   * Throws unless the actor may exercise `permission` on `resource`.
   *  - no resource (collection / action endpoint): 403 FORBIDDEN when the permission is not held.
   *  - with a resource: not held OR out of scope ⇒ the same 404 as a non-existent resource.
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
    requireKnownPermission(permission);

    const grants = await this.loadGrants(tx, ctx, permission);
    if (!resource) {
      if (grants.length === 0) throw new AppError(403, 'FORBIDDEN', 'Access denied.');
      return;
    }
    if (grants.length === 0) throw resourceNotFound();

    // Tenant boundary, enforced here as well as by RLS: a resource of another tenant is never allowed.
    if (resource.organization_id !== undefined && resource.organization_id !== ctx.tenantId) {
      throw resourceNotFound();
    }

    for (const grant of grants) {
      if (await this.grantAllows(tx, ctx, permission, grant, resource)) return;
    }
    throw resourceNotFound();
  }

  private static async grantAllows(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
    grant: Grant,
    resource: ResourceScope,
  ): Promise<boolean> {
    switch (grant.scope_mode) {
      case 'SELF': {
        if (resource.user_id !== undefined && resource.user_id === ctx.userId) return true;
        if (resource.student_id === undefined) return false;
        const own = await tx.query<{ id: string }>(
          'SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2',
          [ctx.tenantId, ctx.userId],
        );
        return own.rows[0]?.id === resource.student_id;
      }
      case 'ASSIGNED': {
        const resolver = assignedResolvers.get(permission);
        return resolver ? await resolver(tx, ctx, resource) : false; // no resolver ⇒ deny
      }
      case 'GRANTED': {
        // The resource must PROVE it is inside the assignment's scope; absent attributes deny.
        if (resource.organization_id !== ctx.tenantId) return false;
        if (grant.scope_type === 'ORGANIZATION') return true;
        if (grant.scope_id === null) return false;
        if (grant.scope_type === 'CAMPUS') return resource.campus_id === grant.scope_id;
        return resource.department_id === grant.scope_id;
      }
    }
  }
}
