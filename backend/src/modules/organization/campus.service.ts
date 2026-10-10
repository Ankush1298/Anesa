import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { isSupportedTimezone } from './timezone.js';

export interface CampusInput {
  name: string;
  /** Short business key, unique per organization; fixed after creation. */
  code: string;
  /** REQUIRED. No default: a silent UTC would mis-date every session. Fixed after creation (see timezone.ts). */
  timezone: string;
  address?: Record<string, unknown>;
}

export interface UpdateCampusInput {
  name?: string;
  address?: Record<string, unknown>;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface CampusRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  timezone: string;
  address: Record<string, unknown>;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  createdAt: string;
  updatedAt: string;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const MAX_ADDRESS_BYTES = 4096;

function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

/**
 * Manages campuses. Like RoleAssignmentService and DepartmentService this is a service on the caller's tenant
 * transaction: the row and its audit event commit or roll back together.
 *
 * Immutability: id, organization_id, code, and timezone are immutable. The runtime role has no UPDATE
 * privilege on campuses.timezone/code (0008), and changing a timezone needs an audited operation that also
 * decides what happens to existing sessions, which does not exist yet. Only name, address, and status can be updated.
 */
export class CampusService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CampusInput,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    // Shape first (no database, no information about the tenant).
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255)
      throw invalid('Campus name must be 1 to 255 characters.');
    if (typeof input.code !== 'string' || !CODE_RE.test(input.code)) {
      throw invalid('Campus code must be 1 to 20 letters, digits, "-" or "_".');
    }
    const address = input.address ?? {};
    if (
      typeof address !== 'object' ||
      address === null ||
      Array.isArray(address) ||
      Buffer.byteLength(JSON.stringify(address)) > MAX_ADDRESS_BYTES
    ) {
      throw invalid('Campus address must be an object of at most 4096 bytes.');
    }

    // Authorization: the permission at all (403), then ORGANIZATION scope. A campus administrator whose
    // assignment is limited to one campus must not be able to create new campuses.
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage');
    try {
      await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
        organization_id: ctx.tenantId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied.');
      }
      throw err;
    }

    // Authoritative, server-side: the tz database of the PostgreSQL server that will compute with the value.
    if (!(await isSupportedTimezone(tx, input.timezone))) {
      throw invalid(
        'Timezone must be UTC or a supported IANA identifier such as Asia/Kolkata (no abbreviations or offsets).',
      );
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.campuses (id, organization_id, name, code, timezone, address)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [id, ctx.tenantId, name, input.code, input.timezone, JSON.stringify(address)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'A campus with this code already exists.');
      }
      throw err;
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'campus.create',
        resourceType: 'campus',
        resourceId: id,
        campusId: id,
        riskTier: 1,
        changes: {
          name: { old: null, new: name },
          code: { old: null, new: input.code },
          timezone: { old: null, new: input.timezone },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );
    return id;
  }

  /**
   * Reads a campus by ID within the caller's tenant.
   * Scoped to org.campus.manage (organization or campus scope).
   */
  static async getById(tx: TenantTx, ctx: TrustedContext, campusId: string): Promise<CampusRecord> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!isUuidV7(campusId)) {
      throw invalid('Invalid campus ID.');
    }

    // Authorization: org.campus.manage permission check.
    // 1. Permission held at all (throws 403 if user holds no grant for this permission).
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage');
    // 2. Scoped permission check (throws 404 if actor's assignment is out of scope for this campus).
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
    });

    const res = await tx.query<{
      id: string;
      organization_id: string;
      name: string;
      code: string;
      timezone: string;
      address: Record<string, unknown>;
      status: 'ACTIVE' | 'INACTIVE';
      version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, organization_id, name, code, timezone, address, status,
              version, created_at, updated_at
         FROM app.campuses
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, campusId],
    );
    const r = res.rows[0];
    if (!r) {
      throw resourceNotFound();
    }

    return {
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      code: r.code,
      timezone: r.timezone,
      address: r.address ?? {},
      status: r.status,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Updates an existing campus's name, address, or active status.
   * Note: id, organization_id, code, and timezone are immutable.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    campusId: string,
    input: UpdateCampusInput,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!isUuidV7(campusId)) {
      throw invalid('Invalid campus ID.');
    }
    if (!input || typeof input !== 'object') {
      throw invalid('Update input is required.');
    }

    const hasName = input.name !== undefined;
    const hasAddress = input.address !== undefined;
    const hasStatus = input.status !== undefined;
    if (!hasName && !hasAddress && !hasStatus) {
      throw invalid('At least one of name, address, or status must be provided for update.');
    }

    let newName: string | undefined;
    if (hasName) {
      newName = typeof input.name === 'string' ? input.name.trim() : '';
      if (newName.length < 1 || newName.length > 255) {
        throw invalid('Campus name must be 1 to 255 characters.');
      }
    }

    let newAddress: Record<string, unknown> | undefined;
    if (hasAddress) {
      const addr = input.address;
      if (
        typeof addr !== 'object' ||
        addr === null ||
        Array.isArray(addr) ||
        Buffer.byteLength(JSON.stringify(addr)) > MAX_ADDRESS_BYTES
      ) {
        throw invalid('Campus address must be an object of at most 4096 bytes.');
      }
      newAddress = addr;
    }

    if (hasStatus && input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw invalid('Status must be ACTIVE or INACTIVE.');
    }

    // Authorization
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage');
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
    });

    // Row lock: Lock campus row FOR NO KEY UPDATE
    const current = await tx.query<{
      name: string;
      address: Record<string, unknown>;
      status: 'ACTIVE' | 'INACTIVE';
    }>(
      `SELECT name, address, status FROM app.campuses
        WHERE organization_id = $1 AND id = $2
          FOR NO KEY UPDATE`,
      [ctx.tenantId, campusId],
    );
    const lockedRow = current.rows[0];
    if (!lockedRow) {
      throw resourceNotFound();
    }

    // Deactivation protection: prevent deactivation if any active departments exist in this campus
    if (input.status === 'INACTIVE' && lockedRow.status === 'ACTIVE') {
      const activeChildren = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND campus_id = $2
            AND deleted_at IS NULL AND status = 'ACTIVE'
          LIMIT 1`,
        [ctx.tenantId, campusId],
      );
      if ((activeChildren.rowCount ?? 0) > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'Cannot deactivate a campus that has active departments.',
        );
      }
    }

    const finalName = newName ?? lockedRow.name;
    const finalAddress = newAddress ?? lockedRow.address;
    const finalStatus = input.status ?? lockedRow.status;

    const addressChanged =
      hasAddress && JSON.stringify(finalAddress) !== JSON.stringify(lockedRow.address);

    if (finalName === lockedRow.name && !addressChanged && finalStatus === lockedRow.status) {
      return;
    }

    await tx.query(
      `UPDATE app.campuses
          SET name = $3, address = $4::jsonb, status = $5
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, campusId, finalName, JSON.stringify(finalAddress), finalStatus],
    );

    const changes: Record<string, unknown> = {};
    if (finalName !== lockedRow.name) {
      changes.name = { old: lockedRow.name, new: finalName };
    }
    if (addressChanged) {
      changes.address = { old: lockedRow.address, new: finalAddress };
    }
    if (finalStatus !== lockedRow.status) {
      changes.status = { old: lockedRow.status, new: finalStatus };
    }

    if (Object.keys(changes).length > 0) {
      await recordAudit(
        tx,
        ctx,
        {
          action: 'campus.update',
          resourceType: 'campus',
          resourceId: campusId,
          campusId,
          riskTier: 1,
          changes,
        },
        meta,
      );
    }
  }
}
