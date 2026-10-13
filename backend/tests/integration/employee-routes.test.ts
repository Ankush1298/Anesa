import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';
import { FACULTY_A, LOCK_A, STAFF_B, UNKNOWN_V7 } from '../support/fixtures.js';

// Committed rows: this file owns FACULTY_A and LOCK_A as employee targets (employee.test.ts never uses them) and
// removes its rows afterwards. Codes are prefixed RT- for that cleanup.
const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/faculty/employees';

const LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  campusAdminA: 'campus.admin.a@college-a.test',
  hodA: 'hod.a@college-a.test',
  facultyA: 'faculty.a@college-a.test',
  studentA: 'user.a@college-a.test',
  orgAdminB: 'staff.b@college-b.test',
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
  opts: { csrf?: string; ifMatch?: string } = {},
) {
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(opts.ifMatch !== undefined ? { 'if-match': opts.ifMatch } : {}),
    },
  });
}

const create = (user: UserKey, userId: string, code: string, extra: object = {}) =>
  send('POST', user, BASE, {
    userId,
    employeeCode: code,
    employeeType: 'FACULTY',
    joiningDate: '2024-06-01',
    reason: 'Initial onboarding',
    ...extra,
  });

let facultyEmployeeId = '';
let lockEmployeeId = '';

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
  const a = await create('orgAdminA', FACULTY_A, 'RT-FAC');
  expect(a.statusCode).toBe(201);
  facultyEmployeeId = a.json<{ data: { id: string } }>().data.id;
  const b = await create('orgAdminA', LOCK_A, 'RT-LOCK', { employeeType: 'STAFF' });
  expect(b.statusCode).toBe(201);
  lockEmployeeId = b.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await adminQuery("DELETE FROM app.employees WHERE employee_code LIKE 'RT-%'");
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('employee routes: authentication, CSRF and validation', () => {
  it('401 without a session', async () => {
    expect((await get(null, BASE)).statusCode).toBe(401);
    expect((await get(null, `${BASE}/${facultyEmployeeId}`)).statusCode).toBe(401);
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    const r = await send(
      'POST',
      'orgAdminA',
      BASE,
      {
        userId: LOCK_A,
        employeeCode: 'RT-X',
        employeeType: 'STAFF',
        joiningDate: '2024-01-01',
        reason: 'Because',
      },
      { csrf: '' },
    );
    expect(r.statusCode).toBe(403);
  });

  it.each([
    ['client-supplied organizationId', { organizationId: '01939a00-0000-7000-8000-000000000a01' }],
    ['client-supplied status', { status: 'SEPARATED' }],
    ['client-supplied version', { version: 5 }],
    ['client-supplied leavingDate', { leavingDate: '2025-01-01' }],
    ['unknown field', { salary: 1 }],
    ['unknown employee type', { employeeType: 'DEAN' }],
    ['non-UUIDv7 userId', { userId: '3b241101-e2bb-4255-8caf-4136c566a962' }],
    ['bad date', { joiningDate: '2024-02-30' }],
    ['missing reason', { reason: undefined }],
  ])('400 for %s', async (_n, extra) => {
    const r = await create('orgAdminA', LOCK_A, 'RT-BAD', extra);
    expect(r.statusCode).toBe(400);
  });

  it('the shared validation helpers keep the established employee messages (regression for the extraction)', async () => {
    const message = (r: { json: <T>() => T }): string =>
      r.json<{ error: { message: string } }>().error.message;
    const badDate = await create('orgAdminA', LOCK_A, 'RT-BAD', { joiningDate: '2024-02-30' });
    expect(badDate.statusCode).toBe(400);
    expect(message(badDate)).toBe(
      'joiningDate must be a real calendar date (YYYY-MM-DD) between 1900 and 2200.',
    );
    // five spaces pass the schema's length check and are rejected by the service after trimming
    const blank = await create('orgAdminA', LOCK_A, 'RT-BAD', { reason: '     ' });
    expect(blank.statusCode).toBe(400);
    expect(message(blank)).toBe('Reason must be 5 to 500 characters.');
    const badLeaving = await send(
      'PATCH',
      'orgAdminA',
      `${BASE}/${lockEmployeeId}`,
      { leavingDate: '2023-13-01', reason: 'Correcting the record' },
      { ifMatch: '"1"' },
    );
    expect(badLeaving.statusCode).toBe(400);
    expect(message(badLeaving)).toBe(
      'leavingDate must be a real calendar date (YYYY-MM-DD) between 1900 and 2200.',
    );
  });

  it('400 for a malformed id and an empty PATCH', async () => {
    expect((await get('orgAdminA', `${BASE}/not-a-uuid`)).statusCode).toBe(400);
    const r = await send(
      'PATCH',
      'orgAdminA',
      `${BASE}/${lockEmployeeId}`,
      { reason: 'Just a reason' },
      { ifMatch: '*' },
    );
    expect(r.statusCode).toBe(400);
  });
});

