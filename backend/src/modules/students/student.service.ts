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
import { invalid, parseDate, parseReason } from '../people/validation.js';
import {
  ADMISSION_NUMBER_PATTERN,
  type CreateStudentBody,
  type StudentRecordDto,
  type StudentStatus,
} from './student.schemas.js';

const ADMISSION_NUMBER_RE = new RegExp(ADMISSION_NUMBER_PATTERN);
export const CREATE_STUDENT_OPERATION = 'POST /api/v1/students';

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface StudentRow {
  id: string;
  organization_id: string;
  user_id: string;
  admission_number: string;
  admission_date: string | null;
  status: StudentStatus;
  status_changed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// Dates are selected as text: the pg driver would otherwise build a JS Date in the server's time zone and a
// calendar date could shift by a day.
const COLS = `id, organization_id, user_id, admission_number, admission_date::text AS admission_date,
              status, status_changed_at, version, created_at, updated_at`;

function toDto(r: StudentRow): StudentRecordDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    admissionNumber: r.admission_number,
    admissionDate: r.admission_date,
    status: r.status,
    statusChangedAt: r.status_changed_at ? r.status_changed_at.toISOString() : null,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Student role records (doc 02 §4.4, ADR-003: the account is `users`, the student is a role record).
 *
 * SCOPE: a student has no campus/department of its own until `student_programs` exist (doc 06 derives it from the active
 * program), so a CAMPUS- or DEPARTMENT-scoped grant can never be proven to contain a record. The engine denies it (fail
 * closed); only ORGANIZATION-scoped GRANTED holders reach arbitrary records, and a SELF holder reaches their own.
 *
 * Phase 2 scope: create and read of one record. No list, update, status transition, program enrolment or number
 * allocation.
 */
export class StudentService {
  /**
   * Creates a student record for an existing ACTIVE account, idempotently (`Idempotency-Key`, shared mechanism).
   * Order: request shape (400) → permission (403) → organization scope (403) → key (428/400) → claim/replay (422) →
   * account and relationship checks (404/409) → insert → audit. Everything after the claim shares one transaction.
   */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateStudentBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Student payload is required.');

    // Shape first: no database access, nothing about the tenant is revealed.
    if (!isUuidV7(input.userId)) throw invalid('Invalid user ID.');
    const userId = input.userId.toLowerCase();
    const admissionNumber = typeof input.admissionNumber === 'string' ? input.admissionNumber : '';
    if (!ADMISSION_NUMBER_RE.test(admissionNumber)) {
      throw invalid('Admission number must be 1 to 50 letters, digits, "-" or "_".');
    }
    const admissionDate = parseDate(input.admissionDate, 'admissionDate');
    const reason = parseReason(input.reason);

    // Authorization: held at all (403), then ORGANIZATION scope (403): a student has no campus/department yet, so a
    // scoped holder cannot create one.
    await AuthorizationEngine.assert(tx, ctx, 'student.record.create');
    try {
      await AuthorizationEngine.assert(tx, ctx, 'student.record.create', {
        organization_id: ctx.tenantId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied.');
      }
      throw err;
    }

    // Only an authorized caller learns whether its key header is acceptable.
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: CREATE_STUDENT_OPERATION,
        // The NORMALISED request: reason is trimmed and the id lower-cased, so equal requests hash equally.
        request: { userId, admissionNumber, admissionDate, reason },
      },
      async () => {
        // FOR UPDATE (not FOR SHARE): it conflicts with the FOR KEY SHARE lock a concurrent role grant takes on the
        // account through its foreign key, so a grant that is in flight is either seen by the check below or waits.
        // This closes only THIS direction; see docs/architecture/v3/21-students.md §6 for the remaining gap.
        const user = await tx.query<{ status: string }>(
          `SELECT status FROM app.users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [ctx.tenantId, userId],
        );
        const account = user.rows[0];
        if (!account) throw resourceNotFound(); // missing and other-tenant are indistinguishable (RLS + filter)
        if (account.status !== 'ACTIVE') {
          throw new AppError(
            409,
            'CONFLICT',
            'Only an ACTIVE account can be given a student record.',
          );
        }

        // actor_kind is derived from the students mapping: a student record turns the account into a STUDENT actor
        // whose staff permissions stop working. Refuse any account with an active role assignment, the creator's own
        // included. Predicate verbatim from AuthorizationEngine.loadGrants (docs 21 §6).
        if (await AuthorizationEngine.hasActiveAssignment(tx, ctx.tenantId, userId)) {
          throw new AppError(
            409,
            'CONFLICT',
            'This account holds an active role assignment and cannot be given a student record.',
          );
        }

        // Friendly early answer; the race-free guarantee is the database guard of migration 0016 (mapped below).
        const employee = await tx.query(
          'SELECT 1 FROM app.employees WHERE organization_id = $1 AND user_id = $2',
          [ctx.tenantId, userId],
        );
        if ((employee.rowCount ?? 0) > 0) {
          throw new AppError(409, 'CONFLICT', 'This account already has an employee record.');
        }

        const id = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.students
               (id, organization_id, user_id, admission_number, admission_date, status)
             VALUES ($1, $2, $3, $4, $5::date, 'ADMITTED')`,
            [id, ctx.tenantId, userId, admissionNumber, admissionDate],
          );
        } catch (err) {
          const e = err as { code?: string; constraint?: string };
          // Race loser of the exclusivity guard (migration 0016). Only this exact code AND constraint is mapped.
          if (e.code === '23P01' && e.constraint === 'person_record_exclusive') {
            throw new AppError(409, 'CONFLICT', 'This account already has an employee record.');
          }
          if (e.code === '23505') {
            throw new AppError(
              409,
              'CONFLICT',
              e.constraint === 'students_org_user_uq'
                ? 'This account already has a student record.'
                : 'A student with this admission number already exists.',
            );
          }
          throw err;
        }

        await recordAudit(
          tx,
          ctx,
          {
            action: 'student.record.create',
            resourceType: 'student',
            resourceId: id,
            subjectStudentId: id,
            riskTier: 2,
            reasonText: reason,
            changes: {
              userId: { old: null, new: userId },
              admissionNumber: { old: null, new: admissionNumber },
              admissionDate: { old: null, new: admissionDate },
              status: { old: null, new: 'ADMITTED' },
            },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id } } };
      },
    );
  }

  /** One record. Not held ⇒ 403; missing OR out of scope ⇒ the same 404. No audit on read. */
  static async getById(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<StudentRecordDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    await AuthorizationEngine.assert(tx, ctx, 'student.profile.read');

    const res = await tx.query<StudentRow>(
      `SELECT ${COLS} FROM app.students WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, studentId],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    // student_id / user_id let a SELF holder prove the record is their own; no campus/department can be supplied.
    await AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
      organization_id: ctx.tenantId,
      student_id: row.id,
      user_id: row.user_id,
    });
    return toDto(row);
  }
}
