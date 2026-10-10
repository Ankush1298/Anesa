import { Type, type Static } from '@sinclair/typebox';
import { SETTING_KEY_MAX_LENGTH, SETTING_KEY_PATTERN } from '../../shared/settings/index.js';

/**
 * UUIDv7 pattern strictly adhering to RFC 9562 (version 7, variant 10).
 * Reused from backend/src/shared/ids/uuidv7.ts.
 */
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * Campus and department business code pattern: 1-20 characters, starting with alphanumeric,
 * followed by alphanumeric, hyphens, or underscores.
 */
export const CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$';

// ============================================================================
// Primitives & Shared Field Schemas
// ============================================================================

export const UuidV7Schema = Type.String({
  pattern: UUID_V7_PATTERN,
  description: 'RFC 9562 UUIDv7 identifier',
});

export const CodeSchema = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: CODE_PATTERN,
  description: 'Unique business key (1-20 alphanumeric characters, hyphens, or underscores)',
});

export const NameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  description: 'Display name (1-255 characters)',
});

export const TimezoneSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Canonical IANA timezone identifier (e.g. Asia/Kolkata, UTC)',
});

export const AddressSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: 'Structured address object (up to 4096 bytes)',
});

export const CampusStatusSchema = Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')], {
  description: 'Campus lifecycle status',
});

export const DepartmentStatusSchema = Type.Union(
  [Type.Literal('ACTIVE'), Type.Literal('INACTIVE')],
  {
    description: 'Department lifecycle status',
  },
);

export const DepartmentKindSchema = Type.Union(
  [Type.Literal('ACADEMIC'), Type.Literal('ADMINISTRATIVE'), Type.Literal('SERVICE')],
  {
    description: 'Department classification',
  },
);

// ============================================================================
// Shared Parameter & Generic Response Schemas
// ============================================================================

export const IdParamSchema = Type.Object(
  {
    id: UuidV7Schema,
  },
  { additionalProperties: false },
);
export type IdParam = Static<typeof IdParamSchema>;

export const SuccessResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type SuccessResponse = Static<typeof SuccessResponseSchema>;

export const IdResponseDataSchema = Type.Object(
  {
    id: UuidV7Schema,
  },
  { additionalProperties: false },
);

export const CreateResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: IdResponseDataSchema,
  },
  { additionalProperties: false },
);
export type CreateResponse = Static<typeof CreateResponseSchema>;

