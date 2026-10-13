import { AppError, resourceNotFound } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { uuidv7, isUuidV7 } from '../ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../audit/index.js';
import { SCOPE_TYPES, type ScopeType } from './catalog.js';
import { AuthorizationEngine, scopeContains, type Scope } from './engine.js';
import { lockPersonIdentity } from './person-identity.js';
import { GRANT_RULES, ROLE_SCOPE_TYPES, isRoleCode, type RoleCode } from './role-matrix.js';

function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Access denied.');
}

export interface GrantInput {
  targetUserId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string;
  /** Why the role is being granted (06 §5: CRITICAL actions need a reason). Stored in the audit row. */
  reason: string;
}

/** A meaningful reason: trimmed, 5..500 characters, with at least one letter or digit. */
export function normaliseReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 5 || text.length > 500 || !/[\p{L}\p{N}]/u.test(text)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'A reason of 5 to 500 characters is required for this change.',
    );
  }
  return text;
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

  /**
   * Proves the target campus/department is grantable AND keeps it so until this transaction ends.
   *
   * LOCK ORDER (the convention every writer of campuses/departments must follow): campus first, then
   * department, one row per statement. Plain `FOR SHARE` rows block a concurrent status/soft-delete UPDATE
   * (which takes FOR NO KEY UPDATE) until the grant commits, so a deactivation cannot land between this check
   * and the INSERT. The foreign keys of the INSERT do NOT provide that protection: they take FOR KEY SHARE,
   * which a non-key UPDATE does not conflict with. Under READ COMMITTED a row changed by a transaction that
   * committed while we waited is re-checked against the WHERE clause, so a deactivation that wins is seen.
   * Two grants only ever share-lock, so they cannot deadlock each other; a deactivation that follows the
   * same order (campus before department) cannot form a cycle with a grant either.
   */
  private static async lockGrantableScope(
    tx: TenantTx,
    tenantId: string,
    scopeType: ScopeType,
    scopeId: string | undefined,
  ): Promise<void> {
    if (scopeType === 'ORGANIZATION') return;
    let campusId = scopeId;
    if (scopeType === 'DEPARTMENT') {
      // campus_id of a department is immutable (no UPDATE grant), so reading it unlocked is safe.
      const dept = await tx.query<{ campus_id: string }>(
        `SELECT campus_id FROM app.departments
          WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'`,
        [tenantId, scopeId],
      );
      campusId = dept.rows[0]?.campus_id;
      if (!campusId) throw resourceNotFound();
    }
    const campus = await tx.query(
      `SELECT 1 FROM app.campuses
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
          FOR SHARE`,
      [tenantId, campusId],
    );
    if (campus.rowCount === 0) throw resourceNotFound();
    if (scopeType === 'DEPARTMENT') {
      // Second lock, re-checking the state the unlocked read saw.
      const dept = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'
            FOR SHARE`,
        [tenantId, scopeId],
      );
      if (dept.rowCount === 0) throw resourceNotFound();
    }
  }

  /**
   * Grants a role. The assignment row and its audit event are written in the CALLER'S tenant
   * transaction (`tx`): they commit or roll back together, and an audit failure fails the grant.
   */
  static async grant(
    tx: TenantTx,
    ctx: TrustedContext,
    input: GrantInput,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    const { targetUserId, roleId, scopeType, scopeId } = input;
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    const reason = normaliseReason(input.reason);
    if (!SCOPE_TYPES.includes(scopeType)) throw forbidden();
    if (scopeType === 'ORGANIZATION' ? scopeId !== undefined : !scopeId || !isUuidV7(scopeId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid scope.');
    }
    const scope: Scope = { type: scopeType, id: scopeId ?? null };

    // FIRST database statement: the per-person lock shared with student and employee creation, taken before any other
    // lock or read the decision depends on (shared/authorization/person-identity.ts). It is taken before the
    // permission check on purpose (the lock order has no exceptions); no HTTP route calls this service yet, and a
    // route that does must gate the permission first, as every route does through its `config.permission`.
    if (typeof targetUserId === 'string' && isUuidV7(targetUserId)) {
      await lockPersonIdentity(tx, ctx.tenantId, targetUserId);
    }
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

    // Person-identity invariant (docs/architecture/v3/21-students.md §6), decided after authorization so an
    // unauthorised caller learns nothing about student records, and under the lock taken above:
    //  * a STUDENT role belongs to a student: it requires an existing student record (service rule only; the trigger
    //    of migration 0020 does not impose it, so raw writers keep their order freedom);
    //  * any OTHER role is refused on an account that has a student record (the trigger of 0020 is the backstop).
    const student = await tx.query(
      'SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2',
      [ctx.tenantId, targetUserId],
    );
    const hasStudentRecord = (student.rowCount ?? 0) > 0;
    if (roleCode === 'STUDENT' && !hasStudentRecord) {
      throw new AppError(
        409,
        'CONFLICT',
        'The STUDENT role can only be granted to an account that already has a student record.',
      );
    }
    if (roleCode !== 'STUDENT' && hasStudentRecord) {
      throw new AppError(
        409,
        'CONFLICT',
        'This account has a student record and cannot be given a staff role.',
      );
    }

    // Checked only AFTER the grantor is authorised for this scope, so an unauthorised caller cannot use the
    // response to learn which campus/department ids exist. Unknown, other-tenant, INACTIVE, soft-deleted
    // scopes (and a department under an INACTIVE campus) are the same 404 as an unknown role or user.
    await this.lockGrantableScope(tx, ctx.tenantId, scopeType, scopeId);

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
    // scope_id stays the engine's source of truth; the typed column that matches the scope type is
    // written with the same value (the others stay NULL) so the 0009 integrity check holds.
    try {
      await tx.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          ctx.tenantId,
          targetUserId,
          roleId,
          scopeType,
          scopeId ?? null,
          scopeType === 'CAMPUS' ? scopeId : null,
          scopeType === 'DEPARTMENT' ? scopeId : null,
        ],
      );
    } catch (err) {
      // Backstop of migration 0020 (a writer that bypassed the check above): same answer as the explicit check.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23P01' && e.constraint === 'person_record_exclusive') {
        throw new AppError(
          409,
          'CONFLICT',
          'This account has a student record and cannot be given a staff role.',
        );
      }
      throw err;
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'role.assignment.grant',
        resourceType: 'role_assignment',
        resourceId: id,
        riskTier: 2,
        ...(scopeType === 'CAMPUS' && scopeId ? { campusId: scopeId } : {}),
        ...(scopeType === 'DEPARTMENT' && scopeId ? { departmentId: scopeId } : {}),
        changes: {
          status: { old: null, new: 'ACTIVE' },
          user_id: { old: null, new: targetUserId },
          role_code: { old: null, new: roleCode },
          scope_type: { old: null, new: scopeType },
          scope_id: { old: null, new: scopeId ?? null },
        },
        reasonText: reason,
      },
      meta,
    );
    return id;
  }

  /** Revokes an assignment. Same atomicity as `grant`: the status change and its audit event share `tx`. */
  static async revoke(
    tx: TenantTx,
    ctx: TrustedContext,
    assignmentId: string,
    reason: string,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    const cleanReason = normaliseReason(reason);
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
    await recordAudit(
      tx,
      ctx,
      {
        action: 'role.assignment.revoke',
        resourceType: 'role_assignment',
        resourceId: assignmentId,
        riskTier: 2,
        ...(row.scope_type === 'CAMPUS' && row.scope_id ? { campusId: row.scope_id } : {}),
        ...(row.scope_type === 'DEPARTMENT' && row.scope_id ? { departmentId: row.scope_id } : {}),
        changes: { status: { old: 'ACTIVE', new: 'REVOKED' } },
        metadata: {
          user_id: row.user_id,
          role_code: row.code,
          scope_type: row.scope_type,
          scope_id: row.scope_id,
        },
        reasonText: cleanReason,
      },
      meta,
    );
  }
}