describe('employee routes: org admin lifecycle and If-Match', () => {
  it('GET returns the record with a strong ETag', async () => {
    const r = await get('orgAdminA', `${BASE}/${lockEmployeeId}`);
    expect(r.statusCode).toBe(200);
    const rec = r.json<{
      data: { id: string; employeeCode: string; version: number; userId: string };
    }>().data;
    expect(rec).toMatchObject({ id: lockEmployeeId, employeeCode: 'RT-LOCK', userId: LOCK_A });
    expect(r.headers['etag']).toBe(`"${rec.version}"`);
  });

  it("404 for another tenant's user; 409 for a second record for the same account", async () => {
    expect((await create('orgAdminA', STAFF_B, 'RT-FAC')).statusCode).toBe(404); // another tenant's user
    expect((await create('orgAdminA', LOCK_A, 'RT-DUP')).statusCode).toBe(409);
  });

  it('PATCH: 428 without If-Match, 400 for a weak tag, 409 when stale, 200 + new ETag when current', async () => {
    const path = `${BASE}/${lockEmployeeId}`;
    const change = { status: 'ON_LEAVE', reason: 'Medical leave approved' };
    expect((await send('PATCH', 'orgAdminA', path, change)).statusCode).toBe(428);
    expect((await send('PATCH', 'orgAdminA', path, change, { ifMatch: 'W/"1"' })).statusCode).toBe(
      400,
    );
    expect((await send('PATCH', 'orgAdminA', path, change, { ifMatch: '"99"' })).statusCode).toBe(
      409,
    );

    const ok = await send('PATCH', 'orgAdminA', path, change, { ifMatch: '"1"' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ data: { status: string; version: number } }>().data).toMatchObject({
      status: 'ON_LEAVE',
      version: 2,
    });
    expect(ok.headers['etag']).toBe('"2"');

    // replaying the same If-Match is now stale
    expect((await send('PATCH', 'orgAdminA', path, change, { ifMatch: '"1"' })).statusCode).toBe(
      409,
    );
    // restore for the other tests
    const back = await send(
      'PATCH',
      'orgAdminA',
      path,
      { status: 'ACTIVE', reason: 'Returned from leave' },
      { ifMatch: '*' },
    );
    expect(back.statusCode).toBe(200);
  });

  it('list supports filters and returns the record shape', async () => {
    const r = await get('orgAdminA', `${BASE}?employeeType=STAFF&limit=100`);
    expect(r.statusCode).toBe(200);
    const rows = r.json<{ data: { id: string; employeeType: string }[] }>().data;
    expect(rows.some((e) => e.id === lockEmployeeId)).toBe(true);
    expect(rows.every((e) => e.employeeType === 'STAFF')).toBe(true);
    expect((await get('orgAdminA', `${BASE}?limit=0`)).statusCode).toBe(400);
    expect((await get('orgAdminA', `${BASE}?limit=100`)).statusCode).toBe(200); // the documented cap
    expect((await get('orgAdminA', `${BASE}?limit=101`)).statusCode).toBe(400); // one over
    expect((await get('orgAdminA', `${BASE}?offset=-1`)).statusCode).toBe(400);
    expect((await get('orgAdminA', `${BASE}?bogus=1`)).statusCode).toBe(400);
  });
});