export const ErrorDetailSchema = Type.Object(
  {
    field: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
        details: Type.Optional(Type.Array(ErrorDetailSchema)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

// ============================================================================
// Campus Schemas
// ============================================================================

export const CreateCampusBodySchema = Type.Object(
  {
    name: NameSchema,
    code: CodeSchema,
    timezone: TimezoneSchema,
    address: Type.Optional(AddressSchema),
  },
  { additionalProperties: false },
);
export type CreateCampusBody = Static<typeof CreateCampusBodySchema>;

export const CreateCampusResponseSchema = CreateResponseSchema;
export type CreateCampusResponse = Static<typeof CreateCampusResponseSchema>;

export const CampusParamsSchema = IdParamSchema;
export type CampusParams = Static<typeof CampusParamsSchema>;

export const UpdateCampusBodySchema = Type.Object(
  {
    name: Type.Optional(NameSchema),
    address: Type.Optional(AddressSchema),
    status: Type.Optional(CampusStatusSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateCampusBody = Static<typeof UpdateCampusBodySchema>;

export const CampusRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    name: NameSchema,
    code: CodeSchema,
    timezone: TimezoneSchema,
    address: AddressSchema,
    status: CampusStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type CampusRecordDto = Static<typeof CampusRecordSchema>;

export const GetCampusResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: CampusRecordSchema,
  },
  { additionalProperties: false },
);
export type GetCampusResponse = Static<typeof GetCampusResponseSchema>;

export const ListCampusesQuerySchema = Type.Object(
  {
    status: Type.Optional(CampusStatusSchema),
  },
  { additionalProperties: false },
);
export type ListCampusesQuery = Static<typeof ListCampusesQuerySchema>;

export const ListCampusesResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(CampusRecordSchema),
  },
  { additionalProperties: false },
);
export type ListCampusesResponse = Static<typeof ListCampusesResponseSchema>;

export const UpdateCampusResponseSchema = SuccessResponseSchema;
export type UpdateCampusResponse = Static<typeof UpdateCampusResponseSchema>;

// ============================================================================
// Department Schemas
// ============================================================================

export const CreateDepartmentBodySchema = Type.Object(
  {
    campusId: UuidV7Schema,
    name: NameSchema,
    code: CodeSchema,
    kind: Type.Optional(DepartmentKindSchema),
    parentDepartmentId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type CreateDepartmentBody = Static<typeof CreateDepartmentBodySchema>;

export const CreateDepartmentResponseSchema = CreateResponseSchema;
export type CreateDepartmentResponse = Static<typeof CreateDepartmentResponseSchema>;

export const DepartmentParamsSchema = IdParamSchema;
export type DepartmentParams = Static<typeof DepartmentParamsSchema>;

export const UpdateDepartmentBodySchema = Type.Object(
  {
    name: Type.Optional(NameSchema),
    status: Type.Optional(DepartmentStatusSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateDepartmentBody = Static<typeof UpdateDepartmentBodySchema>;

export const DepartmentRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    campusId: UuidV7Schema,
    parentDepartmentId: Type.Union([UuidV7Schema, Type.Null()]),
    name: NameSchema,
    code: CodeSchema,
    kind: DepartmentKindSchema,
    status: DepartmentStatusSchema,
    deletedAt: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type DepartmentRecordDto = Static<typeof DepartmentRecordSchema>;

export const GetDepartmentResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: DepartmentRecordSchema,
  },
  { additionalProperties: false },
);
export type GetDepartmentResponse = Static<typeof GetDepartmentResponseSchema>;

export const ListDepartmentsQuerySchema = Type.Object(
  {
    campusId: Type.Optional(UuidV7Schema),
    kind: Type.Optional(DepartmentKindSchema),
    status: Type.Optional(DepartmentStatusSchema),
  },
  { additionalProperties: false },
);
export type ListDepartmentsQuery = Static<typeof ListDepartmentsQuerySchema>;

export const ListDepartmentsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(DepartmentRecordSchema),
  },
  { additionalProperties: false },
);
export type ListDepartmentsResponse = Static<typeof ListDepartmentsResponseSchema>;

export const UpdateDepartmentResponseSchema = SuccessResponseSchema;
export type UpdateDepartmentResponse = Static<typeof UpdateDepartmentResponseSchema>;

export const DeleteDepartmentResponseSchema = SuccessResponseSchema;
export type DeleteDepartmentResponse = Static<typeof DeleteDepartmentResponseSchema>;

// ============================================================================
// Designation Schemas
// ============================================================================

export const DesignationCategorySchema = Type.Union(
  [Type.Literal('TEACHING'), Type.Literal('NON_TEACHING'), Type.Literal('ADMIN')],
  { description: 'Designation category' },
);
export type DesignationCategory = Static<typeof DesignationCategorySchema>;

export const DesignationStatusSchema = Type.Union(
  [Type.Literal('ACTIVE'), Type.Literal('INACTIVE')],
  { description: 'Designation status' },
);
export type DesignationStatus = Static<typeof DesignationStatusSchema>;

export const CreateDesignationBodySchema = Type.Object(
  {
    code: CodeSchema,
    name: NameSchema,
    category: DesignationCategorySchema,
  },
  { additionalProperties: false },
);
export type CreateDesignationBody = Static<typeof CreateDesignationBodySchema>;

export const DesignationRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    code: CodeSchema,
    name: NameSchema,
    category: DesignationCategorySchema,
    status: DesignationStatusSchema,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type DesignationRecordDto = Static<typeof DesignationRecordSchema>;

export const CreateDesignationResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        id: UuidV7Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type CreateDesignationResponse = Static<typeof CreateDesignationResponseSchema>;

export const ListDesignationsQuerySchema = Type.Object(
  {
    status: Type.Optional(DesignationStatusSchema),
    category: Type.Optional(DesignationCategorySchema),
  },
  { additionalProperties: false },
);
export type ListDesignationsQuery = Static<typeof ListDesignationsQuerySchema>;

export const ListDesignationsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(DesignationRecordSchema),
  },
  { additionalProperties: false },
);
export type ListDesignationsResponse = Static<typeof ListDesignationsResponseSchema>;

// ============================================================================
// Organization settings (docs/architecture/v3/02 §4.2, 10 rows 18-19, 11 §5.4)
// ============================================================================

export const SettingKeySchema = Type.String({
  minLength: 1,
  maxLength: SETTING_KEY_MAX_LENGTH,
  pattern: SETTING_KEY_PATTERN,
  description: 'Registered setting key, e.g. identity.age_of_majority',
});

export const SettingParamsSchema = Type.Object(
  { key: SettingKeySchema },
  { additionalProperties: false },
);
export type SettingParams = Static<typeof SettingParamsSchema>;

/**
 * `value` is validated per key against the code registry (shared/settings), not here. `reason` is mandatory because
 * org.settings.manage is a CRITICAL permission (doc 10 row 19). No tenant, user or version field is accepted.
 */
export const SetSettingBodySchema = Type.Object(
  {
    value: Type.Any(),
    reason: Type.String({ minLength: 5, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type SetSettingBody = Static<typeof SetSettingBodySchema>;

export const SettingRecordSchema = Type.Object(
  {
    key: SettingKeySchema,
    value: Type.Any(),
    /** True while no value is stored and the registry default applies. */
    isDefault: Type.Boolean(),
    /** null while the default applies. */
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    updatedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SettingRecordDto = Static<typeof SettingRecordSchema>;

export const ListSettingsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(SettingRecordSchema),
  },
  { additionalProperties: false },
);
export type ListSettingsResponse = Static<typeof ListSettingsResponseSchema>;

export const SetSettingResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: SettingRecordSchema,
  },
  { additionalProperties: false },
);
export type SetSettingResponse = Static<typeof SetSettingResponseSchema>;
