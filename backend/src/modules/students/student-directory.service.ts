import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { invalid } from '../people/validation.js';
import { ADMISSION_NUMBER_PATTERN, type StudentDirectoryEntry } from './student.schemas.js';

export const DIRECTORY_SEARCH_PERMISSION = 'student.directory.search';
const ADMISSION_NUMBER_RE = new RegExp(ADMISSION_NUMBER_PATTERN);

interface Row {
  id: string;
  admission_number: string;
  display_name: string;
  status: StudentDirectoryEntry['status'];
  has_active_enrolment: boolean;
}

/**
 * Staff lookup of ONE student by exact admission number (docs/architecture/v3/21-students.md §0b). Read only: no audit
 * event, no row lock, nothing cached (the global `Cache-Control: no-store` applies).
 *
 * SCOPE CONTRACT (approved decision, a deliberate exception to doc 06 §3):
 *  - "unplaced" means the student has NO enrolment with status ACTIVE in `app.student_programs`. A student who never
 *    enrolled and a student whose enrolments are all closed (COMPLETED / TRANSFERRED_OUT / DISCONTINUED) are the same:
 *    both are findable by every holder of `student.directory.search`, whatever their campus/department scope, and the
 *    answer does not distinguish them (so no enrolment history is revealed).
 *  - a PLACED student (an ACTIVE enrolment exists) is findable only when that enrolment's frozen campus or department
 *    lies inside one of the caller's GRANTED scopes (ORGANIZATION = everything). Otherwise the answer is the same 404 as
 *    for an unknown admission number: whether a hidden student exists is never revealed.
 *  - `hasActiveEnrolment` is computed by the database in the same statement: EXISTS an ACTIVE enrolment of the student, in
 *    any campus/department. It can be `true` only for a student the caller may see, and it carries no placement detail.
 * Finding a student confers nothing else: opening an enrolment still requires `student.program.assign` on the TARGET
 * program's own campus/department (StudentProgramService.open).
 *
 * The scope filter and the lookup are ONE statement in the caller's `withTenant` transaction (RLS applies on top). The
 * scope comes from the caller's effective grants read from the database, never from the request.
 */
export class StudentDirectoryService {
  static async findByAdmissionNumber(
    tx: TenantTx,
    ctx: TrustedContext,
    admissionNumber: unknown,
  ): Promise<StudentDirectoryEntry> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    // Staff only, before any query: row security hides enrolments from non-staff, which would read as "unplaced".
    AuthorizationEngine.assertStaffActor(ctx);
    if (typeof admissionNumber !== 'string' || !ADMISSION_NUMBER_RE.test(admissionNumber)) {
      throw invalid('admissionNumber must be 1 to 50 letters, digits, "-" or "_".');
    }

    // Held at all (403). The effective grants then bound only the PLACED students.
    await AuthorizationEngine.assert(tx, ctx, DIRECTORY_SEARCH_PERMISSION);
    const grants = (
      await AuthorizationEngine.loadGrants(tx, ctx, DIRECTORY_SEARCH_PERMISSION)
    ).filter((g) => g.scope_mode === 'GRANTED');
    const orgWide = grants.some((g) => g.scope_type === 'ORGANIZATION');
    const campusIds = grants
      .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id)
      .map((g) => g.scope_id);
    const departmentIds = grants
      .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id)
      .map((g) => g.scope_id);

    const res = await tx.query<Row>(
      `SELECT s.id, s.admission_number, u.display_name, s.status,
              EXISTS (SELECT 1 FROM app.student_programs sp
                       WHERE sp.organization_id = s.organization_id AND sp.student_id = s.id
                         AND sp.status = 'ACTIVE') AS has_active_enrolment
         FROM app.students s
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE s.organization_id = $1 AND s.admission_number = $2
          AND (
            NOT EXISTS (SELECT 1 FROM app.student_programs sp
                         WHERE sp.organization_id = s.organization_id AND sp.student_id = s.id
                           AND sp.status = 'ACTIVE')
            OR $3::boolean
            OR EXISTS (SELECT 1 FROM app.student_programs sp
                        WHERE sp.organization_id = s.organization_id AND sp.student_id = s.id
                          AND sp.status = 'ACTIVE'
                          AND (sp.campus_id = ANY($4::uuid[]) OR sp.department_id = ANY($5::uuid[])))
          )
        LIMIT 1`,
      [ctx.tenantId, admissionNumber, orgWide, campusIds, departmentIds],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    return {
      id: row.id,
      admissionNumber: row.admission_number,
      displayName: row.display_name,
      status: row.status,
      hasActiveEnrolment: row.has_active_enrolment,
    };
  }
}
