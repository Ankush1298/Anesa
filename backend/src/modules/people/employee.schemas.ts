import { Type, type Static } from '@sinclair/typebox';

// Self-contained primitives (the people module does not reach into other modules' schemas).
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/** employee_code is varchar(50) in doc 02 §4.4. Conservative charset: loosening later is safe, tightening is not. */
export const EMPLOYEE_CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$';
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** security_artitecture.md "Size/complexity limits": max page size (e.g. 100). Applies to schema AND service. */
export const MAX_PAGE_SIZE = 100;

export const EMPLOYEE_TYPES = ['FACULTY', 'STAFF', 'ADMIN', 'VISITING'] as const;
export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SEPARATED'] as const;

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
export const EmployeeTypeSchema = Type.Union(EMPLOYEE_TYPES.map((t) => Type.Literal(t)));
export type EmployeeType = Static<typeof EmployeeTypeSchema>;
export const EmployeeStatusSchema = Type.Union(EMPLOYEE_STATUSES.map((s) => Type.Literal(s)));
export type EmployeeStatus = Static<typeof EmployeeStatusSchema>;

const DateSchema = Type.String({ pattern: DATE_PATTERN, description: 'Calendar date, YYYY-MM-DD' });
/** A2 (doc 02 §4.1): every mutation carries a mandatory reason, stored on the audit event. */
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const EmployeeIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type EmployeeIdParam = Static<typeof EmployeeIdParamSchema>;

/**
 * Status is server-managed on create (always ACTIVE) and a leaving date is meaningless for a new hire, so neither
 * is accepted. No organization / tenant field is accepted either (additionalProperties: false).
 */
export const CreateEmployeeBodySchema = Type.Object(
  {
    userId: UuidV7Schema,
    employeeCode: Type.String({ minLength: 1, maxLength: 50, pattern: EMPLOYEE_CODE_PATTERN }),
    employeeType: EmployeeTypeSchema,
    joiningDate: DateSchema,
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type CreateEmployeeBody = Static<typeof CreateEmployeeBodySchema>;

/** user_id and employee_code are fixed at creation. */
export const UpdateEmployeeBodySchema = Type.Object(
  {
    employeeType: Type.Optional(EmployeeTypeSchema),
    joiningDate: Type.Optional(DateSchema),
    // Independent of status (01 §3.4: optional; no coupling is specified). JSON null clears it. The null branch is
    // `const: null`, NOT `type: 'null'`: Fastify's AJV coerces types, and `type: 'null'` would turn "" (a blank form
    // field) into null and silently clear the date. `const` has no type to coerce, so "" is a 400. null goes first so
    // a null is never offered to the string branch (which would coerce it to "").
    leavingDate: Type.Optional(Type.Union([Type.Unsafe<null>({ const: null }), DateSchema])),
    status: Type.Optional(EmployeeStatusSchema),
    reason: ReasonSchema,
  },
  { additionalProperties: false, minProperties: 2 },
);
export type UpdateEmployeeBody = Static<typeof UpdateEmployeeBodySchema>;

export const EmployeeRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    userId: UuidV7Schema,
    employeeCode: Type.String(),
    employeeType: EmployeeTypeSchema,
    joiningDate: Type.String(),
    leavingDate: Type.Union([Type.String(), Type.Null()]),
    status: EmployeeStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type EmployeeRecordDto = Static<typeof EmployeeRecordSchema>;

export const ListEmployeesQuerySchema = Type.Object(
  {
    status: Type.Optional(EmployeeStatusSchema),
    employeeType: Type.Optional(EmployeeTypeSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);
export type ListEmployeesQuery = Static<typeof ListEmployeesQuerySchema>;

export const CreateEmployeeResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const GetEmployeeResponseSchema = Type.Object(
  { success: Type.Literal(true), data: EmployeeRecordSchema },
  { additionalProperties: false },
);
export const ListEmployeesResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(EmployeeRecordSchema) },
  { additionalProperties: false },
);
export const UpdateEmployeeResponseSchema = GetEmployeeResponseSchema;
