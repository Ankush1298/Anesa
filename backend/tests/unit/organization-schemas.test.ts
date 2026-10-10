import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import Fastify from 'fastify';
import {
  UuidV7Schema,
  CodeSchema,
  NameSchema,
  TimezoneSchema,
  AddressSchema,
  CampusStatusSchema,
  DepartmentStatusSchema,
  DepartmentKindSchema,
  CampusParamsSchema,
  DepartmentParamsSchema,
  CreateCampusBodySchema,
  CreateCampusResponseSchema,
  UpdateCampusBodySchema,
  CampusRecordSchema,
  GetCampusResponseSchema,
  UpdateCampusResponseSchema,
  CreateDepartmentBodySchema,
  CreateDepartmentResponseSchema,
  UpdateDepartmentBodySchema,
  DepartmentRecordSchema,
  GetDepartmentResponseSchema,
  UpdateDepartmentResponseSchema,
  DeleteDepartmentResponseSchema,
  SuccessResponseSchema,
  ErrorEnvelopeSchema,
} from '../../src/modules/organization/organization.schemas.js';

// Deterministic fixtures
const VALID_V7 = '01939a00-0000-7000-8000-000000000a01';
const VALID_V7_2 = '01939a00-0000-7000-8000-000000000a02';
const VALID_V7_3 = '01939a00-0000-7000-8000-000000000a03';
const INVALID_V4 = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOT_UUID = 'not-a-valid-uuid';

