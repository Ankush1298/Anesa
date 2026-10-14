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

export interface DepartmentListFilter {
  campusId?: string;
  kind?: DepartmentKind;
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
 * A department that still has an ACTIVE student enrolment (app.student_programs, frozen department_id) must stay active:
 * the enrolment service share-locks the department row and requires it ACTIVE, so this check, run AFTER the caller took
 * its FOR NO KEY UPDATE lock, either waits for an opening transaction and sees its committed row (READ COMMITTED gives
 * each statement a fresh snapshot) or runs first and makes the opener's recheck find an inactive department. A plain
 * read: it takes no row lock, so no lock above the department is ever requested after it (lock order campus ->
 * department -> program -> cohort is preserved).
 */
async function assertNoActiveEnrolments(
  tx: TenantTx,
  ctx: TrustedContext,
  departmentId: string,
  what: 'deactivate' | 'delete',
): Promise<void> {
  const active = await tx.query(
    `SELECT 1 FROM app.student_programs
      WHERE organization_id = $1 AND department_id = $2 AND status = 'ACTIVE'
      LIMIT 1`,
    [ctx.tenantId, departmentId],
  );
  if ((active.rowCount ?? 0) > 0) {
    throw new AppError(
      409,
      'CONFLICT',
      `Cannot ${what} a department that has active student enrolments.`,
    );
  }
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
    if (input.status === 'INACTIVE' && lockedRow.status === 'ACTIVE') {
      await assertNoActiveEnrolments(tx, ctx, departmentId, 'deactivate');
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
    await assertNoActiveEnrolments(tx, ctx, departmentId, 'delete');

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
   * Lists departments visible to the caller within their tenant.
   * Scoped by effective grants (ORGANIZATION, CAMPUS, or DEPARTMENT).
   * Non-managers never see soft-deleted or INACTIVE departments.
   */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter?: DepartmentListFilter,
  ): Promise<DepartmentRecord[]> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (filter?.campusId && !isUuidV7(filter.campusId)) {
      throw invalid('Invalid campus ID.');
    }

    // 1. Permission check: caller must hold either org.department.manage OR org.structure.read
    const isManager = await AuthorizationEngine.hasPermission(tx, ctx, 'org.department.manage');
    const hasRead = await AuthorizationEngine.hasPermission(tx, ctx, 'org.structure.read');
    if (!isManager && !hasRead) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }

    // 2. Non-managers never see inactive departments
    if (!isManager && filter?.status === 'INACTIVE') {
      return [];
    }

    // 3. Effective scope calculation
    const readGrants = await AuthorizationEngine.loadGrants(tx, ctx, 'org.structure.read');
    const manageGrants = isManager
      ? await AuthorizationEngine.loadGrants(tx, ctx, 'org.department.manage')
      : [];
    const allGrants = [...readGrants, ...manageGrants];

    const isOrgWide = allGrants.some((g) => g.scope_type === 'ORGANIZATION');

    let allowedCampusIds: string[] = [];
    let allowedDeptIds: string[] = [];
    if (!isOrgWide) {
      allowedCampusIds = allGrants
        .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id !== null)
        .map((g) => g.scope_id as string);

      allowedDeptIds = allGrants
        .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id !== null)
        .map((g) => g.scope_id as string);

      if (allowedCampusIds.length === 0 && allowedDeptIds.length === 0) {
        return [];
      }
    }

    const effectiveStatus = isManager ? (filter?.status ?? null) : 'ACTIVE';

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
        WHERE organization_id = $1
          AND deleted_at IS NULL
          AND ($2::boolean OR campus_id = ANY($3::uuid[]) OR id = ANY($4::uuid[]))
          AND ($5::uuid IS NULL OR campus_id = $5)
          AND ($6::text IS NULL OR kind = $6)
          AND ($7::text IS NULL OR status = $7)
        ORDER BY name, code`,
      [
        ctx.tenantId,
        isOrgWide,
        allowedCampusIds,
        allowedDeptIds,
        filter?.campusId ?? null,
        filter?.kind ?? null,
        effectiveStatus,
      ],
    );

    return res.rows.map((r) => ({
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
    }));
  }

  /**
   * Reads a department by ID within the caller's tenant.
   * Scoped to org.department.manage or org.structure.read.
   * Department resources include both campus_id and department_id for grant evaluation.
   * Managers can read soft-deleted or INACTIVE departments. Non-managers receive 404.
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

    // 1. Permission held at all (throws 403 before any lookup if user holds no grant for either permission)
    const isManager = await AuthorizationEngine.hasPermission(tx, ctx, 'org.department.manage');
    const hasRead = await AuthorizationEngine.hasPermission(tx, ctx, 'org.structure.read');
    if (!isManager && !hasRead) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }

    // 2. Fetch row
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

    // 3. Non-managers never see inactive or soft-deleted departments (identical 404)
    if (!isManager && (r.deleted_at !== null || r.status === 'INACTIVE')) {
      throw resourceNotFound();
    }

    // 4. Scoped permission check passing BOTH campus_id and department_id
    let allowed = false;
    if (isManager) {
      try {
        await AuthorizationEngine.assert(tx, ctx, 'org.department.manage', {
          organization_id: ctx.tenantId,
          campus_id: r.campus_id,
          department_id: r.id,
        });
        allowed = true;
      } catch {
        // Not authorized under manage scope; check read scope below
      }
    }

    if (!allowed && hasRead) {
      try {
        await AuthorizationEngine.assert(tx, ctx, 'org.structure.read', {
          organization_id: ctx.tenantId,
          campus_id: r.campus_id,
          department_id: r.id,
        });
        allowed = true;
      } catch {
        // Not authorized under read scope
      }
    }

    if (!allowed) {
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