describe('employee routes: leavingDate is independent of status (01 §3.4: optional, no coupling)', () => {
  const path = (): string => `${BASE}/${lockEmployeeId}`;
  const patchIt = (payload: object) =>
    send('PATCH', 'orgAdminA', path(), { reason: 'Recorded by HR', ...payload }, { ifMatch: '*' });

  it('sets, clears (JSON null survives AJV coercion) and rejects malformed or inverted dates', async () => {
    const set = await patchIt({ leavingDate: '2030-01-31' });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ data: { status: string; leavingDate: string } }>().data).toMatchObject({
      status: 'ACTIVE', // a leaving date does not imply SEPARATED
      leavingDate: '2030-01-31',
    });

    const sep = await patchIt({ status: 'SEPARATED' });
    expect(sep.json<{ data: { leavingDate: string } }>().data.leavingDate).toBe('2030-01-31'); // untouched

    const cleared = await patchIt({ leavingDate: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ data: { status: string; leavingDate: null } }>().data).toMatchObject({
      status: 'SEPARATED',
      leavingDate: null,
    }); // SEPARATED needs no date

    expect((await patchIt({ leavingDate: '' })).statusCode).toBe(400);
    expect((await patchIt({ leavingDate: '2030-02-30' })).statusCode).toBe(400);
    expect((await patchIt({ leavingDate: '2000-01-01' })).statusCode).toBe(400); // before joining (2024-06-01)

    const back = await patchIt({ status: 'ACTIVE' }); // restore for the other tests
    expect(back.statusCode).toBe(200);
  });

  it('PATCH rejects immutable and server-managed fields (mass assignment, doc 09)', async () => {
    const before = (await get('orgAdminA', path())).json<{ data: object }>().data;
    for (const extra of [
      { employeeCode: 'RT-HIJACK' },
      { userId: LOCK_A },
      { organizationId: '01939a00-0000-7000-8000-000000000a01' },
      { version: 9 },
      { id: UNKNOWN_V7 },
    ]) {
      const r = await patchIt({ status: 'ON_LEAVE', ...extra });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    // no persisted effect: the record (including version and updatedAt) is exactly as it was
    const after = (await get('orgAdminA', path())).json<{ data: object }>().data;
    expect(after).toEqual(before);
  });
});

describe('employee routes: role restrictions and scope', () => {
  it('FACULTY (SELF mode): reads only their own record, lists only it, cannot write', async () => {
    const own = await get('facultyA', `${BASE}/${facultyEmployeeId}`);
    expect(own.statusCode).toBe(200);
    expect((await get('facultyA', `${BASE}/${lockEmployeeId}`)).statusCode).toBe(404);

    const list = await get('facultyA', BASE);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { id: string }[] }>().data.map((e) => e.id)).toEqual([
      facultyEmployeeId,
    ]);

    expect((await create('facultyA', LOCK_A, 'RT-NOPE')).statusCode).toBe(403);
    const patch = await send(
      'PATCH',
      'facultyA',
      `${BASE}/${facultyEmployeeId}`,
      { status: 'ON_LEAVE', reason: 'Self edit' },
      { ifMatch: '*' },
    );
    expect(patch.statusCode).toBe(403);
  });

  it('STUDENT: 403 on every employee route', async () => {
    expect((await get('studentA', BASE)).statusCode).toBe(403);
    expect((await get('studentA', `${BASE}/${facultyEmployeeId}`)).statusCode).toBe(403);
    expect((await create('studentA', LOCK_A, 'RT-NOPE')).statusCode).toBe(403);
  });

  it('CAMPUS_ADMIN and HOD (scoped grants): empty list, 404 on a record, 403 on create', async () => {
    for (const who of ['campusAdminA', 'hodA'] as const) {
      const list = await get(who, BASE);
      expect(list.statusCode, who).toBe(200);
      expect(list.json<{ data: unknown[] }>().data, who).toEqual([]);
      expect((await get(who, `${BASE}/${facultyEmployeeId}`)).statusCode, who).toBe(404);
    }
    expect((await create('campusAdminA', LOCK_A, 'RT-NOPE')).statusCode).toBe(403);
    const patch = await send(
      'PATCH',
      'campusAdminA',
      `${BASE}/${facultyEmployeeId}`,
      { status: 'ON_LEAVE', reason: 'Out of scope' },
      { ifMatch: '*' },
    );
    expect(patch.statusCode).toBe(404);
    expect((await create('hodA', LOCK_A, 'RT-NOPE')).statusCode).toBe(403);
  });

  it('cross-tenant: another tenant admin sees none of it and cannot reach it by id', async () => {
    const list = await get('orgAdminB', `${BASE}?limit=100`);
    expect(list.statusCode).toBe(200);
    const ids = list.json<{ data: { id: string }[] }>().data.map((e) => e.id);
    expect(ids).not.toContain(facultyEmployeeId);
    expect(ids).not.toContain(lockEmployeeId);
    expect((await get('orgAdminB', `${BASE}/${facultyEmployeeId}`)).statusCode).toBe(404);
    const patch = await send(
      'PATCH',
      'orgAdminB',
      `${BASE}/${facultyEmployeeId}`,
      { status: 'ON_LEAVE', reason: 'Cross tenant' },
      { ifMatch: '*' },
    );
    expect(patch.statusCode).toBe(404);
    expect((await get('orgAdminA', `${BASE}/${UNKNOWN_V7}`)).statusCode).toBe(404);
  });
});