describe('Organization API Schemas: Primitives & Field Validation', () => {
  describe('UuidV7Schema', () => {
    it('accepts RFC 9562 UUIDv7 identifiers', () => {
      expect(Value.Check(UuidV7Schema, VALID_V7)).toBe(true);
      expect(Value.Check(UuidV7Schema, '018f3a21-9876-7def-8123-456789abcdef')).toBe(true);
    });

    it('rejects UUIDv4 and non-UUID values', () => {
      expect(Value.Check(UuidV7Schema, INVALID_V4)).toBe(false);
      expect(Value.Check(UuidV7Schema, NOT_UUID)).toBe(false);
      expect(Value.Check(UuidV7Schema, '')).toBe(false);
      expect(Value.Check(UuidV7Schema, 12345)).toBe(false);
      expect(Value.Check(UuidV7Schema, null)).toBe(false);
      expect(Value.Check(UuidV7Schema, undefined)).toBe(false);
    });
  });

  describe('CodeSchema', () => {
    it('accepts valid 1-20 character business codes', () => {
      expect(Value.Check(CodeSchema, 'NORTH')).toBe(true);
      expect(Value.Check(CodeSchema, 'CAMPUS_1')).toBe(true);
      expect(Value.Check(CodeSchema, 'dept-cs')).toBe(true);
      expect(Value.Check(CodeSchema, 'A')).toBe(true);
      expect(Value.Check(CodeSchema, 'A1234567890123456789')).toBe(true); // 20 chars
    });

    it('rejects invalid business codes', () => {
      expect(Value.Check(CodeSchema, '')).toBe(false);
      expect(Value.Check(CodeSchema, 'A'.repeat(21))).toBe(false);
      expect(Value.Check(CodeSchema, '-START_DASH')).toBe(false);
      expect(Value.Check(CodeSchema, '_START_UNDERSCORE')).toBe(false);
      expect(Value.Check(CodeSchema, 'HAS SPACE')).toBe(false);
      expect(Value.Check(CodeSchema, 'SPECIAL@CHAR')).toBe(false);
    });
  });

  describe('NameSchema', () => {
    it('accepts 1-255 character names', () => {
      expect(Value.Check(NameSchema, 'North Campus')).toBe(true);
      expect(Value.Check(NameSchema, 'A')).toBe(true);
      expect(Value.Check(NameSchema, 'A'.repeat(255))).toBe(true);
    });

    it('rejects empty and overly long names', () => {
      expect(Value.Check(NameSchema, '')).toBe(false);
      expect(Value.Check(NameSchema, 'A'.repeat(256))).toBe(false);
      expect(Value.Check(NameSchema, 123)).toBe(false);
    });
  });

  describe('TimezoneSchema', () => {
    it('accepts 1-64 character timezone strings', () => {
      expect(Value.Check(TimezoneSchema, 'Asia/Kolkata')).toBe(true);
      expect(Value.Check(TimezoneSchema, 'UTC')).toBe(true);
      expect(Value.Check(TimezoneSchema, 'America/Argentina/Buenos_Aires')).toBe(true);
    });

    it('rejects empty or overly long timezone strings', () => {
      expect(Value.Check(TimezoneSchema, '')).toBe(false);
      expect(Value.Check(TimezoneSchema, 'A'.repeat(65))).toBe(false);
    });
  });

  describe('AddressSchema', () => {
    it('accepts JSON objects', () => {
      expect(Value.Check(AddressSchema, {})).toBe(true);
      expect(Value.Check(AddressSchema, { street: '123 Main', city: 'Bengaluru' })).toBe(true);
      expect(Value.Check(AddressSchema, { postalCode: 560001, active: true })).toBe(true);
    });

    it('rejects arrays, null, and primitive values', () => {
      expect(Value.Check(AddressSchema, [])).toBe(false);
      expect(Value.Check(AddressSchema, null)).toBe(false);
      expect(Value.Check(AddressSchema, '123 Main St')).toBe(false);
      expect(Value.Check(AddressSchema, 42)).toBe(false);
    });
  });

  describe('Status and Kind Enums', () => {
    it('CampusStatusSchema accepts only ACTIVE and INACTIVE', () => {
      expect(Value.Check(CampusStatusSchema, 'ACTIVE')).toBe(true);
      expect(Value.Check(CampusStatusSchema, 'INACTIVE')).toBe(true);
      expect(Value.Check(CampusStatusSchema, 'DELETED')).toBe(false);
      expect(Value.Check(CampusStatusSchema, 'active')).toBe(false);
    });

    it('DepartmentStatusSchema accepts only ACTIVE and INACTIVE', () => {
      expect(Value.Check(DepartmentStatusSchema, 'ACTIVE')).toBe(true);
      expect(Value.Check(DepartmentStatusSchema, 'INACTIVE')).toBe(true);
      expect(Value.Check(DepartmentStatusSchema, 'ARCHIVED')).toBe(false);
    });

    it('DepartmentKindSchema accepts ACADEMIC, ADMINISTRATIVE, and SERVICE', () => {
      expect(Value.Check(DepartmentKindSchema, 'ACADEMIC')).toBe(true);
      expect(Value.Check(DepartmentKindSchema, 'ADMINISTRATIVE')).toBe(true);
      expect(Value.Check(DepartmentKindSchema, 'SERVICE')).toBe(true);
      expect(Value.Check(DepartmentKindSchema, 'OTHER')).toBe(false);
      expect(Value.Check(DepartmentKindSchema, 'academic')).toBe(false);
    });
  });
});

