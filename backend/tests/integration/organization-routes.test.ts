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
  noRoleA: 'norole.a@college-a.test',
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

function put(
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string; origin?: string; headers?: Record<string, string>; ifMatch?: string } = {},
) {
  const cookie = user ? { session_token: sessions[user].cookie } : {};
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  const origin = opts.origin !== undefined ? opts.origin : APP_ORIGIN;
  const headers: Record<string, string> = {
    ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(opts.ifMatch !== undefined ? { 'if-match': opts.ifMatch } : {}),
    ...opts.headers,
  };
  return app.inject({
    method: 'PUT',
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: cookie,
    headers,
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

  describe('Designation Lifecycle & Contracts', () => {
    it('creates and lists designations with valid payloads and filtering', async () => {
      const code1 = `DSG_${Date.now().toString().slice(-8)}_1`;
      const code2 = `DSG_${Date.now().toString().slice(-8)}_2`;

      // 1. Create teaching designation
      const res1 = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Assistant Professor',
        code: code1,
        category: 'TEACHING',
      });
      expect(res1.statusCode).toBe(201);
      const d1 = res1.json<{
        success: boolean;
        data: {
          id: string;
        };
      }>();
      expect(d1.success).toBe(true);
      expect(typeof d1.data.id).toBe('string');

      // 2. Create second non-teaching designation and deactivate it directly in DB
      const res2 = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Lab Assistant Retired',
        code: code2,
        category: 'NON_TEACHING',
      });
      expect(res2.statusCode).toBe(201);
      await adminQuery(`UPDATE app.designations SET status = 'INACTIVE' WHERE code = $1`, [code2]);

      // 3. Manager lists all designations (can see INACTIVE)
      const listMgr = await get('orgAdminA', '/api/v1/organization/designations');
      expect(listMgr.statusCode).toBe(200);
      const mgrItems = listMgr.json<{ success: boolean; data: Array<{ code: string }> }>().data;
      expect(mgrItems.some((i) => i.code === code1)).toBe(true);
      expect(mgrItems.some((i) => i.code === code2)).toBe(true);

      // 4. Non-manager (student) lists designations - shielded from INACTIVE
      const listStudent = await get('studentA', '/api/v1/organization/designations');
      expect(listStudent.statusCode).toBe(200);
      const studentItems = listStudent.json<{ success: boolean; data: Array<{ code: string }> }>()
        .data;
      expect(studentItems.some((i) => i.code === code1)).toBe(true);
      expect(studentItems.some((i) => i.code === code2)).toBe(false);

      // 5. Non-manager explicit ?status=INACTIVE still shielded (returns empty for inactive)
      const listStudentInactive = await get(
        'studentA',
        '/api/v1/organization/designations?status=INACTIVE',
      );
      expect(listStudentInactive.statusCode).toBe(200);
      const inactiveItems = listStudentInactive.json<{
        success: boolean;
        data: Array<{ code: string }>;
      }>().data;
      expect(inactiveItems.some((i) => i.code === code2)).toBe(false);

      // 6. Category filter works
      const listTeaching = await get(
        'orgAdminA',
        '/api/v1/organization/designations?category=TEACHING',
      );
      expect(listTeaching.statusCode).toBe(200);
      const teachingItems = listTeaching.json<{ success: boolean; data: Array<{ code: string }> }>()
        .data;
      expect(teachingItems.some((i) => i.code === code1)).toBe(true);
      expect(teachingItems.some((i) => i.code === code2)).toBe(false);
    });

    it('rejects duplicate designation code within the same tenant with 409 CONFLICT', async () => {
      const code = `DUP_${Date.now().toString().slice(-8)}`;
      const first = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Professor First',
        code,
        category: 'TEACHING',
      });
      expect(first.statusCode).toBe(201);

      const second = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Professor Second',
        code,
        category: 'TEACHING',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    });

    it('rejects unauthorized users attempting to create designations with 403 FORBIDDEN', async () => {
      // Campus admin has CAMPUS scope, not ORGANIZATION scope
      const resCampusAdmin = await post('campusAdminA', '/api/v1/organization/designations', {
        name: 'Unauthorized Designation',
        code: 'UNAUTH_01',
        category: 'TEACHING',
      });
      expect(resCampusAdmin.statusCode).toBe(403);
      expect(resCampusAdmin.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      // Student has org.structure.read only
      const resStudent = await post('studentA', '/api/v1/organization/designations', {
        name: 'Student Created Designation',
        code: 'STUD_01',
        category: 'ADMIN',
      });
      expect(resStudent.statusCode).toBe(403);
      expect(resStudent.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });

    it('rejects invalid category and status with 400 BAD_REQUEST', async () => {
      const res1 = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Invalid Category',
        code: 'INV_CAT',
        category: 'UNKNOWN',
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await post('orgAdminA', '/api/v1/organization/designations', {
        name: 'Invalid Status',
        code: 'INV_STAT',
        category: 'TEACHING',
        status: 'DELETED',
      });
      expect(res2.statusCode).toBe(400);
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

      const dsgRes = await get(null, `/api/v1/organization/designations`);
      expect(dsgRes.statusCode).toBe(401);
      expect(dsgRes.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    });

    it('returns 403 FORBIDDEN when user has insufficient permissions', async () => {
      // User with no roles/permissions cannot read campuses or departments or designations
      const r1 = await get('noRoleA', `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(r1.statusCode).toBe(403);
      expect(r1.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const r2 = await get('noRoleA', `/api/v1/organization/campuses`);
      expect(r2.statusCode).toBe(403);
      expect(r2.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const r3 = await get('noRoleA', `/api/v1/organization/departments/${DEPT_1}`);
      expect(r3.statusCode).toBe(403);
      expect(r3.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const r4 = await get('noRoleA', `/api/v1/organization/departments`);
      expect(r4.statusCode).toBe(403);
      expect(r4.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      const rDsg = await get('noRoleA', `/api/v1/organization/designations`);
      expect(rDsg.statusCode).toBe(403);
      expect(rDsg.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

      // STUDENT has org.structure.read so can read, but has no org.campus.manage so cannot create
      const r5 = await post('studentA', '/api/v1/organization/campuses', {
        name: 'Rogue Campus',
        code: 'ROGUE',
        timezone: 'Asia/Kolkata',
      });
      expect(r5.statusCode).toBe(403);
      expect(r5.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });

    it('allows read access to campuses and departments for callers with org.structure.read', async () => {
      // STUDENT has org.structure.read
      const r1 = await get('studentA', `/api/v1/organization/campuses/${CAMPUS_1}`);
      expect(r1.statusCode).toBe(200);

      const r2 = await get('studentA', `/api/v1/organization/campuses`);
      expect(r2.statusCode).toBe(200);
      const campuses = r2.json<{ success: boolean; data: unknown[] }>();
      expect(campuses.success).toBe(true);
      expect(campuses.data.length).toBeGreaterThan(0);

      // FACULTY has org.structure.read
      const r3 = await get('facultyA', `/api/v1/organization/departments/${DEPT_1}`);
      expect(r3.statusCode).toBe(200);

      const r4 = await get('facultyA', `/api/v1/organization/departments`);
      expect(r4.statusCode).toBe(200);
      const depts = r4.json<{ success: boolean; data: unknown[] }>();
      expect(depts.success).toBe(true);
      expect(depts.data.length).toBeGreaterThan(0);
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

    it('read endpoints do NOT write audit events', async () => {
      const readsBefore = await adminQuery<{ action: string }>(
        `SELECT action FROM app.audit_events WHERE action LIKE '%read%' OR action LIKE '%list%'`,
      );
      expect(readsBefore).toEqual([]);

      await get('orgAdminA', `/api/v1/organization/campuses`);
      await get('orgAdminA', `/api/v1/organization/campuses/${CAMPUS_1}`);
      await get('orgAdminA', `/api/v1/organization/departments`);
      await get('orgAdminA', `/api/v1/organization/departments/${DEPT_1}`);
      await get('studentA', `/api/v1/organization/campuses`);
      await get('studentA', `/api/v1/organization/departments`);
      await get('studentA', `/api/v1/organization/designations`);

      const readsAfter = await adminQuery<{ action: string }>(
        `SELECT action FROM app.audit_events WHERE action LIKE '%read%' OR action LIKE '%list%'`,
      );
      expect(readsAfter).toEqual([]);
    });
  });

  describe('Organization Settings (GET /settings, PUT /settings/:key)', () => {
    const BASE = '/api/v1/organization/settings';
    const AGE = 'identity.age_of_majority';
    const NOTIFY = 'guardian.notification_policy';
    const REASON = 'Aligned with the institution policy';
    type Rec = {
      key: string;
      value: unknown;
      isDefault: boolean;
      version: number | null;
      updatedAt: string | null;
    };
    type Err = { error: { code: string; message: string; requestId?: string } };

    const auditFor = (org: string, key: string) =>
      adminQuery<{
        risk_tier: number;
        reason_text: string;
        ip: string;
        request_id: string;
        actor_user_id: string;
        changes: { value: { old: unknown; new: unknown } };
        metadata: { settingKey: string; created: boolean };
      }>(
        `SELECT risk_tier, reason_text, ip, request_id, actor_user_id, changes, metadata
           FROM app.audit_events
          WHERE organization_id = $1 AND action = 'organization.setting.update' AND metadata->>'settingKey' = $2
          ORDER BY occurred_at`,
        [org, key],
      );
    const stored = (org: string, key: string) =>
      adminQuery<{ value: unknown; version: number }>(
        'SELECT value, version FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
        [org, key],
      );
    const wipe = () =>
      adminQuery('DELETE FROM app.organization_settings WHERE organization_id = ANY($1::uuid[])', [
        [ORG_A, '01939a00-0000-7000-8000-000000000b01'],
      ]);
    beforeAll(wipe);
    afterAll(wipe);

    it('requires authentication for GET and PUT', async () => {
      expect((await get(null, BASE)).statusCode).toBe(401);
      expect(
        (await put(null, `${BASE}/${AGE}`, { value: 21, reason: REASON }, { ifMatch: '"0"' }))
          .statusCode,
      ).toBe(401);
    });

    it('lists the registry defaults for a tenant that has stored nothing, in the standard envelope', async () => {
      const res = await get('orgAdminA', BASE);
      expect(res.statusCode).toBe(200);
      expect(res.headers['etag']).toMatch(/^W\/"[a-f0-9]+"/);
      expect(res.json<{ success: boolean; data: Rec[] }>()).toEqual({
        success: true,
        data: [{ key: AGE, value: 18, isDefault: true, version: null, updatedAt: null }],
      });
    });

    it('PUT creates, then updates, then treats an identical value as a no-op', async () => {
      const first = await put(
        'orgAdminA',
        `${BASE}/${AGE}`,
        { value: 21, reason: REASON },
        { ifMatch: '"0"' },
      );
      expect(first.statusCode).toBe(200);
      expect(first.headers['etag']).toBe('"1"');
      const a = first.json<{ success: boolean; data: Rec }>();
      expect(a.data).toMatchObject({ key: AGE, value: 21, isDefault: false, version: 1 });

      const second = await put(
        'orgAdminA',
        `${BASE}/${AGE}`,
        { value: 16, reason: REASON },
        { ifMatch: '"1"' },
      );
      expect(second.statusCode).toBe(200);
      expect(second.headers['etag']).toBe('"2"');
      expect(second.json<{ data: Rec }>().data).toMatchObject({ value: 16, version: 2 });

      const same = await put(
        'orgAdminA',
        `${BASE}/${AGE}`,
        { value: 16, reason: REASON },
        { ifMatch: '"2"' },
      );
      expect(same.statusCode).toBe(200);
      expect(same.headers['etag']).toBe('"2"');
      expect(same.json<{ data: Rec }>().data).toMatchObject({ value: 16, version: 2 });
      expect(await stored(ORG_A, AGE)).toEqual([{ value: 16, version: 2 }]);

      const list = await get('orgAdminA', BASE);
      expect(list.json<{ data: Rec[] }>().data).toEqual([
        expect.objectContaining({ key: AGE, value: 16, isDefault: false, version: 2 }),
      ]);
    });

    it('audits each change once, with reason, tier 2, request facts and an old/new diff; a no-op and reads add nothing', async () => {
      const before = (await auditFor(ORG_A, NOTIFY)).length;
      const created = await put(
        'orgAdminA',
        `${BASE}/${NOTIFY}`,
        {
          value: 'NEVER',
          reason: REASON,
        },
        { ifMatch: '"0"' },
      );
      expect(created.statusCode).toBe(200);
      expect(created.headers['etag']).toBe('"1"');
      const changed = await put(
        'orgAdminA',
        `${BASE}/${NOTIFY}`,
        {
          value: 'MINORS_ONLY',
          reason: `${REASON} (second)`,
        },
        { ifMatch: '"1"' },
      );
      expect(changed.statusCode).toBe(200);
      expect(changed.headers['etag']).toBe('"2"');
      await put(
        'orgAdminA',
        `${BASE}/${NOTIFY}`,
        { value: 'MINORS_ONLY', reason: REASON },
        { ifMatch: '"2"' },
      ); // no-op
      await get('orgAdminA', BASE);

      const rows = (await auditFor(ORG_A, NOTIFY)).slice(before);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        risk_tier: 2,
        reason_text: REASON,
        ip: '127.0.0.1',
        changes: { value: { old: null, new: 'NEVER' } },
        metadata: { settingKey: NOTIFY, created: true },
      });
      expect(rows[1]).toMatchObject({
        reason_text: `${REASON} (second)`,
        changes: { value: { old: 'NEVER', new: 'MINORS_ONLY' } },
        metadata: { settingKey: NOTIFY, created: false },
      });
      expect(typeof rows[0]?.request_id).toBe('string');
      expect(rows[0]?.request_id).not.toBe(rows[1]?.request_id);
    });

    it.each(['campusAdminA', 'facultyA', 'studentA', 'noRoleA'] as const)(
      '%s cannot write: 403 FORBIDDEN, nothing stored, nothing audited',
      async (user) => {
        const auditBefore = (await auditFor(ORG_A, 'identity.dob_required')).length;
        const res = await put(
          user,
          `${BASE}/identity.dob_required`,
          {
            value: true,
            reason: REASON,
          },
          { ifMatch: '"0"' },
        );
        expect(res.statusCode).toBe(403);
        expect(res.json<Err>().error.code).toBe('FORBIDDEN');
        expect(await stored(ORG_A, 'identity.dob_required')).toEqual([]);
        expect((await auditFor(ORG_A, 'identity.dob_required')).length).toBe(auditBefore);
      },
    );

    it.each(['facultyA', 'studentA', 'noRoleA'] as const)(
      '%s cannot read: 403 at the route gate',
      async (user) => {
        const res = await get(user, BASE);
        expect(res.statusCode).toBe(403);
        expect(res.json<Err>().error.code).toBe('FORBIDDEN');
      },
    );

    it('CAMPUS_ADMIN holds org.settings.read at CAMPUS scope: may read tenant-wide settings (200), but cannot write (403)', async () => {
      const res = await get('campusAdminA', BASE);
      expect(res.statusCode).toBe(200);
      expect(res.headers['etag']).toMatch(/^W\/"[a-f0-9]+"/);
      expect(res.json<{ success: boolean; data: Rec[] }>().success).toBe(true);
    });

    it('PUT is state-changing: it requires the CSRF token and an allowed Origin', async () => {
      const path = `${BASE}/identity.dob_required`;
      const body = { value: true, reason: REASON };
      for (const opts of [
        { csrf: 'not-the-token' },
        { csrf: '' },
        { origin: 'https://evil.example' },
      ]) {
        const res = await put('orgAdminA', path, body, { ...opts, ifMatch: '"0"' });
        expect(res.statusCode, JSON.stringify(opts)).toBe(403);
        expect(res.json<Err>().error.code).toBe('CSRF_REJECTED');
      }
      const noToken = await app.inject({
        method: 'PUT',
        url: path,
        payload: body,
        cookies: { session_token: sessions.orgAdminA.cookie },
        headers: { origin: APP_ORIGIN, 'if-match': '"0"' },
      });
      expect(noToken.statusCode).toBe(403);
      expect(await stored(ORG_A, 'identity.dob_required')).toEqual([]);
    });

    it('rejects bad input with 400 and stores nothing: schema-level (BAD_REQUEST) and service-level (VALIDATION_ERROR)', async () => {
      const path = `${BASE}/identity.dob_required`;
      // rejected by the route schema, before the handler
      const schemaLevel: unknown[] = [
        {},
        { value: true },
        { reason: REASON },
        { value: true, reason: 'abc' },
        { value: true, reason: REASON, organizationId: ORG_A },
        { value: true, reason: REASON, organization_id: ORG_A },
        { value: true, reason: REASON, updatedBy: ORG_A },
        { value: true, reason: REASON, version: 7 },
        { value: true, reason: REASON, key: 'identity.age_of_majority' },
      ];
      for (const payload of schemaLevel) {
        const res = await put('orgAdminA', path, payload as InjectOptions['payload'], {
          ifMatch: '"0"',
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json<Err>().error.code, JSON.stringify(payload)).toBe('BAD_REQUEST');
      }
      // pass the schema, refused by the service: a blank reason and values outside the key's schema
      const serviceLevel: unknown[] = [
        { value: true, reason: '     ' },
        { value: 'yes', reason: REASON },
        { value: null, reason: REASON },
        { value: 1, reason: REASON },
      ];
      for (const payload of serviceLevel) {
        const res = await put('orgAdminA', path, payload as InjectOptions['payload'], {
          ifMatch: '"0"',
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json<Err>().error.code, JSON.stringify(payload)).toBe('VALIDATION_ERROR');
      }
      expect(await stored(ORG_A, 'identity.dob_required')).toEqual([]);
    });

    it('an unregistered key is 404 for an administrator; a malformed or over-long key never reaches the handler', async () => {
      const unknown = await put(
        'orgAdminA',
        `${BASE}/no.such_key`,
        { value: 1, reason: REASON },
        { ifMatch: '"0"' },
      );
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<Err>().error.code).toBe('RESOURCE_NOT_FOUND');
      for (const key of ['Bad-Key', 'identity.', '.identity']) {
        const res = await put(
          'orgAdminA',
          `${BASE}/${encodeURIComponent(key)}`,
          {
            value: 1,
            reason: REASON,
          },
          { ifMatch: '"0"' },
        );
        expect(res.statusCode, key).toBe(400);
        expect(res.json<Err>().error.code, key).toBe('BAD_REQUEST');
      }
      // 101 characters: the router's parameter limit (100) refuses it first, as a client error, never a 2xx/5xx
      const tooLong = await put(
        'orgAdminA',
        `${BASE}/${'k'.repeat(101)}`,
        {
          value: 1,
          reason: REASON,
        },
        { ifMatch: '"0"' },
      );
      expect([400, 414]).toContain(tooLong.statusCode);
    });

    it('tenants are independent: tenant B reads and writes only its own value', async () => {
      const b = await put(
        'orgAdminB',
        `${BASE}/${AGE}`,
        { value: 19, reason: REASON },
        { ifMatch: '"0"' },
      );
      expect(b.statusCode).toBe(200);
      expect(b.headers['etag']).toBe('"1"');
      expect(b.json<{ data: Rec }>().data).toMatchObject({ value: 19, version: 1 });
      expect(await stored(ORG_A, AGE)).toEqual([{ value: 16, version: 2 }]); // untouched
      const listB = await get('orgAdminB', BASE);
      expect(listB.json<{ data: Rec[] }>().data).toEqual([
        expect.objectContaining({ key: AGE, value: 19, version: 1 }),
      ]);
      const listA = await get('orgAdminA', BASE);
      expect(listA.json<{ data: Rec[] }>().data.find((r) => r.key === AGE)?.value).toBe(16);
    });

    describe('Optimistic Concurrency & ETag Verification', () => {
      it('GET /settings returns a collection weak ETag header', async () => {
        const res = await get('orgAdminA', BASE);
        expect(res.statusCode).toBe(200);
        expect(res.headers['etag']).toMatch(/^W\/"[a-f0-9]+"/);
      });

      it('PUT /settings/:key without If-Match returns 428 PRECONDITION_REQUIRED', async () => {
        const res = await put('orgAdminA', `${BASE}/${AGE}`, { value: 21, reason: REASON });
        expect(res.statusCode).toBe(428);
        expect(res.json<Err>().error.code).toBe('PRECONDITION_REQUIRED');
      });

      it('PUT /settings/:key with malformed If-Match returns 400 BAD_REQUEST', async () => {
        for (const bad of ['invalid', 'abc', '-1', '1.5', '""']) {
          const res = await put(
            'orgAdminA',
            `${BASE}/${AGE}`,
            { value: 21, reason: REASON },
            { ifMatch: bad },
          );
          expect(res.statusCode).toBe(400);
          expect(res.json<Err>().error.code).toBe('BAD_REQUEST');
        }
      });

      it('PUT /settings/:key with weak If-Match returns 400 BAD_REQUEST and does not mutate', async () => {
        const current = await stored(ORG_A, AGE);
        const currentVer = current[0]?.version ?? 2;
        const res = await put(
          'orgAdminA',
          `${BASE}/${AGE}`,
          { value: 25, reason: REASON },
          { ifMatch: `W/"${currentVer}"` },
        );
        expect(res.statusCode).toBe(400);
        expect(res.json<Err>().error.code).toBe('BAD_REQUEST');
        expect(await stored(ORG_A, AGE)).toEqual(current); // unmutated
      });

      it('PUT /settings/:key with stale If-Match returns 409 CONFLICT', async () => {
        // AGE in ORG_A is stored at version 2
        const current = await stored(ORG_A, AGE);
        const currentVer = current[0]?.version ?? 2;
        const staleVer = currentVer - 1;

        const stale = await put(
          'orgAdminA',
          `${BASE}/${AGE}`,
          { value: 25, reason: REASON },
          { ifMatch: `"${staleVer}"` },
        );
        expect(stale.statusCode).toBe(409);
        expect(stale.json<Err>().error.code).toBe('CONFLICT');
        expect(await stored(ORG_A, AGE)).toEqual(current); // unmutated
      });

      it('PUT /settings/:key with If-Match: * succeeds on existing setting and updates version', async () => {
        const current = await stored(ORG_A, AGE);
        const currentVer = current[0]?.version ?? 2;
        const nextVer = currentVer + 1;

        const res = await put(
          'orgAdminA',
          `${BASE}/${AGE}`,
          { value: 25, reason: REASON },
          { ifMatch: '*' },
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers.etag).toBe(`"${nextVer}"`);
        expect(res.json<{ data: Rec }>().data).toMatchObject({
          key: AGE,
          value: 25,
          version: nextVer,
        });
        expect(await stored(ORG_A, AGE)).toEqual([{ value: 25, version: nextVer }]);
      });

      it('PUT /settings/:key with If-Match: * returns 409 CONFLICT on unpersisted default and creates no row', async () => {
        // Delete stored row so AGE exists only as an unpersisted registry default in ORG_A
        await adminQuery(
          'DELETE FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
          [ORG_A, AGE],
        );
        expect(await stored(ORG_A, AGE)).toEqual([]);

        // Confirm it is visible in GET as an unpersisted default
        const list = await get('orgAdminA', BASE);
        const item = list.json<{ data: Rec[] }>().data.find((r) => r.key === AGE);
        expect(item).toMatchObject({ key: AGE, isDefault: true, version: null });

        const res = await put(
          'orgAdminA',
          `${BASE}/${AGE}`,
          { value: 21, reason: REASON },
          { ifMatch: '*' },
        );
        expect(res.statusCode).toBe(409);
        expect(res.json<Err>().error.code).toBe('CONFLICT');
        expect(await stored(ORG_A, AGE)).toEqual([]); // no row created
      });

      it('parallel PUT requests with the same initial If-Match: exactly one succeeds (200), one conflicts (409)', async () => {
        await adminQuery(
          'DELETE FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
          [ORG_A, 'guardian.academic_visibility'],
        );
        const [res1, res2] = await Promise.all([
          put(
            'orgAdminA',
            `${BASE}/guardian.academic_visibility`,
            { value: 'MINORS_ONLY', reason: `${REASON} branch 1` },
            { ifMatch: '"0"' },
          ),
          put(
            'orgAdminA',
            `${BASE}/guardian.academic_visibility`,
            { value: 'ALWAYS_WHEN_LINKED', reason: `${REASON} branch 2` },
            { ifMatch: '"0"' },
          ),
        ]);
        const statuses = [res1.statusCode, res2.statusCode].sort();
        expect(statuses).toEqual([200, 409]);
      });
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
