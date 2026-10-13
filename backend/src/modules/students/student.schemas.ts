import { Type, type Static } from '@sinclair/typebox';

// Self-contained primitives (the module does not reach into other modules' schemas).
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * admission_number is varchar(50)-bounded in the table. Administrator-supplied in Phase 2; same conservative charset as
 * EMPLOYEE_CODE_PATTERN (loosening later is safe, tightening is not). No trimming: whitespace is rejected.
 * Uniqueness stays case-sensitive (UNIQUE (organization_id, admission_number)).
 */
export const ADMISSION_NUMBER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$';
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const STUDENT_STATUSES = [
  'ADMITTED',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'DISCONTINUED',
  'GRADUATED',
  'TRANSFERRED_OUT',
] as const;

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
export const StudentStatusSchema = Type.Union(STUDENT_STATUSES.map((s) => Type.Literal(s)));
export type StudentStatus = Static<typeof StudentStatusSchema>;

const DateSchema = Type.String({ pattern: DATE_PATTERN, description: 'Calendar date, YYYY-MM-DD' });
/** A2 (doc 02 §4.1): every mutation carries a mandatory reason, stored on the audit event. */
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const StudentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentIdParam = Static<typeof StudentIdParamSchema>;

/**
 * Status is server-managed on create (always ADMITTED). No organization / tenant field is accepted
 * (additionalProperties: false); the tenant comes only from the session.
 */
export const CreateStudentBodySchema = Type.Object(
  {
    userId: UuidV7Schema,
    admissionNumber: Type.String({
      minLength: 1,
      maxLength: 50,
      pattern: ADMISSION_NUMBER_PATTERN,
    }),
    admissionDate: DateSchema,
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type CreateStudentBody = Static<typeof CreateStudentBodySchema>;

/**
 * admissionDate and statusChangedAt are nullable ONLY because rows written before migration 0017 may still carry NULL
 * until the 0019 contract migration runs; every row created through this API has both.
 */
export const StudentRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    userId: UuidV7Schema,
    admissionNumber: Type.String(),
    admissionDate: Type.Union([Type.String(), Type.Null()]),
    status: StudentStatusSchema,
    statusChangedAt: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type StudentRecordDto = Static<typeof StudentRecordSchema>;

export const CreateStudentResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const GetStudentResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentRecordSchema },
  { additionalProperties: false },
);