describe('Organization API Schemas: Campus Request & Response Contracts', () => {
  describe('CreateCampusBodySchema', () => {
    it('accepts a valid campus creation payload', () => {
      const valid = {
        name: 'Main Campus',
        code: 'MAIN',
        timezone: 'Asia/Kolkata',
        address: { city: 'Bengaluru', pincode: '560001' },
      };
      expect(Value.Check(CreateCampusBodySchema, valid)).toBe(true);
    });

    it('accepts valid payload when address is omitted', () => {
      const valid = {
        name: 'Main Campus',
        code: 'MAIN',
        timezone: 'UTC',
      };
      expect(Value.Check(CreateCampusBodySchema, valid)).toBe(true);
    });

    it('rejects missing required fields', () => {
      expect(Value.Check(CreateCampusBodySchema, { code: 'MAIN', timezone: 'UTC' })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { name: 'Main', timezone: 'UTC' })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { name: 'Main', code: 'MAIN' })).toBe(false);
    });

    it('rejects client-supplied identity or immutable fields (additionalProperties: false)', () => {
      const base = { name: 'Main Campus', code: 'MAIN', timezone: 'UTC' };

      expect(Value.Check(CreateCampusBodySchema, { ...base, id: VALID_V7 })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { ...base, organization_id: VALID_V7 })).toBe(
        false,
      );
      expect(Value.Check(CreateCampusBodySchema, { ...base, organizationId: VALID_V7 })).toBe(
        false,
      );
      expect(Value.Check(CreateCampusBodySchema, { ...base, tenant_id: VALID_V7 })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { ...base, tenantId: VALID_V7 })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { ...base, status: 'ACTIVE' })).toBe(false);
      expect(Value.Check(CreateCampusBodySchema, { ...base, unknownField: true })).toBe(false);
    });
  });

  describe('CampusParamsSchema', () => {
    it('accepts valid UUIDv7 path parameter', () => {
      expect(Value.Check(CampusParamsSchema, { id: VALID_V7 })).toBe(true);
    });

    it('rejects invalid or extra path parameters', () => {
      expect(Value.Check(CampusParamsSchema, { id: INVALID_V4 })).toBe(false);
      expect(Value.Check(CampusParamsSchema, { id: NOT_UUID })).toBe(false);
      expect(Value.Check(CampusParamsSchema, { id: VALID_V7, extra: 'forbidden' })).toBe(false);
    });
  });

  describe('UpdateCampusBodySchema', () => {
    it('accepts valid partial updates', () => {
      expect(Value.Check(UpdateCampusBodySchema, { name: 'New Name' })).toBe(true);
      expect(Value.Check(UpdateCampusBodySchema, { address: { street: 'New St' } })).toBe(true);
      expect(Value.Check(UpdateCampusBodySchema, { status: 'INACTIVE' })).toBe(true);
      expect(
        Value.Check(UpdateCampusBodySchema, {
          name: 'Renamed',
          address: { city: 'Pune' },
          status: 'ACTIVE',
        }),
      ).toBe(true);
    });

    it('rejects empty payload (minProperties: 1)', () => {
      expect(Value.Check(UpdateCampusBodySchema, {})).toBe(false);
    });

    it('rejects attempts to update immutable columns or tenant identity', () => {
      expect(Value.Check(UpdateCampusBodySchema, { id: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { code: 'NEW_CODE' })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { timezone: 'UTC' })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { organization_id: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { organizationId: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { tenant_id: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateCampusBodySchema, { name: 'Valid', code: 'INVALID' })).toBe(false);
    });
  });

  describe('CampusRecordSchema & Responses', () => {
    it('accepts complete campus record shape matching service output', () => {
      const record = {
        id: VALID_V7,
        organizationId: VALID_V7_2,
        name: 'Campus 1',
        code: 'C1',
        timezone: 'Asia/Kolkata',
        address: {},
        status: 'ACTIVE',
        version: 1,
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      };
      expect(Value.Check(CampusRecordSchema, record)).toBe(true);
      expect(Value.Check(GetCampusResponseSchema, { success: true, data: record })).toBe(true);
    });

    it('rejects campus record with missing or extra fields', () => {
      const incomplete = {
        id: VALID_V7,
        name: 'Campus 1',
        code: 'C1',
      };
      expect(Value.Check(CampusRecordSchema, incomplete)).toBe(false);
      expect(Value.Check(GetCampusResponseSchema, { success: true, data: incomplete })).toBe(false);
    });
  });
});

