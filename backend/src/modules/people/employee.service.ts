import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import {
  EMPLOYEE_CODE_PATTERN,
  EMPLOYEE_STATUSES,
  EMPLOYEE_TYPES,
  MAX_PAGE_SIZE,
  type CreateEmployeeBody,
  type EmployeeRecordDto,
  type EmployeeStatus,
  type EmployeeType,
  type ListEmployeesQuery,
  type UpdateEmployeeBody,
} from './employee.schemas.js';
import { lockPersonIdentity } from '../../shared/authorization/person-identity.js';
import { invalid, parseDate, parseReason } from './validation.js';

const CODE_RE = new RegExp(EMPLOYEE_CODE_PATTERN);
const DEFAULT_LIMIT = MAX_PAGE_SIZE;

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface EmployeeRow {
  id: string;
  organization_id: string;
  user_id: string;
  employee_code: string;
  employee_type: EmployeeType;
  joining_date: string;
  leaving_date: string | null;
  status: EmployeeStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// Dates are selected as text: the pg driver would otherwise build a JS Date in the server's time zone and a
// calendar date could shift by a day.
const COLS = `id, organization_id, user_id, employee_code, employee_type,
              joining_date::text AS joining_date, leaving_date::text AS leaving_date,
              status, version, created_at, updated_at`;

function toDto(r: EmployeeRow): EmployeeRecordDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    employeeCode: r.employee_code,
    employeeType: r.employee_type,
    joiningDate: r.joining_date,
    leavingDate: r.leaving_date,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Employee role records (doc 02 §4.4, ADR-003: the account is `users`, the employee is a role record).
 *
 * SCOPE: employees carry no campus/department until employee_postings exist (M2, doc 08 §5), so a CAMPUS- or
 * DEPARTMENT-scoped grant can never be proven to contain a record. The engine therefore denies it (fail closed);
 * only ORGANIZATION-scoped GRANTED holders reach arbitrary records, and a SELF holder reaches their own.
 */
export class EmployeeService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateEmployeeBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Employee payload is required.');

    // Shape first: no database access, nothing about the tenant is revealed.
    if (!isUuidV7(input.userId)) throw invalid('Invalid user ID.');
    const code = typeof input.employeeCode === 'string' ? input.employeeCode.trim() : '';
    if (!CODE_RE.test(code)) {
      throw invalid('Employee code must be 1 to 50 letters, digits, "-" or "_".');
    }
    if (!(EMPLOYEE_TYPES as readonly string[]).includes(input.employeeType)) {
      throw invalid(`Employee type must be one of ${EMPLOYEE_TYPES.join(', ')}.`);
    }
    const joiningDate = parseDate(input.joiningDate, 'joiningDate');
    const reason = parseReason(input.reason);

    // FIRST database statement: the per-person lock shared with student creation and role grants. Employee creation
    // gains no role-eligibility rule from it; it only joins the common lock order (shared/authorization/person-identity.ts).
    await lockPersonIdentity(tx, ctx.tenantId, input.userId);

    // Authorization: held at all (403), then ORGANIZATION scope (403): a record has no campus/department to be
    // contained in, so a scoped holder cannot create one.
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.create');
    try {
      await AuthorizationEngine.assert(tx, ctx, 'employee.record.create', {
        organization_id: ctx.tenantId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied.');
      }
      throw err;
    }

    // Relationship: the account must exist in THIS tenant (RLS + the explicit filter make another tenant's user
    // indistinguishable from a missing one). Share-locked so it cannot be deactivated mid-transaction.
    const user = await tx.query<{ status: string }>(
      `SELECT status FROM app.users WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, input.userId],
    );
    const account = user.rows[0];
    if (!account) throw resourceNotFound();
    if (account.status === 'DEACTIVATED') {
      throw new AppError(
        409,
        'CONFLICT',
        'A deactivated account cannot be given an employee record.',
      );
    }
    // actor_kind is derived from the students mapping (auth.service): a user holding both records would be a
    // STUDENT actor and could never exercise staff permissions. Refuse the combination.
    const student = await tx.query(
      'SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2',
      [ctx.tenantId, input.userId],
    );
    if ((student.rowCount ?? 0) > 0) {
      throw new AppError(409, 'CONFLICT', 'This account already has a student record.');
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.employees
           (id, organization_id, user_id, employee_code, employee_type, joining_date)
         VALUES ($1, $2, $3, $4, $5, $6::date)`,
        [id, ctx.tenantId, input.userId, code, input.employeeType, joiningDate],
      );
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      // Race loser of the database guard (migration 0016): a student record for this account committed after the
      // check above. Only this exact code AND constraint is mapped; any other 23P01 stays an unexpected error.
      if (e.code === '23P01' && e.constraint === 'person_record_exclusive') {
        throw new AppError(409, 'CONFLICT', 'This account already has a student record.');
      }
      if (e.code === '23505') {
        throw new AppError(
          409,
          'CONFLICT',
          e.constraint === 'employees_org_user_uq'
            ? 'This account already has an employee record.'
            : 'An employee with this code already exists.',
        );
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'employee.create',
        resourceType: 'employee',
        resourceId: id,
        riskTier: 2,
        reasonText: reason,
        changes: {
          userId: { old: null, new: input.userId },
          employeeCode: { old: null, new: code },
          employeeType: { old: null, new: input.employeeType },
          joiningDate: { old: null, new: joiningDate },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );
    return id;
  }

  /** One record. Not held ⇒ 403; missing OR out of scope ⇒ the same 404. No audit on read. */
  static async getById(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
  ): Promise<EmployeeRecordDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(employeeId)) throw invalid('Invalid employee ID.');
    await AuthorizationEngine.assert(tx, ctx, 'employee.profile.read');

    const res = await tx.query<EmployeeRow>(
      `SELECT ${COLS} FROM app.employees WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, employeeId],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    // user_id lets a SELF holder prove the record is their own; no campus/department can be supplied (see class doc).
    await AuthorizationEngine.assert(tx, ctx, 'employee.profile.read', {
      organization_id: ctx.tenantId,
      user_id: row.user_id,
    });
    return toDto(row);
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListEmployeesQuery = {},
  ): Promise<EmployeeRecordDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'employee.profile.read');
    if (
      filter.status !== undefined &&
      !(EMPLOYEE_STATUSES as readonly string[]).includes(filter.status)
    ) {
      throw invalid('Invalid status filter.');
    }
    if (
      filter.employeeType !== undefined &&
      !(EMPLOYEE_TYPES as readonly string[]).includes(filter.employeeType)
    ) {
      throw invalid('Invalid employeeType filter.');
    }

    if (
      filter.limit !== undefined &&
      (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE_SIZE)
    ) {
      throw invalid(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
    }
    if (filter.offset !== undefined && (!Number.isInteger(filter.offset) || filter.offset < 0)) {
      throw invalid('offset must be a non-negative integer.');
    }

    // Effective visibility. The grant's scope_mode matters: a FACULTY assignment sits at ORGANIZATION scope but in
    // SELF mode, which must never be read as organization-wide access.
    const grants = await AuthorizationEngine.loadGrants(tx, ctx, 'employee.profile.read');
    const all = grants.some((g) => g.scope_mode === 'GRANTED' && g.scope_type === 'ORGANIZATION');
    const own = grants.some((g) => g.scope_mode === 'SELF');
    if (!all && !own) return []; // campus/department-scoped only: containment cannot be proven

    const conditions = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    if (!all) {
      params.push(ctx.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.employeeType) {
      params.push(filter.employeeType);
      conditions.push(`employee_type = $${params.length}`);
    }
    params.push(filter.limit ?? DEFAULT_LIMIT, filter.offset ?? 0);

    const res = await tx.query<EmployeeRow>(
      `SELECT ${COLS} FROM app.employees
        WHERE ${conditions.join(' AND ')}
        ORDER BY employee_code, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows.map(toDto);
  }

  /**
   * Updates employment facts. user_id and employee_code are immutable. Optimistic concurrency (doc 08 §4.1):
   * `expected` is checked under the row lock, and the UPDATE repeats the version predicate.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
    input: UpdateEmployeeBody,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<EmployeeRecordDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(employeeId)) throw invalid('Invalid employee ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');

    const reason = parseReason(input.reason);
    if (
      input.employeeType === undefined &&
      input.joiningDate === undefined &&
      input.leavingDate === undefined &&
      input.status === undefined
    ) {
      throw invalid('At least one field to change must be provided.');
    }
    if (
      input.employeeType !== undefined &&
      !(EMPLOYEE_TYPES as readonly string[]).includes(input.employeeType)
    ) {
      throw invalid(`Employee type must be one of ${EMPLOYEE_TYPES.join(', ')}.`);
    }
    if (
      input.status !== undefined &&
      !(EMPLOYEE_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw invalid(`Status must be one of ${EMPLOYEE_STATUSES.join(', ')}.`);
    }
    const newJoining =
      input.joiningDate === undefined ? undefined : parseDate(input.joiningDate, 'joiningDate');
    // undefined = leave unchanged, null = clear, string = set. Independent of status (no coupling is specified).
    const newLeaving =
      input.leavingDate === undefined || input.leavingDate === null
        ? input.leavingDate
        : parseDate(input.leavingDate, 'leavingDate');

    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update');

    const current = await tx.query<EmployeeRow>(
      `SELECT ${COLS} FROM app.employees
        WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, employeeId],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();
    // Out of scope (anything but ORGANIZATION: see class doc) ⇒ the same 404 as a missing record.
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update', {
      organization_id: ctx.tenantId,
      user_id: row.user_id,
    });

    // Only now, after authorization, may the caller learn anything about the stored version.
    const exp = options.expected;
    if (exp.type === 'initial' || (exp.type === 'version' && exp.version !== row.version)) {
      throw new AppError(409, 'CONFLICT', 'Employee version mismatch.');
    }

    const finalType = input.employeeType ?? row.employee_type;
    const finalJoining = newJoining ?? row.joining_date;
    const finalStatus = input.status ?? row.status;
    const finalLeaving = newLeaving === undefined ? row.leaving_date : newLeaving;
    if (finalLeaving !== null && finalLeaving < finalJoining) {
      throw invalid('leavingDate must not be earlier than joiningDate.');
    }

    const changes: Record<string, unknown> = {};
    if (finalType !== row.employee_type) {
      changes.employeeType = { old: row.employee_type, new: finalType };
    }
    if (finalJoining !== row.joining_date) {
      changes.joiningDate = { old: row.joining_date, new: finalJoining };
    }
    if (finalLeaving !== row.leaving_date) {
      changes.leavingDate = { old: row.leaving_date, new: finalLeaving };
    }
    if (finalStatus !== row.status) changes.status = { old: row.status, new: finalStatus };
    if (Object.keys(changes).length === 0) return toDto(row); // no-op: no version bump, no audit

    const updated = await tx.query<EmployeeRow>(
      `UPDATE app.employees
          SET employee_type = $3, joining_date = $4::date, leaving_date = $5::date, status = $6
        WHERE organization_id = $1 AND id = $2 AND version = $7
        RETURNING ${COLS}`,
      [ctx.tenantId, employeeId, finalType, finalJoining, finalLeaving, finalStatus, row.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'Employee was changed concurrently. Retry.');

    await recordAudit(
      tx,
      ctx,
      {
        action: 'employee.update',
        resourceType: 'employee',
        resourceId: employeeId,
        riskTier: 2,
        reasonText: reason,
        changes,
      },
      options.meta ?? {},
    );
    return toDto(saved);
  }
}
