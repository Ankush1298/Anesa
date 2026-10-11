import { Type, type Static } from '@sinclair/typebox';

// Self-contained schema primitives (academics does not reach into the organization module).
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/** Business code: 1-20 chars, leading alphanumeric (programs, cohort intake). */
export const CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$';
/** period_type.code is bounded at 30 (doc 02 §4.5). */
export const PERIOD_TYPE_CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$';

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
export const NameSchema = Type.String({ minLength: 1, maxLength: 255 });

export const IdParamSchema = Type.Object({ id: UuidV7Schema }, { additionalProperties: false });
export type IdParam = Static<typeof IdParamSchema>;

export const SuccessResponseSchema = Type.Object(
  { success: Type.Literal(true) },
  { additionalProperties: false },
);

export const CreateResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

// ============================================================================
// Period types (doc 02 §4.5; GET/POST only — no PATCH in doc 11 §5.4)
// ============================================================================

export const CreatePeriodTypeBodySchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 30, pattern: PERIOD_TYPE_CODE_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 50 }),
    labelPlural: Type.String({ minLength: 1, maxLength: 50 }),
  },
  { additionalProperties: false },
);
export type CreatePeriodTypeBody = Static<typeof CreatePeriodTypeBodySchema>;

export const PeriodTypeRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    code: Type.String(),
    label: Type.String(),
    labelPlural: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type PeriodTypeRecordDto = Static<typeof PeriodTypeRecordSchema>;

export const CreatePeriodTypeResponseSchema = CreateResponseSchema;
export const ListPeriodTypesResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(PeriodTypeRecordSchema) },
  { additionalProperties: false },
);

// ============================================================================
// Programs (doc 02 §4.5; GET/POST/PATCH /programs)
// ============================================================================

export const ProgramStatusSchema = Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]);
export type ProgramStatus = Static<typeof ProgramStatusSchema>;

export const CreateProgramBodySchema = Type.Object(
  {
    departmentId: UuidV7Schema,
    periodTypeId: UuidV7Schema,
    name: NameSchema,
    code: Type.String({ minLength: 1, maxLength: 20, pattern: CODE_PATTERN }),
    degreeLevel: Type.String({ minLength: 1, maxLength: 30 }),
    durationPeriods: Type.Integer({ minimum: 1, maximum: 100 }),
    periodsPerYear: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    defaultRegulation: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  },
  { additionalProperties: false },
);
export type CreateProgramBody = Static<typeof CreateProgramBodySchema>;

export const UpdateProgramBodySchema = Type.Object(
  {
    name: Type.Optional(NameSchema),
    degreeLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    durationPeriods: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    periodsPerYear: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    defaultRegulation: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    status: Type.Optional(ProgramStatusSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateProgramBody = Static<typeof UpdateProgramBodySchema>;

export const ProgramRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    departmentId: UuidV7Schema,
    periodTypeId: UuidV7Schema,
    name: Type.String(),
    code: Type.String(),
    degreeLevel: Type.String(),
    durationPeriods: Type.Integer(),
    periodsPerYear: Type.Union([Type.Integer(), Type.Null()]),
    defaultRegulation: Type.Union([Type.String(), Type.Null()]),
    status: ProgramStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type ProgramRecordDto = Static<typeof ProgramRecordSchema>;

export const ListProgramsQuerySchema = Type.Object(
  { departmentId: Type.Optional(UuidV7Schema), status: Type.Optional(ProgramStatusSchema) },
  { additionalProperties: false },
);
export type ListProgramsQuery = Static<typeof ListProgramsQuerySchema>;

export const CreateProgramResponseSchema = CreateResponseSchema;
export const ListProgramsResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(ProgramRecordSchema) },
  { additionalProperties: false },
);
export const UpdateProgramResponseSchema = SuccessResponseSchema;

// ============================================================================
// Cohorts (doc 02 §4.5; GET/POST/PATCH /cohorts)
// ============================================================================

export const CohortStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('GRADUATED'),
  Type.Literal('CLOSED'),
]);
export type CohortStatus = Static<typeof CohortStatusSchema>;

const YEAR = Type.Integer({ minimum: 1900, maximum: 2200 });

export const CreateCohortBodySchema = Type.Object(
  {
    programId: UuidV7Schema,
    admissionYear: YEAR,
    intakeCode: Type.Optional(Type.String({ minLength: 1, maxLength: 10, pattern: CODE_PATTERN })),
    name: NameSchema,
    regulation: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    expectedGraduationYear: Type.Optional(YEAR),
  },
  { additionalProperties: false },
);
export type CreateCohortBody = Static<typeof CreateCohortBodySchema>;

export const UpdateCohortBodySchema = Type.Object(
  {
    name: Type.Optional(NameSchema),
    regulation: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    expectedGraduationYear: Type.Optional(YEAR),
    status: Type.Optional(CohortStatusSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateCohortBody = Static<typeof UpdateCohortBodySchema>;

export const CohortRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    programId: UuidV7Schema,
    admissionYear: Type.Integer(),
    intakeCode: Type.String(),
    name: Type.String(),
    regulation: Type.Union([Type.String(), Type.Null()]),
    expectedGraduationYear: Type.Union([Type.Integer(), Type.Null()]),
    status: CohortStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type CohortRecordDto = Static<typeof CohortRecordSchema>;

export const ListCohortsQuerySchema = Type.Object(
  { programId: Type.Optional(UuidV7Schema), status: Type.Optional(CohortStatusSchema) },
  { additionalProperties: false },
);
export type ListCohortsQuery = Static<typeof ListCohortsQuerySchema>;

export const CreateCohortResponseSchema = CreateResponseSchema;
export const ListCohortsResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(CohortRecordSchema) },
  { additionalProperties: false },
);
export const UpdateCohortResponseSchema = SuccessResponseSchema;