describe('Organization API Schemas: Department Request & Response Contracts', () => {
  describe('CreateDepartmentBodySchema', () => {
    it('accepts a valid department creation payload with minimal fields', () => {
      const valid = {
        campusId: VALID_V7,
        name: 'Computer Science',
        code: 'CS',
      };
      expect(Value.Check(CreateDepartmentBodySchema, valid)).toBe(true);
    });

    it('accepts a valid department creation payload with all optional fields', () => {
      const valid = {
        campusId: VALID_V7,
        name: 'Artificial Intelligence',
        code: 'AI',
        kind: 'ACADEMIC',
        parentDepartmentId: VALID_V7_2,
      };
      expect(Value.Check(CreateDepartmentBodySchema, valid)).toBe(true);
    });

    it('rejects missing required fields', () => {
      expect(Value.Check(CreateDepartmentBodySchema, { name: 'CS', code: 'CS' })).toBe(false);
      expect(Value.Check(CreateDepartmentBodySchema, { campusId: VALID_V7, code: 'CS' })).toBe(
        false,
      );
      expect(Value.Check(CreateDepartmentBodySchema, { campusId: VALID_V7, name: 'CS' })).toBe(
        false,
      );
    });

    it('rejects invalid campusId or parentDepartmentId (UUIDv4 or malformed)', () => {
      const base = { name: 'CS', code: 'CS' };
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, campusId: INVALID_V4 })).toBe(
        false,
      );
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, campusId: NOT_UUID })).toBe(false);
      expect(
        Value.Check(CreateDepartmentBodySchema, {
          ...base,
          campusId: VALID_V7,
          parentDepartmentId: INVALID_V4,
        }),
      ).toBe(false);
    });

    it('rejects client-controlled tenant or immutable fields (additionalProperties: false)', () => {
      const base = { campusId: VALID_V7, name: 'CS', code: 'CS' };

      expect(Value.Check(CreateDepartmentBodySchema, { ...base, id: VALID_V7_3 })).toBe(false);
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, organization_id: VALID_V7 })).toBe(
        false,
      );
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, organizationId: VALID_V7 })).toBe(
        false,
      );
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, tenant_id: VALID_V7 })).toBe(false);
      expect(Value.Check(CreateDepartmentBodySchema, { ...base, status: 'ACTIVE' })).toBe(false);
      expect(
        Value.Check(CreateDepartmentBodySchema, {
          ...base,
          deletedAt: '2026-10-10T00:00:00.000Z',
        }),
      ).toBe(false);
    });
  });

  describe('DepartmentParamsSchema', () => {
    it('accepts valid UUIDv7 department ID', () => {
      expect(Value.Check(DepartmentParamsSchema, { id: VALID_V7 })).toBe(true);
    });

    it('rejects UUIDv4 and non-UUID values', () => {
      expect(Value.Check(DepartmentParamsSchema, { id: INVALID_V4 })).toBe(false);
      expect(Value.Check(DepartmentParamsSchema, { id: NOT_UUID })).toBe(false);
    });
  });

  describe('UpdateDepartmentBodySchema', () => {
    it('accepts valid partial updates', () => {
      expect(Value.Check(UpdateDepartmentBodySchema, { name: 'New Department Name' })).toBe(true);
      expect(Value.Check(UpdateDepartmentBodySchema, { status: 'INACTIVE' })).toBe(true);
      expect(
        Value.Check(UpdateDepartmentBodySchema, { name: 'Renamed Dept', status: 'ACTIVE' }),
      ).toBe(true);
    });

    it('rejects empty payload (minProperties: 1)', () => {
      expect(Value.Check(UpdateDepartmentBodySchema, {})).toBe(false);
    });

    it('rejects immutable fields and hierarchy re-parenting', () => {
      expect(Value.Check(UpdateDepartmentBodySchema, { id: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { campusId: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { campus_id: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { parentDepartmentId: VALID_V7 })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { parent_department_id: VALID_V7 })).toBe(
        false,
      );
      expect(Value.Check(UpdateDepartmentBodySchema, { code: 'NEW_CODE' })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { kind: 'ADMINISTRATIVE' })).toBe(false);
      expect(Value.Check(UpdateDepartmentBodySchema, { organization_id: VALID_V7 })).toBe(false);
    });
  });

  describe('DepartmentRecordSchema & Responses', () => {
    it('accepts complete department record shape matching service output', () => {
      const record = {
        id: VALID_V7,
        organizationId: VALID_V7_2,
        campusId: VALID_V7_3,
        parentDepartmentId: null,
        name: 'Mathematics',
        code: 'MATH',
        kind: 'ACADEMIC',
        status: 'ACTIVE',
        deletedAt: null,
        version: 1,
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      };
      expect(Value.Check(DepartmentRecordSchema, record)).toBe(true);
      expect(Value.Check(GetDepartmentResponseSchema, { success: true, data: record })).toBe(true);
    });

    it('accepts child department with non-null parentDepartmentId', () => {
      const childRecord = {
        id: VALID_V7,
        organizationId: VALID_V7_2,
        campusId: VALID_V7_3,
        parentDepartmentId: VALID_V7_2,
        name: 'Pure Mathematics',
        code: 'PMATH',
        kind: 'ACADEMIC',
        status: 'ACTIVE',
        deletedAt: null,
        version: 1,
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      };
      expect(Value.Check(DepartmentRecordSchema, childRecord)).toBe(true);
    });

    it('accepts soft-deleted department with deletedAt timestamp string', () => {
      const deletedRecord = {
        id: VALID_V7,
        organizationId: VALID_V7_2,
        campusId: VALID_V7_3,
        parentDepartmentId: null,
        name: 'Old Dept',
        code: 'OLD',
        kind: 'SERVICE',
        status: 'INACTIVE',
        deletedAt: '2026-10-10T00:00:00.000Z',
        version: 2,
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      };
      expect(Value.Check(DepartmentRecordSchema, deletedRecord)).toBe(true);
    });
  });
});

