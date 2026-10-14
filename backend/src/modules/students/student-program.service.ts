import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { invalid, parseDate, parseReason } from '../people/validation.js';

export const OPEN_STUDENT_PROGRAM_OPERATION = 'POST /api/v1/students/:id/programs';
export const PROGRAM_ASSIGN_PERMISSION = 'student.program.assign';

/** The terminal outcomes a close may record (migration 0021: ACTIVE -> one of these; closed rows are terminal). */
export const CLOSE_OUTCOMES = ['COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED'] as const;
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number];

/** Student statuses that may be enrolled (design decision for Phase 3a: "ADMITTED" is what creation produces). */
const ENROLLABLE_STUDENT_STATUSES: readonly string[] = ['ADMITTED', 'ACTIVE'];

export interface OpenStudentProgramInput {
  programId: string;
  cohortId: string;
  startDate: string;
  reason: string;
}
export interface CloseStudentProgramInput {
  outcome: CloseOutcome;
  endDate: string;
  reason: string;
}
export interface StudentProgramDto {
  id: string;
  studentId: string;
  programId: string;
  cohortId: string;
  campusId: string;
  departmentId: string;
  startDate: string;
  endDate: string | null;
  status: string;
  entryType: string;
  exitReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface EnrolmentRow {
  id: string;
  student_id: string;
  program_id: string;
  cohort_id: string;
  campus_id: string;
  department_id: string;
  start_date: string;
  end_date: string | null;
  status: string;
  entry_type: string;
  exit_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
// Dates as text: the pg driver would build a JS Date in the server time zone and a calendar date could shift.
const COLS = `id, student_id, program_id, cohort_id, campus_id, department_id, start_date::text AS start_date,
              end_date::text AS end_date, status, entry_type, exit_reason, version, created_at, updated_at`;
const toDto = (r: EnrolmentRow): StudentProgramDto => ({
  id: r.id,
  studentId: r.student_id,
  programId: r.program_id,
  cohortId: r.cohort_id,
  campusId: r.campus_id,
  departmentId: r.department_id,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  entryType: r.entry_type,
  exitReason: r.exit_reason,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}
const conflict = (message: string): AppError => new AppError(409, 'CONFLICT', message);

/**
 * Opening and closing a student's program enrolment (`app.student_programs`, migration 0021). Service layer only: no
 * route, no list, no ON_LEAVE, no transfer/readmission, and `students.status` is never written.
 *
 * AUTHORIZATION. `student.program.assign` is GRANTED (scope = the assignment's campus/department). The resource scope is
 * ALWAYS read from the database: for an open, the target program's department and its campus; for a close, the
 * enrolment's own frozen campus/department. Caller-supplied scope identifiers do not exist. Held at all ⇒ 403; out of
 * scope, missing, inactive or soft-deleted ⇒ the same 404.
 *
 * LOCK ORDER (open): student (FOR NO KEY UPDATE) -> campus -> department -> program -> cohort (each FOR SHARE, status
 * re-checked in the same statement) -> INSERT enrolment -> INSERT event -> audit. Top-down only: no lock on a higher
 * structure is ever requested after a lower one, and the step 2B guards (department deactivate/soft-delete, cohort
 * leaving ACTIVE) take their own FOR NO KEY UPDATE and then only READ. A deactivation that is waiting therefore sees our
 * committed enrolment (READ COMMITTED, fresh snapshot per statement) and is refused; one that committed first leaves our
 * FOR SHARE with zero rows. Close locks only the enrolment row. The user row is never locked and no person advisory lock
 * is needed: an enrolment touches neither role assignments nor user_id.
 *
 * WRITE ORDER (migration 0021 event guard): the enrolment is written first, then its event, because the guard reads
 * the enrolment row as this transaction left it; the audit record comes last. Everything shares the caller's transaction.
 */
export class StudentProgramService {
  /**
   * Opens a REGULAR enrolment, idempotently. Order: request shape (400) -> permission held (403) -> target-program scope
   * (404) -> Idempotency-Key (428/400) -> claim/replay (422 on reuse) -> locks and state checks -> writes. Returns the
   * 201 `{ success, data: { id } }` response (replays flagged by `replayed`).
   */
  static async open(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: OpenStudentProgramInput,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    // Staff only, before the key claim and every row lock (refuses STUDENT and any unknown kind with 403).
    AuthorizationEngine.assertStaffActor(ctx);
    if (!input || typeof input !== 'object') throw invalid('Enrolment payload is required.');
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    if (!isUuidV7(input.programId)) throw invalid('Invalid program ID.');
    if (!isUuidV7(input.cohortId)) throw invalid('Invalid cohort ID.');
    const student = studentId.toLowerCase();
    const programId = input.programId.toLowerCase();
    const cohortId = input.cohortId.toLowerCase();
    const startDate = parseDate(input.startDate, 'startDate');
    const reason = parseReason(input.reason);

    await AuthorizationEngine.assert(tx, ctx, PROGRAM_ASSIGN_PERMISSION);

    // Scope from the database: the program's department and that department's campus (both immutable once created).
    // Unlocked on purpose; the locked statements below re-verify every relation and state.
    const target = await tx.query<{ department_id: string; campus_id: string }>(
      `SELECT p.department_id, d.campus_id
         FROM app.programs p
         JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
        WHERE p.organization_id = $1 AND p.id = $2`,
      [ctx.tenantId, programId],
    );
    const scope = target.rows[0];
    if (!scope) throw resourceNotFound();
    await AuthorizationEngine.assert(tx, ctx, PROGRAM_ASSIGN_PERMISSION, {
      organization_id: ctx.tenantId,
      campus_id: scope.campus_id,
      department_id: scope.department_id,
    });

    // Only an authorized caller learns whether its key header is acceptable. Done BEFORE the claim and the locks.
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: OPEN_STUDENT_PROGRAM_OPERATION,
        // The NORMALISED request, including the path's student id: reason trimmed, ids lower-cased.
        request: { studentId: student, programId, cohortId, startDate, reason },
      },
      async () => {
        // 1. student
        const s = await tx.query<{ status: string; admission_date: string | null }>(
          `SELECT status, admission_date::text AS admission_date FROM app.students
            WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
          [ctx.tenantId, student],
        );
        const stu = s.rows[0];
        if (!stu) throw resourceNotFound();

        // 2-5. structure, top-down, each re-checked ACTIVE under its own share lock
        const campus = await tx.query<{ today: string }>(
          `SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM app.campuses
            WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' FOR SHARE`,
          [ctx.tenantId, scope.campus_id],
        );
        const today = campus.rows[0]?.today;
        if (!today) throw resourceNotFound();
        const lock = async (sql: string, params: unknown[]) => {
          const r = await tx.query<{ status?: string }>(sql, params);
          const row = r.rows[0];
          if (!row) throw resourceNotFound();
          return row;
        };
        await lock(
          `SELECT 1 FROM app.departments
            WHERE organization_id = $1 AND id = $2 AND campus_id = $3 AND status = 'ACTIVE' AND deleted_at IS NULL
              FOR SHARE`,
          [ctx.tenantId, scope.department_id, scope.campus_id],
        );
        await lock(
          `SELECT 1 FROM app.programs
            WHERE organization_id = $1 AND id = $2 AND department_id = $3 AND status = 'ACTIVE' FOR SHARE`,
          [ctx.tenantId, programId, scope.department_id],
        );
        // A cohort of another program is "not found under that program" (404); a cohort that is no longer open is a state.
        const cohort = await lock(
          `SELECT status FROM app.cohorts
            WHERE organization_id = $1 AND id = $2 AND program_id = $3 FOR SHARE`,
          [ctx.tenantId, cohortId, programId],
        );
        if (cohort.status !== 'ACTIVE') throw conflict('The cohort is not open for enrolment.');

        // 6. student rules, now that the student row is locked
        // Generic bodies on purpose: the caller's permission is about the PROGRAM's scope, not about the student, so the
        // answer must not reveal the student's status or whether/when they were admitted (same text for both 409s).
        if (!ENROLLABLE_STUDENT_STATUSES.includes(stu.status) || stu.admission_date === null) {
          throw conflict('The student cannot be enrolled in a program.');
        }
        if (startDate < stu.admission_date) {
          throw invalid('startDate is not acceptable for this student.');
        }
        if (startDate > today) {
          throw invalid("startDate must not be in the future for the campus's local date.");
        }

        // 7. at most one ACTIVE enrolment; a placement the caller cannot see is reported as 404, not as a conflict
        const active = await tx.query<{ campus_id: string; department_id: string }>(
          `SELECT campus_id, department_id FROM app.student_programs
            WHERE organization_id = $1 AND student_id = $2 AND status = 'ACTIVE'`,
          [ctx.tenantId, student],
        );
        const existing = active.rows[0];
        if (existing) {
          await AuthorizationEngine.assert(tx, ctx, PROGRAM_ASSIGN_PERMISSION, {
            organization_id: ctx.tenantId,
            campus_id: existing.campus_id,
            department_id: existing.department_id,
          });
          throw conflict('The student already has an active program enrolment.');
        }

        // 8. writes: enrolment, then its OPENED event (migration 0021 guard), then audit
        const id = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.student_programs
               (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date,
                status, entry_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, 'ACTIVE', 'REGULAR')`,
            [
              id,
              ctx.tenantId,
              student,
              programId,
              cohortId,
              scope.campus_id,
              scope.department_id,
              startDate,
            ],
          );
        } catch (err) {
          const e = err as { code?: string; constraint?: string };
          // Narrow mappings only (race losers of the database guards); everything else propagates.
          if (e.code === '23505' && e.constraint === 'student_programs_one_active_uq') {
            throw conflict('The student already has an active program enrolment.');
          }
          if (e.code === '23514' && e.constraint === 'student_programs_cohort_active_ck') {
            throw conflict('The cohort is not open for enrolment.');
          }
          throw err;
        }
        await tx.query(
          `INSERT INTO app.student_program_events
             (id, organization_id, student_program_id, student_id, event_type, from_status, to_status,
              effective_date, reason, actor_user_id)
           VALUES ($1, $2, $3, $4, 'OPENED', NULL, 'ACTIVE', $5::date, $6, $7)`,
          [uuidv7(), ctx.tenantId, id, student, startDate, reason, ctx.userId],
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'student_program.open',
            resourceType: 'student_program',
            resourceId: id,
            subjectStudentId: student,
            campusId: scope.campus_id,
            departmentId: scope.department_id,
            riskTier: 2,
            reasonText: reason,
            changes: {
              programId: { old: null, new: programId },
              cohortId: { old: null, new: cohortId },
              startDate: { old: null, new: startDate },
              entryType: { old: null, new: 'REGULAR' },
              status: { old: null, new: 'ACTIVE' },
            },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id } } };
      },
    );
  }

  /**
   * Closes an ACTIVE enrolment as COMPLETED, TRANSFERRED_OUT or DISCONTINUED. Order: shape (400) -> permission (403) ->
   * row lock, missing/out-of-scope (404) -> expected version (409) -> lifecycle state (409) -> dates (400) -> writes.
   * Not idempotent by key (like the employee update): a retry after success meets the version/terminal-state conflict.
   * The optional `studentId` (from a route path) must match the enrolment's student, else 404. Returns the updated enrolment (its `version` is the new ETag).
   */
  static async close(
    tx: TenantTx,
    ctx: TrustedContext,
    studentProgramId: string,
    input: CloseStudentProgramInput,
    options: { expected: ExpectedVersion; studentId?: string; meta?: AuditRequestMeta },
  ): Promise<StudentProgramDto> {
    ensureTrusted(ctx);
    // Staff only, before the enrolment row lock (refuses STUDENT and any unknown kind with 403).
    AuthorizationEngine.assertStaffActor(ctx);
    if (!input || typeof input !== 'object') throw invalid('Close payload is required.');
    if (!isUuidV7(studentProgramId)) throw invalid('Invalid enrolment ID.');
    const id = studentProgramId.toLowerCase();
    if (!(CLOSE_OUTCOMES as readonly unknown[]).includes(input.outcome)) {
      throw invalid(`Outcome must be one of ${CLOSE_OUTCOMES.join(', ')}.`);
    }
    const outcome = input.outcome;
    const endDate = parseDate(input.endDate, 'endDate');
    const reason = parseReason(input.reason);

    await AuthorizationEngine.assert(tx, ctx, PROGRAM_ASSIGN_PERMISSION);

    const current = await tx.query<EnrolmentRow>(
      `SELECT ${COLS} FROM app.student_programs WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, id],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();
    // The enrolment's own FROZEN campus/department, never a caller value.
    await AuthorizationEngine.assert(tx, ctx, PROGRAM_ASSIGN_PERMISSION, {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
      department_id: row.department_id,
    });

    // A route that names the student in its path (POST /students/:id/programs/:pid/close) passes it here: an enrolment of
    // another student is "not found under that student", the same 404 as a missing one (after the scope check, so a
    // caller outside the scope learns nothing either way).
    if (options.studentId !== undefined && options.studentId.toLowerCase() !== row.student_id) {
      throw resourceNotFound();
    }

    // Only now may the caller learn anything about the stored version or state.
    const exp = options.expected;
    if (exp.type === 'initial' || (exp.type === 'version' && exp.version !== row.version)) {
      throw conflict('Enrolment version mismatch.');
    }
    if (row.status !== 'ACTIVE') throw conflict('Only an ACTIVE enrolment can be closed.');

    // Plain read, no lock: closing stays possible whatever the state of the structure above.
    const campus = await tx.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM app.campuses
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, row.campus_id],
    );
    const today = campus.rows[0]?.today;
    if (!today) throw resourceNotFound();
    if (endDate < row.start_date) throw invalid('endDate must not be earlier than startDate.');
    if (endDate > today) {
      throw invalid("endDate must not be in the future for the campus's local date.");
    }

    const updated = await tx.query<EnrolmentRow>(
      `UPDATE app.student_programs
          SET status = $3, end_date = $4::date, exit_reason = $5
        WHERE organization_id = $1 AND id = $2 AND version = $6 AND status = 'ACTIVE'
        RETURNING ${COLS}`,
      [ctx.tenantId, id, outcome, endDate, reason, row.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw conflict('Enrolment was changed concurrently. Retry.');

    await tx.query(
      `INSERT INTO app.student_program_events
         (id, organization_id, student_program_id, student_id, event_type, from_status, to_status,
          effective_date, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, 'CLOSED', 'ACTIVE', $5, $6::date, $7, $8)`,
      [uuidv7(), ctx.tenantId, id, row.student_id, outcome, endDate, reason, ctx.userId],
    );
    await recordAudit(
      tx,
      ctx,
      {
        action: 'student_program.close',
        resourceType: 'student_program',
        resourceId: id,
        subjectStudentId: row.student_id,
        campusId: row.campus_id,
        departmentId: row.department_id,
        riskTier: 2,
        reasonText: reason,
        changes: {
          status: { old: 'ACTIVE', new: outcome },
          endDate: { old: null, new: endDate },
          exitReason: { old: null, new: reason },
        },
      },
      options.meta ?? {},
    );
    return toDto(saved);
  }
}
