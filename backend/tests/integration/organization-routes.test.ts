import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import { CAMPUS_1, CAMPUS_2, CAMPUS_B1, DEPT_1, ORG_A, UNKNOWN_V7 } from '../support/fixtures.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';

const LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  campusAdminA: 'campus.admin.a@college-a.test',
  facultyA: 'faculty.a@college-a.test',
  studentA: 'user.a@college-a.test',
  orgAdminB: 'staff.b@college-b.test',
} as const;

type UserKey = keyof typeof LOGINS;

interface SessionInfo {
  cookie: string;
  csrf: string;
}

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

const sessions = {} as Record<UserKey, SessionInfo>;

async function loginUser(email: string): Promise<SessionInfo> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, `login for ${email}`).toBe(200);
  const cookie = r.cookies.find((c) => c.name === 'session_token')?.value;
  expect(cookie).toBeDefined();
  const csrf = r.json<{ csrf_token: string }>().csrf_token;
  expect(csrf).toBeDefined();
  return { cookie: cookie!, csrf };
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const emails = Object.values(LOGINS);
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, emails],
  );

  for (const [key, email] of Object.entries(LOGINS) as [UserKey, string][]) {
    sessions[key] = await loginUser(email);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

// Request helpers
function get(user: UserKey | null, path: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: path,
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers,
  });
}

function post(
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string; origin?: string; headers?: Record<string, string> } = {},
) {
  const cookie = user ? { session_token: sessions[user].cookie } : {};
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  const origin = opts.origin !== undefined ? opts.origin : APP_ORIGIN;
  return app.inject({
    method: 'POST',
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: cookie,
    headers: {
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...opts.headers,
    },
  });
}

function patch(
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string; origin?: string; headers?: Record<string, string> } = {},
) {
  const cookie = user ? { session_token: sessions[user].cookie } : {};
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  const origin = opts.origin !== undefined ? opts.origin : APP_ORIGIN;
  return app.inject({
    method: 'PATCH',
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: cookie,
    headers: {
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...opts.headers,
    },
  });
}

function del(
  user: UserKey | null,
  path: string,
  opts: { csrf?: string; origin?: string; headers?: Record<string, string> } = {},
) {
  const cookie = user ? { session_token: sessions[user].cookie } : {};
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  const origin = opts.origin !== undefined ? opts.origin : APP_ORIGIN;
  return app.inject({
    method: 'DELETE',
    url: path,
    cookies: cookie,
    headers: {
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...opts.headers,
    },
  });
}