describe('Organization API Schemas: Standard Envelopes & Responses', () => {
  it('SuccessResponseSchema requires success: true and rejects false or extra fields', () => {
    expect(Value.Check(SuccessResponseSchema, { success: true })).toBe(true);
    expect(Value.Check(SuccessResponseSchema, { success: false })).toBe(false);
    expect(Value.Check(SuccessResponseSchema, { success: true, extra: 123 })).toBe(false);
    expect(Value.Check(UpdateCampusResponseSchema, { success: true })).toBe(true);
    expect(Value.Check(UpdateDepartmentResponseSchema, { success: true })).toBe(true);
    expect(Value.Check(DeleteDepartmentResponseSchema, { success: true })).toBe(true);
  });

  it('Create responses require { success: true, data: { id: UUIDv7 } }', () => {
    expect(Value.Check(CreateCampusResponseSchema, { success: true, data: { id: VALID_V7 } })).toBe(
      true,
    );
    expect(
      Value.Check(CreateDepartmentResponseSchema, { success: true, data: { id: VALID_V7 } }),
    ).toBe(true);
    expect(
      Value.Check(CreateCampusResponseSchema, { success: true, data: { id: INVALID_V4 } }),
    ).toBe(false);
  });

  it('ErrorEnvelopeSchema matches the repository error envelope', () => {
    const basicError = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        requestId: '01939a00-0000-7000-8000-000000000001',
      },
    };
    expect(Value.Check(ErrorEnvelopeSchema, basicError)).toBe(true);

    const detailedError = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        requestId: '01939a00-0000-7000-8000-000000000001',
        details: [{ field: 'name', message: 'Name must not be empty.' }],
      },
    };
    expect(Value.Check(ErrorEnvelopeSchema, detailedError)).toBe(true);
  });
});

