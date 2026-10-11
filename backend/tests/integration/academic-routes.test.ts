import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import { DEPT_1, DEPT_3 } from '../support/fixtures.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/academics';

const LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  campusAdminA: 'campus.admin.a@college-a.test',
  facultyA: 'faculty.a@college-a.test',
  studentA: 'user.a@college-a.test',
} as const;
type UserKey = keyof typeof LOGINS;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

const sessions = {} as Record<UserKey, { cookie: string; csrf: string }>;
let suffix = 0;
const code = (p: string): string => `${p}${(suffix++).toString(36)}`;

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, Object.values(LOGINS)],
  );
  for (const [key, email] of Object.entries(LOGINS) as [UserKey, string][]) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, email).toBe(200);
    sessions[key] = {
      cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
      csrf: r.json<{ csrf_token: string }>().csrf_token,
    };
  }
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

function get(user: UserKey | null, path: string) {
  return app.inject({
    method: 'GET',
    url: path,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
}
function send(
  method: 'POST' | 'PATCH',
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string } = {},
) {
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: { ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}), origin: APP_ORIGIN },
  });
}

async function createPeriodType(): Promise<string> {
  const r = await send('POST', 'orgAdminA', `${BASE}/period-types`, {
    code: code('PT'),
    label: 'Semester',
    labelPlural: 'Semesters',
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ data: { id: string } }>().data.id;
}

async function createProgram(departmentId = DEPT_1): Promise<string> {
  const periodTypeId = await createPeriodType();
  const r = await send('POST', 'orgAdminA', `${BASE}/programs`, {
    departmentId,
    periodTypeId,
    name: 'B.Tech',
    code: code('BT'),
    degreeLevel: 'UG',
    durationPeriods: 8,
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ data: { id: string } }>().data.id;
}

describe('academics routes: authentication & permission gate', () => {
  it('rejects unauthenticated access with 401', async () => {
    expect((await get(null, `${BASE}/programs`)).statusCode).toBe(401);
  });

  it('allows a reader (student) to GET but forbids POST', async () => {
    expect((await get('studentA', `${BASE}/period-types`)).statusCode).toBe(200);
    const r = await send('POST', 'studentA', `${BASE}/period-types`, {
      code: code('X'),
      label: 'L',
      labelPlural: 'Ls',
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects a state-changing request without a CSRF token (403)', async () => {
    const r = await send(
      'POST',
      'orgAdminA',
      `${BASE}/period-types`,
      { code: code('C'), label: 'L', labelPlural: 'Ls' },
      { csrf: '' },
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('academics routes: validation', () => {
  it('rejects an unknown field (e.g. a client-supplied organizationId) with 400', async () => {
    const r = await send('POST', 'orgAdminA', `${BASE}/period-types`, {
      code: code('C'),
      label: 'L',
      labelPlural: 'Ls',
      organizationId: '01939a00-0000-7000-8000-000000000a01',
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects an out-of-range durationPeriods with 400', async () => {
    const periodTypeId = await createPeriodType();
    const r = await send('POST', 'orgAdminA', `${BASE}/programs`, {
      departmentId: DEPT_1,
      periodTypeId,
      name: 'X',
      code: code('BT'),
      degreeLevel: 'UG',
      durationPeriods: 0,
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('academics routes: happy path & scope', () => {
  it('creates, lists and patches a program', async () => {
    const id = await createProgram(DEPT_1);
    const list = await get('orgAdminA', `${BASE}/programs`);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { id: string }[] }>().data.some((p) => p.id === id)).toBe(true);

    const patched = await send('PATCH', 'orgAdminA', `${BASE}/programs/${id}`, { name: 'Renamed' });
    expect(patched.statusCode).toBe(200);
  });

  it('creates a cohort under a program and lists it', async () => {
    const programId = await createProgram(DEPT_1);
    const created = await send('POST', 'orgAdminA', `${BASE}/cohorts`, {
      programId,
      admissionYear: 2025,
      name: 'Batch 2025',
    });
    expect(created.statusCode).toBe(201);
    const list = await get('orgAdminA', `${BASE}/cohorts?programId=${programId}`);
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('hides an out-of-scope program from PATCH as 404', async () => {
    const id = await createProgram(DEPT_3); // CAMPUS_2, outside campusAdminA scope
    const r = await send('PATCH', 'campusAdminA', `${BASE}/programs/${id}`, { name: 'Nope' });
    expect(r.statusCode).toBe(404);
  });

  it('a CAMPUS_ADMIN may create a program in its own campus but not another (201 vs 403)', async () => {
    const periodTypeId = await createPeriodType();
    const inScope = await send('POST', 'campusAdminA', `${BASE}/programs`, {
      departmentId: DEPT_1, // CAMPUS_1
      periodTypeId,
      name: 'In scope',
      code: code('BT'),
      degreeLevel: 'UG',
      durationPeriods: 8,
    });
    expect(inScope.statusCode).toBe(201);

    const outOfScope = await send('POST', 'campusAdminA', `${BASE}/programs`, {
      departmentId: DEPT_3, // CAMPUS_2
      periodTypeId,
      name: 'Out of scope',
      code: code('BT'),
      degreeLevel: 'UG',
      durationPeriods: 8,
    });
    expect(outOfScope.statusCode).toBe(403);
  });

  it('forbids a read-only faculty from creating a program (403)', async () => {
    const periodTypeId = await createPeriodType();
    const r = await send('POST', 'facultyA', `${BASE}/programs`, {
      departmentId: DEPT_1,
      periodTypeId,
      name: 'X',
      code: code('BT'),
      degreeLevel: 'UG',
      durationPeriods: 8,
    });
    expect(r.statusCode).toBe(403);
  });
});
