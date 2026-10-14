import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  CODE_PATTERN,
  PERIOD_TYPE_CODE_PATTERN,
  type CohortRecordDto,
  type CohortStatus,
  type CreateCohortBody,
  type CreatePeriodTypeBody,
  type CreateProgramBody,
  type ListCohortsQuery,
  type ListProgramsQuery,
  type PeriodTypeRecordDto,
  type ProgramRecordDto,
  type ProgramStatus,
  type UpdateCohortBody,
  type UpdateProgramBody,
} from './academic.schemas.js';

const CODE_RE = new RegExp(CODE_PATTERN);
const PERIOD_CODE_RE = new RegExp(PERIOD_TYPE_CODE_PATTERN);

function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}
function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Access denied.');
}
function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/** Resolve the department (and its campus) a program hangs off, scoped to the tenant and active. */
async function activeDepartmentScope(
  tx: TenantTx,
  ctx: TrustedContext,
  departmentId: string,
): Promise<{ campusId: string }> {
  const res = await tx.query<{ campus_id: string }>(
    `SELECT campus_id FROM app.departments
      WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [ctx.tenantId, departmentId],
  );
  const row = res.rows[0];
  if (!row) throw resourceNotFound();
  return { campusId: row.campus_id };
}

/**
 * The set of departments the caller may see for a scoped list, from the union of their read/manage
 * grants. ORGANIZATION grant ⇒ every department; CAMPUS grant ⇒ its departments; DEPARTMENT grant ⇒
 * itself. Returns { orgWide } so the caller can skip the id filter entirely.
 */
async function departmentScopeFilter(
  tx: TenantTx,
  ctx: TrustedContext,
  permissions: readonly string[],
): Promise<{ orgWide: boolean; departmentIds: string[] }> {
  const grants = (
    await Promise.all(permissions.map((p) => AuthorizationEngine.loadGrants(tx, ctx, p)))
  ).flat();
  if (grants.some((g) => g.scope_type === 'ORGANIZATION')) {
    return { orgWide: true, departmentIds: [] };
  }
  const directDeptIds = grants
    .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id !== null)
    .map((g) => g.scope_id as string);
  const campusIds = grants
    .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id !== null)
    .map((g) => g.scope_id as string);

  let campusDeptIds: string[] = [];
  if (campusIds.length > 0) {
    const res = await tx.query<{ id: string }>(
      `SELECT id FROM app.departments
        WHERE organization_id = $1 AND campus_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [ctx.tenantId, campusIds],
    );
    campusDeptIds = res.rows.map((r) => r.id);
  }
  return { orgWide: false, departmentIds: [...new Set([...directDeptIds, ...campusDeptIds])] };
}