describe('Organization API Schemas: Fastify Schema Compilation & Validation Integration', () => {
  it('compiles and validates all route schemas through Fastify with zero compilation errors', async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });

    // Register test endpoints using the exact schemas
    app.post(
      '/test/campuses',
      {
        schema: {
          body: CreateCampusBodySchema,
          response: { 201: CreateCampusResponseSchema },
        },
      },
      async (_req, reply) => {
        return reply.status(201).send({ success: true, data: { id: VALID_V7 } });
      },
    );

    app.get(
      '/test/campuses/:id',
      {
        schema: {
          params: CampusParamsSchema,
          response: { 200: GetCampusResponseSchema },
        },
      },
      async (_req, reply) => {
        return reply.send({
          success: true,
          data: {
            id: VALID_V7,
            organizationId: VALID_V7_2,
            name: 'Campus 1',
            code: 'C1',
            timezone: 'Asia/Kolkata',
            address: {},
            status: 'ACTIVE',
            version: 1,
            createdAt: '2026-10-10T00:00:00.000Z',
            updatedAt: '2026-10-10T00:00:00.000Z',
          },
        });
      },
    );

    app.patch(
      '/test/campuses/:id',
      {
        schema: {
          params: CampusParamsSchema,
          body: UpdateCampusBodySchema,
          response: { 200: UpdateCampusResponseSchema },
        },
      },
      () => ({ success: true }),
    );

    app.post(
      '/test/departments',
      {
        schema: {
          body: CreateDepartmentBodySchema,
          response: { 201: CreateDepartmentResponseSchema },
        },
      },
      async (_req, reply) => {
        return reply.status(201).send({ success: true, data: { id: VALID_V7 } });
      },
    );

    app.get(
      '/test/departments/:id',
      {
        schema: {
          params: DepartmentParamsSchema,
          response: { 200: GetDepartmentResponseSchema },
        },
      },
      () => ({
        success: true,
        data: {
          id: VALID_V7,
          organizationId: VALID_V7_2,
          campusId: VALID_V7_3,
          parentDepartmentId: null,
          name: 'Mathematics',
          code: 'MATH',
          kind: 'ACADEMIC',
          status: 'ACTIVE',
          deletedAt: null,
          version: 1,
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        },
      }),
    );

    app.patch(
      '/test/departments/:id',
      {
        schema: {
          params: DepartmentParamsSchema,
          body: UpdateDepartmentBodySchema,
          response: { 200: UpdateDepartmentResponseSchema },
        },
      },
      () => ({ success: true }),
    );

    app.delete(
      '/test/departments/:id',
      {
        schema: {
          params: DepartmentParamsSchema,
          response: { 200: DeleteDepartmentResponseSchema },
        },
      },
      () => ({ success: true }),
    );

    await app.ready();

    // 1. Valid campus creation returns 201
    const createRes = await app.inject({
      method: 'POST',
      url: '/test/campuses',
      payload: { name: 'Test Campus', code: 'TEST_C', timezone: 'UTC' },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json()).toEqual({ success: true, data: { id: VALID_V7 } });

    // 2. Campus creation with unknown or forbidden fields returns 400
    const badCreateRes = await app.inject({
      method: 'POST',
      url: '/test/campuses',
      payload: { name: 'Test Campus', code: 'TEST_C', timezone: 'UTC', tenantId: VALID_V7 },
    });
    expect(badCreateRes.statusCode).toBe(400);

    // 3. Valid GET with UUIDv7 returns 200
    const getRes = await app.inject({
      method: 'GET',
      url: `/test/campuses/${VALID_V7}`,
    });
    expect(getRes.statusCode).toBe(200);

    // 4. Invalid GET with UUIDv4 returns 400
    const badGetRes = await app.inject({
      method: 'GET',
      url: `/test/campuses/${INVALID_V4}`,
    });
    expect(badGetRes.statusCode).toBe(400);

    // 5. Empty PATCH body returns 400
    const emptyPatchRes = await app.inject({
      method: 'PATCH',
      url: `/test/campuses/${VALID_V7}`,
      payload: {},
    });
    expect(emptyPatchRes.statusCode).toBe(400);

    // 6. Valid PATCH body returns 200
    const validPatchRes = await app.inject({
      method: 'PATCH',
      url: `/test/campuses/${VALID_V7}`,
      payload: { name: 'Updated Name' },
    });
    expect(validPatchRes.statusCode).toBe(200);

    // 7. Department creation with invalid kind returns 400
    const badDeptRes = await app.inject({
      method: 'POST',
      url: '/test/departments',
      payload: { campusId: VALID_V7, name: 'CS', code: 'CS', kind: 'INVALID_KIND' },
    });
    expect(badDeptRes.statusCode).toBe(400);

    // 8. Department DELETE with valid UUIDv7 returns 200
    const delDeptRes = await app.inject({
      method: 'DELETE',
      url: `/test/departments/${VALID_V7}`,
    });
    expect(delDeptRes.statusCode).toBe(200);

    await app.close();
  });
});
