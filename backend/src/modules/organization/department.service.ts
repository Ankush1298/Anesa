import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';

export type DepartmentKind = 'ACADEMIC' | 'ADMINISTRATIVE' | 'SERVICE';
export const DEPARTMENT_KINDS: readonly DepartmentKind[] = [
  'ACADEMIC',
  'ADMINISTRATIVE',
  'SERVICE',
];

export interface DepartmentInput {
  campusId: string;
  name: string;
  code: string;
  kind?: DepartmentKind;
  parentDepartmentId?: string;
}

export interface UpdateDepartmentInput {
  name?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface DepartmentRecord {
  id: string;
  organizationId: string;
  campusId: string;
  parentDepartmentId: string | null;
  name: string;
  code: string;
  kind: DepartmentKind;
  status: 'ACTIVE' | 'INACTIVE';
  deletedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

/**
 * Manages departments. All mutating operations occur inside the caller's tenant transaction (`tx`),
 * ensuring the row change and its audit event commit or roll back atomically.
 *
 * LOCK ORDER (the convention established in F2.1): campus row first (`FOR SHARE`), then department row
 * (`FOR SHARE` or `FOR NO KEY UPDATE`), one row per statement. This guarantees consistency with
 * RoleAssignmentService grants and avoids deadlocks.
 */
export class DepartmentService {
  /**
   * Creates a new department under an active campus.
   */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: DepartmentInput,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!input || typeof input !== 'object') {
      throw invalid('Department input is required.');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) {
      throw invalid('Department name must be 1 to 255 characters.');
    }
    if (typeof input.code !== 'string' || !CODE_RE.test(input.code)) {
      throw invalid('Department code must be 1 to 20 letters, digits, "-" or "_".');
    }
    const kind = input.kind ?? 'ACADEMIC';
    if (!DEPARTMENT_KINDS.includes(kind)) {
      throw invalid('Department kind must be ACADEMIC, ADMINISTRATIVE, or SERVICE.');
    }
    if (!isUuidV7(input.campusId)) {
      throw invalid('Invalid campus ID.');
    }

    const parentDeptId = input.parentDepartmentId;
    if (parentDeptId !== undefined && !isUuidV7(parentDeptId)) {
      throw invalid('Invalid parent department ID.');
    }

    // Authorization: org.department.manage permission check.
    // 1. Permission held at all (throws 403 if user holds no grant for this permission).
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage');
    // 2. Scoped permission check (throws 404 if actor's assignment is out of scope for this campus).
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage', {
      organization_id: ctx.tenantId,
      campus_id: input.campusId,
    });

    // LOCK ORDER: campus row first, then department row.
    // 1. Lock campus row FOR SHARE and verify it is ACTIVE in this tenant.
    const campus = await tx.query(
      `SELECT 1 FROM app.campuses
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
          FOR SHARE`,
      [ctx.tenantId, input.campusId],
    );
    if (campus.rowCount === 0) {
      throw resourceNotFound();
    }

    // 2. If parent department is specified, lock it FOR SHARE and verify it is ACTIVE,
    // not soft-deleted, and belongs to the exact same campus and tenant.
    if (parentDeptId !== undefined) {
      const parent = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND campus_id = $2 AND id = $3
            AND deleted_at IS NULL AND status = 'ACTIVE'
            FOR SHARE`,
        [ctx.tenantId, input.campusId, parentDeptId],
      );
      if (parent.rowCount === 0) {
        throw resourceNotFound();
      }
    }

    const id = uuidv7();
    if (parentDeptId === id) {
      throw invalid('Department cannot be its own parent.');
    }

    try {
      await tx.query(
        `INSERT INTO app.departments (id, organization_id, campus_id, parent_department_id, name, code, kind, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [id, ctx.tenantId, input.campusId, parentDeptId ?? null, name, input.code, kind],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(
          409,
          'CONFLICT',
          'A department with this code already exists in this campus.',
        );
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'department.create',
        resourceType: 'department',
        resourceId: id,
        campusId: input.campusId,
        departmentId: id,
        riskTier: 1,
        changes: {
          name: { old: null, new: name },
          code: { old: null, new: input.code },
          kind: { old: null, new: kind },
          campus_id: { old: null, new: input.campusId },
          parent_department_id: { old: null, new: parentDeptId ?? null },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );

    return id;
  }

  /**
   * Updates an existing department's name or active status.
   * Note: id, organization_id, campus_id, code, kind, and parent_department_id are immutable.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    departmentId: string,
    input: UpdateDepartmentInput,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!isUuidV7(departmentId)) {
      throw invalid('Invalid department ID.');
    }
    if (!input || typeof input !== 'object') {
      throw invalid('Update input is required.');
    }

    const hasName = input.name !== undefined;
    const hasStatus = input.status !== undefined;
    if (!hasName && !hasStatus) {
      throw invalid('At least one of name or status must be provided for update.');
    }

    let newName: string | undefined;
    if (hasName) {
      newName = typeof input.name === 'string' ? input.name.trim() : '';
      if (newName.length < 1 || newName.length > 255) {
        throw invalid('Department name must be 1 to 255 characters.');
      }
    }

    if (hasStatus && input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw invalid('Status must be ACTIVE or INACTIVE.');
    }

    // Read current department state to determine its campus_id and active status.
    const current = await tx.query<{
      campus_id: string;
      name: string;
      status: 'ACTIVE' | 'INACTIVE';
      deleted_at: string | null;
    }>(
      `SELECT campus_id, name, status, deleted_at FROM app.departments
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, departmentId],
    );
    const row = current.rows[0];
    if (!row || row.deleted_at !== null) {
      throw resourceNotFound();
    }

    // Authorization
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage');
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage', {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
    });

    // LOCK ORDER: campus first FOR SHARE, then department FOR NO KEY UPDATE
    const campus = await tx.query(
      `SELECT 1 FROM app.campuses
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
          FOR SHARE`,
      [ctx.tenantId, row.campus_id],
    );
    if (campus.rowCount === 0) {
      throw resourceNotFound();
    }

    const deptLock = await tx.query<{
      name: string;
      status: 'ACTIVE' | 'INACTIVE';
      deleted_at: string | null;
    }>(
      `SELECT name, status, deleted_at FROM app.departments
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
          FOR NO KEY UPDATE`,
      [ctx.tenantId, departmentId],
    );
    const lockedRow = deptLock.rows[0];
    if (!lockedRow || lockedRow.deleted_at !== null) {
      throw resourceNotFound();
    }

    // If deactivating, prevent deactivation if any active child departments exist
    if (input.status === 'INACTIVE' && lockedRow.status === 'ACTIVE') {
      const activeChildren = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND parent_department_id = $2
            AND deleted_at IS NULL AND status = 'ACTIVE'
          LIMIT 1`,
        [ctx.tenantId, departmentId],
      );
      if ((activeChildren.rowCount ?? 0) > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'Cannot deactivate a department that has active child departments.',
        );
      }
    }

    const finalName = newName ?? lockedRow.name;
    const finalStatus = input.status ?? lockedRow.status;

    if (finalName === lockedRow.name && finalStatus === lockedRow.status) {
      return;
    }

    await tx.query(
      `UPDATE app.departments
          SET name = $3, status = $4
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.tenantId, departmentId, finalName, finalStatus],
    );

    const changes: Record<string, unknown> = {};
    if (finalName !== lockedRow.name) {
      changes.name = { old: lockedRow.name, new: finalName };
    }
    if (finalStatus !== lockedRow.status) {
      changes.status = { old: lockedRow.status, new: finalStatus };
    }

    if (Object.keys(changes).length > 0) {
      await recordAudit(
        tx,
        ctx,
        {
          action: 'department.update',
          resourceType: 'department',
          resourceId: departmentId,
          campusId: row.campus_id,
          departmentId,
          riskTier: 1,
          changes,
        },
        meta,
      );
    }
  }

  /**
   * Soft-deletes a department by setting deleted_at = now() and status = 'INACTIVE'.
   * Refuses if non-deleted child departments exist under it.
   */
  static async softDelete(
    tx: TenantTx,
    ctx: TrustedContext,
    departmentId: string,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!isUuidV7(departmentId)) {
      throw invalid('Invalid department ID.');
    }

    const current = await tx.query<{
      campus_id: string;
      name: string;
      status: 'ACTIVE' | 'INACTIVE';
      deleted_at: string | null;
    }>(
      `SELECT campus_id, name, status, deleted_at FROM app.departments
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, departmentId],
    );
    const row = current.rows[0];
    if (!row || row.deleted_at !== null) {
      throw resourceNotFound();
    }

    // Authorization
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage');
    await AuthorizationEngine.assert(tx, ctx, 'org.department.manage', {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
    });

    // LOCK ORDER: campus first FOR SHARE, then department FOR NO KEY UPDATE
    const campus = await tx.query(
      `SELECT 1 FROM app.campuses
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
          FOR SHARE`,
      [ctx.tenantId, row.campus_id],
    );
    if (campus.rowCount === 0) {
      throw resourceNotFound();
    }

    const deptLock = await tx.query<{
      status: 'ACTIVE' | 'INACTIVE';
      deleted_at: string | null;
    }>(
      `SELECT status, deleted_at FROM app.departments
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
          FOR NO KEY UPDATE`,
      [ctx.tenantId, departmentId],
    );
    const lockedRow = deptLock.rows[0];
    if (!lockedRow || lockedRow.deleted_at !== null) {
      throw resourceNotFound();
    }

    // Block deletion if non-deleted child departments exist
    const children = await tx.query(
      `SELECT 1 FROM app.departments
        WHERE organization_id = $1 AND parent_department_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [ctx.tenantId, departmentId],
    );
    if ((children.rowCount ?? 0) > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        'Cannot delete a department that has active child departments.',
      );
    }

    await tx.query(
      `UPDATE app.departments
          SET deleted_at = now(), status = 'INACTIVE'
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.tenantId, departmentId],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'department.delete',
        resourceType: 'department',
        resourceId: departmentId,
        campusId: row.campus_id,
        departmentId,
        riskTier: 1,
        changes: {
          deleted_at: { old: null, new: 'DELETED' },
          status: { old: lockedRow.status, new: 'INACTIVE' },
        },
      },
      meta,
    );
  }

  /**
   * Reads a department by ID within the caller's tenant.
   */
  static async getById(
    tx: TenantTx,
    ctx: TrustedContext,
    departmentId: string,
  ): Promise<DepartmentRecord> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!isUuidV7(departmentId)) {
      throw invalid('Invalid department ID.');
    }

    const res = await tx.query<{
      id: string;
      organization_id: string;
      campus_id: string;
      parent_department_id: string | null;
      name: string;
      code: string;
      kind: DepartmentKind;
      status: 'ACTIVE' | 'INACTIVE';
      deleted_at: string | null;
      version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, organization_id, campus_id, parent_department_id, name, code, kind, status,
              deleted_at, version, created_at, updated_at
         FROM app.departments
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, departmentId],
    );
    const r = res.rows[0];
    if (!r) {
      throw resourceNotFound();
    }

    return {
      id: r.id,
      organizationId: r.organization_id,
      campusId: r.campus_id,
      parentDepartmentId: r.parent_department_id,
      name: r.name,
      code: r.code,
      kind: r.kind,
      status: r.status,
      deletedAt: r.deleted_at,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