export class PeriodTypeService {
  /** Creates an org-wide period type. Requires academic.program.manage at ORGANIZATION scope. */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreatePeriodTypeBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Period type payload is required.');

    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!PERIOD_CODE_RE.test(code)) {
      throw invalid('Period type code must be 1 to 30 characters matching the code pattern.');
    }
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (label.length < 1 || label.length > 50) throw invalid('Label must be 1 to 50 characters.');
    const labelPlural = typeof input.labelPlural === 'string' ? input.labelPlural.trim() : '';
    if (labelPlural.length < 1 || labelPlural.length > 50) {
      throw invalid('Plural label must be 1 to 50 characters.');
    }

    // Org-wide config: only an ORGANIZATION-scoped manager may add one (a campus/department-scoped
    // holder cannot prove an org-wide row is within its scope). Mirrors DesignationService.
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage');
    try {
      await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage', {
        organization_id: ctx.tenantId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw forbidden();
      throw err;
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.period_types (id, organization_id, code, label, label_plural)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.tenantId, code, label, labelPlural],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'A period type with this code already exists.');
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.period_type.create',
        resourceType: 'period_type',
        resourceId: id,
        riskTier: 1,
        changes: {
          code: { old: null, new: code },
          label: { old: null, new: label },
          labelPlural: { old: null, new: labelPlural },
        },
      },
      meta,
    );
    return id;
  }

  /** Lists all period types for the tenant. Requires academic.program.read (held in any scope). */
  static async list(tx: TenantTx, ctx: TrustedContext): Promise<PeriodTypeRecordDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');
    const res = await tx.query<{
      id: string;
      organization_id: string;
      code: string;
      label: string;
      label_plural: string;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, organization_id, code, label, label_plural, version, created_at, updated_at
         FROM app.period_types WHERE organization_id = $1 ORDER BY code`,
      [ctx.tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      code: r.code,
      label: r.label,
      labelPlural: r.label_plural,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }
}

interface ProgramRow {
  id: string;
  organization_id: string;
  department_id: string;
  period_type_id: string;
  name: string;
  code: string;
  degree_level: string;
  duration_periods: number;
  periods_per_year: number | null;
  default_regulation: string | null;
  status: ProgramStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const PROGRAM_COLS =
  'id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods, periods_per_year, default_regulation, status, version, created_at, updated_at';

function toProgramDto(r: ProgramRow): ProgramRecordDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    departmentId: r.department_id,
    periodTypeId: r.period_type_id,
    name: r.name,
    code: r.code,
    degreeLevel: r.degree_level,
    durationPeriods: r.duration_periods,
    periodsPerYear: r.periods_per_year,
    defaultRegulation: r.default_regulation,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class ProgramService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateProgramBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Program payload is required.');

    if (!isUuidV7(input.departmentId)) throw invalid('Invalid department ID.');
    if (!isUuidV7(input.periodTypeId)) throw invalid('Invalid period type ID.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) throw invalid('Name must be 1 to 255 characters.');
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!CODE_RE.test(code)) throw invalid('Code must be 1 to 20 characters matching the pattern.');
    const degreeLevel = typeof input.degreeLevel === 'string' ? input.degreeLevel.trim() : '';
    if (degreeLevel.length < 1 || degreeLevel.length > 30) {
      throw invalid('Degree level must be 1 to 30 characters.');
    }
    if (
      !Number.isInteger(input.durationPeriods) ||
      input.durationPeriods < 1 ||
      input.durationPeriods > 100
    ) {
      throw invalid('durationPeriods must be an integer between 1 and 100.');
    }
    if (
      input.periodsPerYear !== undefined &&
      (!Number.isInteger(input.periodsPerYear) ||
        input.periodsPerYear < 1 ||
        input.periodsPerYear > 100)
    ) {
      throw invalid('periodsPerYear must be an integer between 1 and 100.');
    }
    const defaultRegulation =
      input.defaultRegulation === undefined ? null : input.defaultRegulation.trim();
    if (
      defaultRegulation !== null &&
      (defaultRegulation.length < 1 || defaultRegulation.length > 30)
    ) {
      throw invalid('defaultRegulation must be 1 to 30 characters.');
    }

    // Must hold the permission at all (403) before any resource lookup.
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage');

    // The department must exist and be active in this tenant; its campus bounds the scope check.
    const { campusId } = await activeDepartmentScope(tx, ctx, input.departmentId);

    // The period type must exist in this tenant (409 maps duplicate code; a missing ref is a 404).
    const ptRes = await tx.query(
      'SELECT 1 FROM app.period_types WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, input.periodTypeId],
    );
    if ((ptRes.rowCount ?? 0) === 0) throw resourceNotFound();

    // Scope: ORGANIZATION, the department's CAMPUS, or the DEPARTMENT itself.
    try {
      await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage', {
        organization_id: ctx.tenantId,
        campus_id: campusId,
        department_id: input.departmentId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw forbidden();
      throw err;
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.programs
           (id, organization_id, department_id, period_type_id, name, code, degree_level,
            duration_periods, periods_per_year, default_regulation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          ctx.tenantId,
          input.departmentId,
          input.periodTypeId,
          name,
          code,
          degreeLevel,
          input.durationPeriods,
          input.periodsPerYear ?? null,
          defaultRegulation,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'A program with this code already exists.');
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.program.create',
        resourceType: 'program',
        resourceId: id,
        campusId,
        departmentId: input.departmentId,
        riskTier: 1,
        changes: {
          code: { old: null, new: code },
          name: { old: null, new: name },
          degreeLevel: { old: null, new: degreeLevel },
          durationPeriods: { old: null, new: input.durationPeriods },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListProgramsQuery = {},
  ): Promise<ProgramRecordDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');

    const canManage = await AuthorizationEngine.hasPermission(tx, ctx, 'academic.program.manage');
    if (filter.departmentId !== undefined && !isUuidV7(filter.departmentId)) {
      throw invalid('Invalid department ID.');
    }
    if (!canManage && filter.status === 'INACTIVE') return [];

    const scope = await departmentScopeFilter(tx, ctx, [
      'academic.program.read',
      'academic.program.manage',
    ]);
    if (!scope.orgWide && scope.departmentIds.length === 0) return [];

    const conditions = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    if (!scope.orgWide) {
      params.push(scope.departmentIds);
      conditions.push(`department_id = ANY($${params.length}::uuid[])`);
    }
    if (filter.departmentId) {
      params.push(filter.departmentId);
      conditions.push(`department_id = $${params.length}`);
    }
    if (!canManage) {
      conditions.push("status = 'ACTIVE'");
    } else if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const res = await tx.query<ProgramRow>(
      `SELECT ${PROGRAM_COLS} FROM app.programs WHERE ${conditions.join(' AND ')} ORDER BY code`,
      params,
    );
    return res.rows.map(toProgramDto);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    programId: string,
    input: UpdateProgramBody,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    ensureTrusted(ctx);
    if (!isUuidV7(programId)) throw invalid('Invalid program ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');

    const fields: Partial<Record<'name' | 'degreeLevel' | 'defaultRegulation', string>> = {};
    if (input.name !== undefined) {
      const v = typeof input.name === 'string' ? input.name.trim() : '';
      if (v.length < 1 || v.length > 255) throw invalid('Name must be 1 to 255 characters.');
      fields.name = v;
    }
    if (input.degreeLevel !== undefined) {
      const v = typeof input.degreeLevel === 'string' ? input.degreeLevel.trim() : '';
      if (v.length < 1 || v.length > 30) throw invalid('Degree level must be 1 to 30 characters.');
      fields.degreeLevel = v;
    }
    if (input.defaultRegulation !== undefined) {
      const v = typeof input.defaultRegulation === 'string' ? input.defaultRegulation.trim() : '';
      if (v.length < 1 || v.length > 30)
        throw invalid('defaultRegulation must be 1 to 30 characters.');
      fields.defaultRegulation = v;
    }
    if (
      input.durationPeriods !== undefined &&
      (!Number.isInteger(input.durationPeriods) ||
        input.durationPeriods < 1 ||
        input.durationPeriods > 100)
    ) {
      throw invalid('durationPeriods must be an integer between 1 and 100.');
    }
    if (
      input.periodsPerYear !== undefined &&
      (!Number.isInteger(input.periodsPerYear) ||
        input.periodsPerYear < 1 ||
        input.periodsPerYear > 100)
    ) {
      throw invalid('periodsPerYear must be an integer between 1 and 100.');
    }
    if (input.status !== undefined && input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw invalid('Status must be ACTIVE or INACTIVE.');
    }

    await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage');

    const current = await tx.query<ProgramRow>(
      `SELECT ${PROGRAM_COLS} FROM app.programs
        WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, programId],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();

    const { campusId } = await activeDepartmentScope(tx, ctx, row.department_id);
    // Out of scope ⇒ the same 404 as a non-existent program (resource hiding).
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.manage', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
      department_id: row.department_id,
    });

    const finalName = fields.name ?? row.name;
    const finalDegree = fields.degreeLevel ?? row.degree_level;
    const finalDuration = input.durationPeriods ?? row.duration_periods;
    const finalPpy = input.periodsPerYear ?? row.periods_per_year;
    const finalReg = fields.defaultRegulation ?? row.default_regulation;
    const finalStatus = input.status ?? row.status;

    // Deactivation protection: a program with active cohorts cannot be deactivated.
    if (finalStatus === 'INACTIVE' && row.status === 'ACTIVE') {
      const active = await tx.query(
        `SELECT 1 FROM app.cohorts
          WHERE organization_id = $1 AND program_id = $2 AND status = 'ACTIVE' LIMIT 1`,
        [ctx.tenantId, programId],
      );
      if ((active.rowCount ?? 0) > 0) {
        throw new AppError(409, 'CONFLICT', 'Cannot deactivate a program that has active cohorts.');
      }
    }

    const changes: Record<string, unknown> = {};
    if (finalName !== row.name) changes.name = { old: row.name, new: finalName };
    if (finalDegree !== row.degree_level)
      changes.degreeLevel = { old: row.degree_level, new: finalDegree };
    if (finalDuration !== row.duration_periods) {
      changes.durationPeriods = { old: row.duration_periods, new: finalDuration };
    }
    if (finalPpy !== row.periods_per_year)
      changes.periodsPerYear = { old: row.periods_per_year, new: finalPpy };
    if (finalReg !== row.default_regulation) {
      changes.defaultRegulation = { old: row.default_regulation, new: finalReg };
    }
    if (finalStatus !== row.status) changes.status = { old: row.status, new: finalStatus };

    if (Object.keys(changes).length === 0) return;

    await tx.query(
      `UPDATE app.programs
          SET name = $3, degree_level = $4, duration_periods = $5, periods_per_year = $6,
              default_regulation = $7, status = $8
        WHERE organization_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        programId,
        finalName,
        finalDegree,
        finalDuration,
        finalPpy,
        finalReg,
        finalStatus,
      ],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.program.update',
        resourceType: 'program',
        resourceId: programId,
        campusId,
        departmentId: row.department_id,
        riskTier: 1,
        changes,
      },
      meta,
    );
  }
}

interface CohortRow {
  id: string;
  organization_id: string;
  program_id: string;
  admission_year: number;
  intake_code: string;
  name: string;
  regulation: string | null;
  expected_graduation_year: number | null;
  status: CohortStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COHORT_COLS =
  'id, organization_id, program_id, admission_year, intake_code, name, regulation, expected_graduation_year, status, version, created_at, updated_at';

function toCohortDto(r: CohortRow): CohortRecordDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    programId: r.program_id,
    admissionYear: r.admission_year,
    intakeCode: r.intake_code,
    name: r.name,
    regulation: r.regulation,
    expectedGraduationYear: r.expected_graduation_year,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** The program (with its department's campus) a cohort hangs off, scoped to the tenant and active. */
async function activeProgramScope(
  tx: TenantTx,
  ctx: TrustedContext,
  programId: string,
): Promise<{ departmentId: string; campusId: string }> {
  const res = await tx.query<{ department_id: string; campus_id: string }>(
    `SELECT p.department_id, d.campus_id
       FROM app.programs p
       JOIN app.departments d
         ON d.organization_id = p.organization_id AND d.id = p.department_id
      WHERE p.organization_id = $1 AND p.id = $2 AND p.status = 'ACTIVE'
        AND d.status = 'ACTIVE' AND d.deleted_at IS NULL`,
    [ctx.tenantId, programId],
  );
  const row = res.rows[0];
  if (!row) throw resourceNotFound();
  return { departmentId: row.department_id, campusId: row.campus_id };
}

export class CohortService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateCohortBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Cohort payload is required.');

    if (!isUuidV7(input.programId)) throw invalid('Invalid program ID.');
    if (
      !Number.isInteger(input.admissionYear) ||
      input.admissionYear < 1900 ||
      input.admissionYear > 2200
    ) {
      throw invalid('admissionYear must be an integer between 1900 and 2200.');
    }
    const intakeCode = input.intakeCode === undefined ? 'MAIN' : input.intakeCode.trim();
    if (!CODE_RE.test(intakeCode) || intakeCode.length > 10) {
      throw invalid('intakeCode must be 1 to 10 characters matching the code pattern.');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) throw invalid('Name must be 1 to 255 characters.');
    const regulation = input.regulation === undefined ? null : input.regulation.trim();
    if (regulation !== null && (regulation.length < 1 || regulation.length > 30)) {
      throw invalid('regulation must be 1 to 30 characters.');
    }
    const egy = input.expectedGraduationYear ?? null;
    if (egy !== null && (!Number.isInteger(egy) || egy < 1900 || egy > 2200)) {
      throw invalid('expectedGraduationYear must be an integer between 1900 and 2200.');
    }
    if (egy !== null && egy < input.admissionYear) {
      throw invalid('expectedGraduationYear must not be earlier than admissionYear.');
    }

    await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage');

    const { departmentId, campusId } = await activeProgramScope(tx, ctx, input.programId);

    try {
      await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage', {
        organization_id: ctx.tenantId,
        campus_id: campusId,
        department_id: departmentId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw forbidden();
      throw err;
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.cohorts
           (id, organization_id, program_id, admission_year, intake_code, name, regulation, expected_graduation_year)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, input.programId, input.admissionYear, intakeCode, name, regulation, egy],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(
          409,
          'CONFLICT',
          'A cohort with this admission year and intake already exists.',
        );
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.cohort.create',
        resourceType: 'cohort',
        resourceId: id,
        campusId,
        departmentId,
        riskTier: 1,
        changes: {
          admissionYear: { old: null, new: input.admissionYear },
          intakeCode: { old: null, new: intakeCode },
          name: { old: null, new: name },
          status: { old: null, new: 'ACTIVE' },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListCohortsQuery = {},
  ): Promise<CohortRecordDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');
    if (filter.programId !== undefined && !isUuidV7(filter.programId)) {
      throw invalid('Invalid program ID.');
    }

    const scope = await departmentScopeFilter(tx, ctx, [
      'academic.program.read',
      'academic.cohort.manage',
    ]);
    if (!scope.orgWide && scope.departmentIds.length === 0) return [];

    // Cohorts are scoped through their program's department.
    const conditions = ['c.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    if (!scope.orgWide) {
      params.push(scope.departmentIds);
      conditions.push(`p.department_id = ANY($${params.length}::uuid[])`);
    }
    if (filter.programId) {
      params.push(filter.programId);
      conditions.push(`c.program_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`c.status = $${params.length}`);
    }

    const res = await tx.query<CohortRow>(
      `SELECT ${COHORT_COLS.split(', ')
        .map((c) => `c.${c}`)
        .join(', ')}
         FROM app.cohorts c
         JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.admission_year DESC, c.intake_code`,
      params,
    );
    return res.rows.map(toCohortDto);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    cohortId: string,
    input: UpdateCohortBody,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    ensureTrusted(ctx);
    if (!isUuidV7(cohortId)) throw invalid('Invalid cohort ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');

    let newName: string | undefined;
    if (input.name !== undefined) {
      newName = typeof input.name === 'string' ? input.name.trim() : '';
      if (newName.length < 1 || newName.length > 255)
        throw invalid('Name must be 1 to 255 characters.');
    }
    let newReg: string | undefined;
    if (input.regulation !== undefined) {
      newReg = typeof input.regulation === 'string' ? input.regulation.trim() : '';
      if (newReg.length < 1 || newReg.length > 30)
        throw invalid('regulation must be 1 to 30 characters.');
    }
    if (
      input.expectedGraduationYear !== undefined &&
      (!Number.isInteger(input.expectedGraduationYear) ||
        input.expectedGraduationYear < 1900 ||
        input.expectedGraduationYear > 2200)
    ) {
      throw invalid('expectedGraduationYear must be an integer between 1900 and 2200.');
    }
    if (
      input.status !== undefined &&
      input.status !== 'ACTIVE' &&
      input.status !== 'GRADUATED' &&
      input.status !== 'CLOSED'
    ) {
      throw invalid('Status must be ACTIVE, GRADUATED, or CLOSED.');
    }

    await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage');

    const current = await tx.query<CohortRow>(
      `SELECT ${COHORT_COLS} FROM app.cohorts
        WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, cohortId],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();

    const { departmentId, campusId } = await activeProgramScope(tx, ctx, row.program_id);
    await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
      department_id: departmentId,
    });

    const finalName = newName ?? row.name;
    const finalReg = newReg ?? row.regulation;
    const finalEgy = input.expectedGraduationYear ?? row.expected_graduation_year;
    const finalStatus = input.status ?? row.status;

    if (finalEgy !== null && finalEgy < row.admission_year) {
      throw invalid('expectedGraduationYear must not be earlier than admissionYear.');
    }

    const changes: Record<string, unknown> = {};
    if (finalName !== row.name) changes.name = { old: row.name, new: finalName };
    if (finalReg !== row.regulation) changes.regulation = { old: row.regulation, new: finalReg };
    if (finalEgy !== row.expected_graduation_year) {
      changes.expectedGraduationYear = { old: row.expected_graduation_year, new: finalEgy };
    }
    if (finalStatus !== row.status) changes.status = { old: row.status, new: finalStatus };

    if (Object.keys(changes).length === 0) return;

    // A cohort that still has an ACTIVE student enrolment must stay ACTIVE: the enrolment service share-locks the cohort
    // (the migration 0021 guard does too) and requires it ACTIVE. This runs after our FOR NO KEY UPDATE lock on the
    // cohort, so it either waits for an opening transaction and sees its committed row (READ COMMITTED: fresh snapshot per
    // statement) or the opener's recheck sees the new status. A plain read, no lock above the cohort is requested.
    if (row.status === 'ACTIVE' && finalStatus !== 'ACTIVE') {
      const enrolled = await tx.query(
        `SELECT 1 FROM app.student_programs
          WHERE organization_id = $1 AND cohort_id = $2 AND status = 'ACTIVE' LIMIT 1`,
        [ctx.tenantId, cohortId],
      );
      if ((enrolled.rowCount ?? 0) > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'Cannot close or graduate a cohort that has active student enrolments.',
        );
      }
    }

    await tx.query(
      `UPDATE app.cohorts
          SET name = $3, regulation = $4, expected_graduation_year = $5, status = $6
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, cohortId, finalName, finalReg, finalEgy, finalStatus],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.cohort.update',
        resourceType: 'cohort',
        resourceId: cohortId,
        campusId,
        departmentId,
        riskTier: 1,
        changes,
      },
      meta,
    );
  }
}