describe('Organization HTTP API', () => {
  describe('Campus Lifecycle & Contracts', () => {
    it('creates, reads, and updates a campus with valid payloads and responses', async () => {
      // 1. Create campus
      const code = `CMP_${Date.now().toString().slice(-8)}`;
      const createRes = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'South Campus',
        code,
        timezone: 'Asia/Kolkata',
        address: { city: 'Bengaluru', pincode: '560001' },
      });

      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json<{ success: boolean; data: { id: string } }>();
      expect(createBody.success).toBe(true);
      expect(typeof createBody.data.id).toBe('string');
      const campusId = createBody.data.id;

      // 2. Read campus
      const getRes = await get('orgAdminA', `/api/v1/organization/campuses/${campusId}`);
      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json<{
        success: boolean;
        data: {
          id: string;
          organizationId: string;
          name: string;
          code: string;
          timezone: string;
          address: Record<string, unknown>;
          status: string;
          version: number;
          createdAt: string;
          updatedAt: string;
        };
      }>();
      expect(getBody.success).toBe(true);
      expect(getBody.data.id).toBe(campusId);
      expect(getBody.data.organizationId).toBe(ORG_A);
      expect(getBody.data.name).toBe('South Campus');
      expect(getBody.data.code).toBe(code);
      expect(getBody.data.timezone).toBe('Asia/Kolkata');
      expect(getBody.data.address).toEqual({ city: 'Bengaluru', pincode: '560001' });
      expect(getBody.data.status).toBe('ACTIVE');
      expect(getBody.data.version).toBe(1);
      expect(new Date(getBody.data.createdAt).getTime()).not.toBeNaN();
      expect(new Date(getBody.data.updatedAt).getTime()).not.toBeNaN();

      // 3. Update campus
      const patchRes = await patch('orgAdminA', `/api/v1/organization/campuses/${campusId}`, {
        name: 'South Campus Main Gate',
        address: { city: 'Bengaluru', pincode: '560002' },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toEqual({ success: true });

      // 4. Verify updated state
      const verifyRes = await get('orgAdminA', `/api/v1/organization/campuses/${campusId}`);
      expect(verifyRes.statusCode).toBe(200);
      const verifyBody = verifyRes.json<{
        success: boolean;
        data: { name: string; version: number };
      }>();
      expect(verifyBody.data.name).toBe('South Campus Main Gate');
      expect(verifyBody.data.version).toBe(2);
    });

    it('rejects duplicate campus code within the same organization with 409 CONFLICT', async () => {
      const code = `DUP_${Date.now().toString().slice(-8)}`;
      const first = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Alpha Campus',
        code,
        timezone: 'Asia/Kolkata',
      });
      expect(first.statusCode).toBe(201);

      const second = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Beta Campus',
        code,
        timezone: 'Asia/Kolkata',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    });

    it('rejects campus deactivation when active child departments exist with 409 CONFLICT', async () => {
      // CAMPUS_1 in fixtures has active departments (DEPT_1)
      const res = await patch('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`, {
        status: 'INACTIVE',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string; message: string } }>().error.code).toBe('CONFLICT');
    });
  });

  describe('Department Lifecycle & Contracts', () => {
    it('creates, reads, updates, and deletes a department with valid payloads', async () => {
      // 1. Create department
      const code = `DPT_${Date.now().toString().slice(-8)}`;
      const createRes = await post('orgAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_1,
        name: 'Aerospace Engineering',
        code,
        kind: 'ACADEMIC',
      });

      expect(createRes.statusCode).toBe(201);
      const deptId = createRes.json<{ success: boolean; data: { id: string } }>().data.id;
      expect(typeof deptId).toBe('string');

      // 2. Read department
      const getRes = await get('orgAdminA', `/api/v1/organization/departments/${deptId}`);
      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json<{
        success: boolean;
        data: {
          id: string;
          organizationId: string;
          campusId: string;
          name: string;
          code: string;
          kind: string;
          status: string;
          deletedAt: string | null;
        };
      }>();
      expect(getBody.data.id).toBe(deptId);
      expect(getBody.data.organizationId).toBe(ORG_A);
      expect(getBody.data.campusId).toBe(CAMPUS_1);
      expect(getBody.data.name).toBe('Aerospace Engineering');
      expect(getBody.data.code).toBe(code);
      expect(getBody.data.kind).toBe('ACADEMIC');
      expect(getBody.data.status).toBe('ACTIVE');
      expect(getBody.data.deletedAt).toBeNull();

      // 3. Update department
      const patchRes = await patch('orgAdminA', `/api/v1/organization/departments/${deptId}`, {
        name: 'Aeronautical & Space Engineering',
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toEqual({ success: true });

      // 4. Soft-delete department
      const delRes = await del('orgAdminA', `/api/v1/organization/departments/${deptId}`);
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ success: true });

      // 5. Verify post-deletion state
      const postDelRes = await get('orgAdminA', `/api/v1/organization/departments/${deptId}`);
      expect(postDelRes.statusCode).toBe(200);
      const postDelBody = postDelRes.json<{ data: { status: string; deletedAt: string | null } }>();
      expect(postDelBody.data.status).toBe('INACTIVE');
      expect(postDelBody.data.deletedAt).not.toBeNull();
    });

    it('rejects duplicate department code within the same campus with 409 CONFLICT', async () => {
      const code = `DCD_${Date.now().toString().slice(-8)}`;
      const first = await post('orgAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_1,
        name: 'Robotics Lab 1',
        code,
      });
      expect(first.statusCode).toBe(201);

      const second = await post('orgAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_1,
        name: 'Robotics Lab 2',
        code,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    });

    it('rejects department deletion when child departments exist with 409 CONFLICT', async () => {
      // Create parent department
      const pCode = `PRN_${Date.now().toString().slice(-8)}`;
      const pRes = await post('orgAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_1,
        name: 'School of Computing',
        code: pCode,
      });
      expect(pRes.statusCode).toBe(201);
      const parentId = pRes.json<{ data: { id: string } }>().data.id;

      // Create child department
      const cCode = `CHD_${Date.now().toString().slice(-8)}`;
      const cRes = await post('orgAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_1,
        name: 'Data Science Division',
        code: cCode,
        parentDepartmentId: parentId,
      });
      expect(cRes.statusCode).toBe(201);

      // Attempt deleting parent
      const delRes = await del('orgAdminA', `/api/v1/organization/departments/${parentId}`);
      expect(delRes.statusCode).toBe(409);
      expect(delRes.json<{ error: { code: string; message: string } }>().error.code).toBe(
        'CONFLICT',
      );
    });
  });

  describe('Authentication & Authorization Isolation', () => {
    it('returns 401 UNAUTHORIZED on unauthenticated requests', async () => {
      const campusRes = await get(null, `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(campusRes.statusCode).toBe(401);
      expect(campusRes.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');

      const deptRes = await get(null, `/api/v1/organization/departments/${DEPT_1}`);
      expect(deptRes.statusCode).toBe(401);
      expect(deptRes.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    });

    it('returns 403 FORBIDDEN when user has insufficient permissions (STUDENT / FACULTY)', async () => {
      // STUDENT has no org.campus.manage or org.department.manage
      const r1 = await get('studentA', `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(r1.statusCode).toBe(403);
      expect(r1.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const r2 = await post('studentA', '/api/v1/organization/campuses', {
        name: 'Rogue Campus',
        code: 'ROGUE',
        timezone: 'Asia/Kolkata',
      });
      expect(r2.statusCode).toBe(403);
      expect(r2.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const r3 = await get('facultyA', `/api/v1/organization/departments/${DEPT_1}`);
      expect(r3.statusCode).toBe(403);
      expect(r3.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });

    it('returns 404 RESOURCE_NOT_FOUND when accessing resources across tenants (Tenant Isolation)', async () => {
      // Org Admin A attempts to read Campus belonging to Org B
      const r = await get('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_B1}`);
      expect(r.statusCode).toBe(404);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns 404 RESOURCE_NOT_FOUND when Campus Admin accesses out-of-scope campus or department', async () => {
      // In fixtures, CAMPUS_ADMIN_A has scope for CAMPUS_1 only.
      // Reading CAMPUS_1 succeeds:
      const okRes = await get('campusAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(okRes.statusCode).toBe(200);

      // Reading CAMPUS_2 returns 404:
      const deniedCampus = await get('campusAdminA', `/api/v1/organization/campuses/${CAMPUS_2}`);
      expect(deniedCampus.statusCode).toBe(404);
      expect(deniedCampus.json<{ error: { code: string } }>().error.code).toBe(
        'RESOURCE_NOT_FOUND',
      );

      // Create department in CAMPUS_2 returns 404:
      const deniedDeptCreate = await post('campusAdminA', '/api/v1/organization/departments', {
        campusId: CAMPUS_2,
        name: 'Illegal Dept',
        code: 'ILL_01',
      });
      expect(deniedDeptCreate.statusCode).toBe(404);
      expect(deniedDeptCreate.json<{ error: { code: string } }>().error.code).toBe(
        'RESOURCE_NOT_FOUND',
      );
    });

    it('returns 403 FORBIDDEN when Campus Admin attempts campus creation (requires ORGANIZATION scope)', async () => {
      const res = await post('campusAdminA', '/api/v1/organization/campuses', {
        name: 'Another Campus',
        code: 'NOT_ALLOWED',
        timezone: 'Asia/Kolkata',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });
  });

  describe('CSRF & Origin Protections on Unsafe Methods', () => {
    it('rejects POST/PATCH/DELETE without x-csrf-token header with 403', async () => {
      const pRes = await post(
        'orgAdminA',
        '/api/v1/organization/campuses',
        { name: 'X', code: 'X1', timezone: 'UTC' },
        { csrf: '' },
      );
      expect(pRes.statusCode).toBe(403);

      const patchRes = await patch(
        'orgAdminA',
        `/api/v1/organization/campuses/${CAMPUS_1}`,
        { name: 'X' },
        { csrf: '' },
      );
      expect(patchRes.statusCode).toBe(403);

      const delRes = await del('orgAdminA', `/api/v1/organization/departments/${DEPT_1}`, {
        csrf: '',
      });
      expect(delRes.statusCode).toBe(403);
    });

    it('rejects POST/PATCH/DELETE with mismatched x-csrf-token header with 403', async () => {
      const res = await post(
        'orgAdminA',
        '/api/v1/organization/campuses',
        { name: 'X', code: 'X1', timezone: 'UTC' },
        { csrf: 'completely-invalid-csrf-token' },
      );
      expect(res.statusCode).toBe(403);
    });

    it('rejects mutating request with disallowed Origin header with 403', async () => {
      const res = await post(
        'orgAdminA',
        '/api/v1/organization/campuses',
        { name: 'X', code: 'X1', timezone: 'UTC' },
        { origin: 'https://evil-attacker.test' },
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Schema Validation & Immutability Enforcement', () => {
    it('rejects invalid UUIDv7 path parameter with 400 BAD_REQUEST', async () => {
      const res1 = await get('orgAdminA', '/api/v1/organization/campuses/not-a-uuid');
      expect(res1.statusCode).toBe(400);
      expect(res1.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');

      const res2 = await get(
        'orgAdminA',
        '/api/v1/organization/campuses/00000000-0000-4000-8000-000000000000',
      );
      expect(res2.statusCode).toBe(400);
      expect(res2.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    });

    it('rejects missing required fields with 400 BAD_REQUEST', async () => {
      // Missing code & timezone
      const res = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Incomplete Campus',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    });

    it('rejects empty update body (minProperties: 1) with 400 BAD_REQUEST', async () => {
      const res = await patch('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`, {});
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    });

    it('rejects unknown properties in request bodies (additionalProperties: false) with 400', async () => {
      const res = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Valid Name',
        code: 'VAL_01',
        timezone: 'UTC',
        unrecognizedProperty: 'malicious',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    });

    it('rejects immutable fields in request bodies (id, organization_id, tenantId) with 400', async () => {
      const res1 = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Valid Name',
        code: 'VAL_02',
        timezone: 'UTC',
        organization_id: ORG_A,
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await patch('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`, {
        code: 'NEW_CODE',
      });
      expect(res2.statusCode).toBe(400);

      const res3 = await patch('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`, {
        timezone: 'America/New_York',
      });
      expect(res3.statusCode).toBe(400);
    });

    it('rejects invalid enums with 400 BAD_REQUEST', async () => {
      const res = await patch('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`, {
        status: 'DELETED',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('Resource Not Found & Response Envelopes', () => {
    it('returns 404 RESOURCE_NOT_FOUND for nonexistent UUIDv7 IDs', async () => {
      const res = await get('orgAdminA', `/api/v1/organization/campuses/${UNKNOWN_V7}`);
      expect(res.statusCode).toBe(404);
      const json = res.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(json.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(typeof json.error.requestId).toBe('string');
    });

    it('ensures all error responses adhere to standard error envelope', async () => {
      const res = await get(null, `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(res.statusCode).toBe(401);
      const json = res.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe('UNAUTHORIZED');
      expect(typeof json.error.message).toBe('string');
      expect(typeof json.error.requestId).toBe('string');
    });
  });

  describe('Audit Behavior & Transactional Rollback', () => {
    it('records audit events with request metadata (requestId, ip) on successful mutations', async () => {
      const code = `AUD_${Date.now().toString().slice(-8)}`;
      const createRes = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Audit Campus',
        code,
        timezone: 'Asia/Kolkata',
      });
      expect(createRes.statusCode).toBe(201);
      const campusId = createRes.json<{ data: { id: string } }>().data.id;

      // Verify audit event in app.audit_events
      const auditRows = await adminQuery<{
        action: string;
        resource_type: string;
        resource_id: string;
        request_id: string;
        ip: string;
        changes: Record<string, unknown>;
      }>(
        `SELECT action, resource_type, resource_id, request_id, ip, changes
           FROM app.audit_events
          WHERE organization_id = $1 AND resource_id = $2`,
        [ORG_A, campusId],
      );

      expect(auditRows.length).toBe(1);
      const row = auditRows[0]!;
      expect(row.action).toBe('campus.create');
      expect(row.resource_type).toBe('campus');
      expect(row.resource_id).toBe(campusId);
      expect(row.ip).toBe('127.0.0.1');
      expect(typeof row.request_id).toBe('string');
      expect(row.changes.code).toEqual({ old: null, new: code });
    });

    it('ensures failed operations do not commit rows or create orphaned audit records', async () => {
      const code = `ROL_${Date.now().toString().slice(-8)}`;
      // 1. First create succeeds
      const res1 = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Rollback Campus',
        code,
        timezone: 'Asia/Kolkata',
      });
      expect(res1.statusCode).toBe(201);
      expect(typeof res1.json<{ data: { id: string } }>().data.id).toBe('string');

      const countBefore = (
        await adminQuery<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM app.audit_events WHERE organization_id = $1`,
          [ORG_A],
        )
      )[0]!.c;

      // 2. Duplicate create fails with 409 CONFLICT
      const res2 = await post('orgAdminA', '/api/v1/organization/campuses', {
        name: 'Rollback Campus Duplicate',
        code,
        timezone: 'Asia/Kolkata',
      });
      expect(res2.statusCode).toBe(409);

      // Audit count remains unchanged because transaction rolled back completely
      const countAfter = (
        await adminQuery<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM app.audit_events WHERE organization_id = $1`,
          [ORG_A],
        )
      )[0]!.c;
      expect(countAfter).toBe(countBefore);
    });
  });

  describe('Route Security Registration Invariants', () => {
    it('fails Fastify boot if a route omits catalogued permission metadata', () => {
      const badApp = buildApp({
        config: loadConfig({ DATABASE_URL: url }),
        db,
        logger: false,
      });
      // Register an uncatalogued route without public: true
      expect(() => {
        badApp.get('/api/v1/illegal', () => ({ ok: false }));
      }).toThrow(/has no catalogued permission/);
    });
  });
});
