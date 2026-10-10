import { AppError } from '../../shared/errors/http-errors.js';

const invalid = (msg: string) => new AppError(400, 'VALIDATION_ERROR', msg);
import type { TenantTx } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import {
  CODE_PATTERN,
  type CreateDesignationBody,
  type DesignationCategory,
  type DesignationRecordDto,
  type DesignationStatus,
  type ListDesignationsQuery,
} from './organization.schemas.js';

const CODE_RE = new RegExp(CODE_PATTERN);

export class DesignationService {
  /**
   * Creates an organization-level designation.
   * Requires organization-level management permission (org.campus.manage or org.department.manage at ORGANIZATION scope).
   * Atomically records a `designation.create` audit event in the same transaction.
   */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateDesignationBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!input || typeof input !== 'object') {
      throw invalid('Designation payload is required.');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) {
      throw invalid('Designation name must be 1 to 255 characters.');
    }

    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!CODE_RE.test(code)) {
      throw invalid(
        'Designation code must be 1 to 20 characters matching /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.',
      );
    }

    const category = input.category;
    if (category !== 'TEACHING' && category !== 'NON_TEACHING' && category !== 'ADMIN') {
      throw invalid('Designation category must be TEACHING, NON_TEACHING, or ADMIN.');
    }

    // Authorization: caller must hold management permission at ORGANIZATION scope
    const hasCampusManage = await AuthorizationEngine.hasPermission(tx, ctx, 'org.campus.manage');
    const hasDeptManage = await AuthorizationEngine.hasPermission(tx, ctx, 'org.department.manage');
    if (!hasCampusManage && !hasDeptManage) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }

    let allowed = false;
    if (hasCampusManage) {
      try {
        await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
          organization_id: ctx.tenantId,
        });
        allowed = true;
      } catch {
        // Fall through to test department management if campus management was scoped out
      }
    }
    if (!allowed && hasDeptManage) {
      try {
        await AuthorizationEngine.assert(tx, ctx, 'org.department.manage', {
          organization_id: ctx.tenantId,
        });
        allowed = true;
      } catch {
        // Not allowed
      }
    }

    if (!allowed) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.designations (id, organization_id, code, name, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.tenantId, code, name, category],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'A designation with this code already exists.');
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'designation.create',
        resourceType: 'designation',
        resourceId: id,
        riskTier: 1,
        changes: {
          code: { old: null, new: code },
          name: { old: null, new: name },
          category: { old: null, new: category },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );

    return id;
  }

  /**
   * Lists designations within the caller's tenant.
   * Requires org.structure.read (or management permissions).
   * Non-managers are strictly shielded from INACTIVE designations.
   * No audit events are written on read operations.
   */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    input: ListDesignationsQuery = {},
  ): Promise<DesignationRecordDto[]> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    // Authorization: caller must have read or manage permission
    await AuthorizationEngine.assert(tx, ctx, 'org.structure.read');

    const canManage =
      (await AuthorizationEngine.hasPermission(tx, ctx, 'org.campus.manage')) ||
      (await AuthorizationEngine.hasPermission(tx, ctx, 'org.department.manage'));

    // Shielding: Non-managers requesting INACTIVE records receive [] immediately
    if (!canManage && input.status === 'INACTIVE') {
      return [];
    }

    const conditions: string[] = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;

    if (!canManage) {
      conditions.push("status = 'ACTIVE'");
    } else if (input.status) {
      conditions.push(`status = $${idx++}`);
      params.push(input.status);
    }

    if (input.category) {
      conditions.push(`category = $${idx}`);
      params.push(input.category);
    }

    const res = await tx.query<{
      id: string;
      organization_id: string;
      code: string;
      name: string;
      category: DesignationCategory;
      status: DesignationStatus;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, organization_id, code, name, category, status, version, created_at, updated_at
       FROM app.designations
       WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC, code ASC`,
      params,
    );

    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      code: r.code,
      name: r.name,
      category: r.category,
      status: r.status,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }
}
