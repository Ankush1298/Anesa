import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
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

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const MAX_ADDRESS_BYTES = 4096;

function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

/**
 * Creates campuses. Like RoleAssignmentService this is a service on the caller's tenant transaction: the row
 * and its audit event commit or roll back together. There is deliberately NO update-timezone operation: the
 * runtime role has no UPDATE privilege on campuses.timezone/code (0008), and changing a timezone needs an
 * audited operation that also decides what happens to existing sessions, which does not exist yet.
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
}
