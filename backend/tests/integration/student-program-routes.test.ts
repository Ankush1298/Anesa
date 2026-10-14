import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// HTTP-level tests of POST /api/v1/students/:id/programs and POST /api/v1/students/:id/programs/:pid/close against the
// shared disposable integration database. Everything commits, so it runs in a private tenant plus one second private
// tenant for the cross-tenant checks; assertions look only at rows created here (by id).

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/students';
const RUN = randomBytes(3).toString('hex');

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 6 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Actor = 'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'student' | 'foreignAdmin';
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;

interface Structure {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Structure;
let otherCampus!: Structure;
let sibling!: Structure;
let PERIOD: string;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

async function login(email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}
async function mkStructure(campus: string, dept?: string): Promise<Structure> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Route dept', $4)`,
      [d, T.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Route program', $5, 'UG', 8)`,
    [program, T.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Route cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
let studentSeq = 0;
async function mkStudent(status = 'ACTIVE'): Promise<string> {
  const user = uuidv7();
  const email = `spr-${RUN}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [user, T.orgId, email],
  );
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', $5)`,
    [id, T.orgId, user, `SPR${RUN}${studentSeq++}`, status],
  );
  return id;
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkStructure(T.campusId, T.departmentId);
  sibling = await mkStructure(T.campusId);
  const campus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Other campus', $3, 'Asia/Kolkata')`,
    [campus, T.orgId, code('C')],
  );
  otherCampus = await mkStructure(campus);
  sessions.admin = await login(T.emails.admin);
  sessions.campusAdmin = await login(T.emails.campusAdmin);
  sessions.hod = await login(T.emails.hod);
  sessions.faculty = await login(T.emails.faculty);
  sessions.student = await login(T.emails.studentOne);
  sessions.foreignAdmin = await login(OTHER.emails.admin);
}, 90_000);

afterAll(async () => {
  await app.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // events are append-only
    for (const t of [
      'student_program_events',
      'student_programs',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

// ---- request helpers ----------------------------------------------------------------------------------------------
interface Opts {
  key?: string | null;
  csrf?: string | null;
  ifMatch?: string | null;
}
const openBody = (s: Structure, extra: object = {}) => ({
  programId: s.program,
  cohortId: s.cohort,
  startDate: '2024-08-01',
  reason: 'Admitted to the program',
  ...extra,
});
const closeBody = (extra: object = {}) => ({
  outcome: 'COMPLETED',
  endDate: '2025-01-15',
  reason: 'Programme completed',
  ...extra,
});
function send(
  user: Actor | null,
  path: string,
  payload: unknown,
  o: Opts,
  header: Record<string, string>,
) {
  const csrf = o.csrf === undefined ? (user ? sessions[user].csrf : null) : o.csrf;
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as never,
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: { origin: APP_ORIGIN, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...header },
  });
}
const open = (user: Actor | null, student: string, payload: unknown, o: Opts = {}) => {
  const key = o.key === undefined ? randomUUID() : o.key;
  return send(
    user,
    `${BASE}/${student}/programs`,
    payload,
    o,
    key ? { 'idempotency-key': key } : {},
  );
};
const close = (user: Actor | null, student: string, pid: string, payload: unknown, o: Opts = {}) =>
  send(
    user,
    `${BASE}/${student}/programs/${pid}/close`,
    payload,
    o,
    o.ifMatch ? { 'if-match': o.ifMatch } : {},
  );

/** Opens through the route as the college admin and returns the enrolment id. */
async function opened(student: string, s = main): Promise<string> {
  const r = await open('admin', student, openBody(s));
  expect(r.statusCode).toBe(201);
  return r.json<{ data: { id: string } }>().data.id;
}
const rowOf = async (id: string) =>
  (
    await adminQuery<Record<string, unknown>>(
      `SELECT status, version, end_date::text AS end_date, campus_id, department_id, entry_type, previous_student_program_id
         FROM app.student_programs WHERE id = $1`,
      [id],
    )
  )[0];
const eventTypes = async (id: string) =>
  (
    await adminQuery<{ event_type: string }>(
      'SELECT event_type FROM app.student_program_events WHERE student_program_id = $1 ORDER BY occurred_at',
      [id],
    )
  ).map((e) => e.event_type);
const enrolments = (student: string) =>
  adminQuery('SELECT 1 FROM app.student_programs WHERE student_id = $1', [student]);
const errorCode = (r: { json: <X>() => X }) => r.json<{ error: { code: string } }>().error.code;

// ---- open ---------------------------------------------------------------------------------------------------------
describe('POST /api/v1/students/:id/programs', () => {
  it('201 with { success, data: { id } }; the enrolment is REGULAR with program-derived scope; no replay header on the first call', async () => {
    const student = await mkStudent();
    const r = await open('admin', student, openBody(main));
    expect(r.statusCode).toBe(201);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    const body = r.json<{ success: boolean; data: { id: string } }>();
    expect(body.success).toBe(true);
    expect(Object.keys(body.data)).toEqual(['id']);
    expect(await rowOf(body.data.id)).toMatchObject({
      status: 'ACTIVE',
      version: 1,
      entry_type: 'REGULAR',
      previous_student_program_id: null,
      campus_id: main.campus,
      department_id: main.dept,
    });
    expect(await eventTypes(body.data.id)).toEqual(['OPENED']);
  });

  it('a retry with the same key returns the original 201 with Idempotent-Replayed: true and writes nothing new', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    const first = await open('admin', student, openBody(main), { key });
    const second = await open('admin', student, openBody(main), { key });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await enrolments(student)).toHaveLength(1);
  });

  it('a missing key is 428, a malformed one 400, the same key with another body 422; nothing is written for the first two', async () => {
    const student = await mkStudent();
    const missing = await open('admin', student, openBody(main), { key: null });
    expect(missing.statusCode).toBe(428);
    expect(errorCode(missing)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await open('admin', student, openBody(main), { key: 'short' })).statusCode).toBe(400);
    expect(
      (await open('admin', student, openBody(main), { key: 'has space in it, 20+ chars' }))
        .statusCode,
    ).toBe(400);
    expect(await enrolments(student)).toHaveLength(0);

    const key = randomUUID();
    expect((await open('admin', student, openBody(main), { key })).statusCode).toBe(201);
    const reused = await open('admin', student, openBody(main, { startDate: '2024-08-02' }), {
      key,
    });
    expect(reused.statusCode).toBe(422);
    expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects malformed bodies and ids with 400 and writes nothing', async () => {
    const student = await mkStudent();
    const bad: unknown[] = [
      undefined,
      {},
      openBody(main, { programId: 'nope' }),
      openBody(main, { cohortId: 123 }),
      openBody(main, { startDate: '01/08/2024' }),
      openBody(main, { startDate: '2024-02-30' }), // matches the pattern, rejected by the service
      openBody(main, { reason: 'abc' }),
      openBody(main, { reason: 'x'.repeat(501) }),
      openBody(main, { reason: '   abc   ' }), // length ok for the schema, rejected after the service trims
    ];
    for (const payload of bad) {
      const r = await open('admin', student, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await open('admin', 'not-a-uuid', openBody(main))).statusCode).toBe(400);
    expect(await enrolments(student)).toHaveLength(0);
  });

  it('client-supplied scope or lifecycle fields are refused (400), never trusted: campus, department, organization, entry type, previous enrolment, status', async () => {
    const student = await mkStudent();
    const extras = [
      { campusId: otherCampus.campus },
      { departmentId: sibling.dept },
      { organizationId: OTHER.orgId },
      { entryType: 'LATERAL' },
      { previousStudentProgramId: uuidv7() },
      { status: 'COMPLETED' },
    ];
    for (const extra of extras) {
      const r = await open('admin', student, openBody(main, extra));
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await enrolments(student)).toHaveLength(0);
  });

  it('401 without a session; 403 without CSRF and for roles lacking the permission (student actor included)', async () => {
    const student = await mkStudent();
    expect((await open(null, student, openBody(main))).statusCode).toBe(401);
    expect((await open('admin', student, openBody(main), { csrf: null })).statusCode).toBe(403);
    for (const user of ['faculty', 'hod', 'student'] as const) {
      const r = await open(user, student, openBody(main));
      expect(r.statusCode, user).toBe(403);
    }
    expect(await enrolments(student)).toHaveLength(0);
  });

  it('404 hides out-of-scope, cross-tenant and unknown resources; service conflicts propagate as the documented 409/404 envelopes', async () => {
    const student = await mkStudent();
    // a campus admin of the main campus cannot place into another campus
    expect((await open('campusAdmin', student, openBody(otherCampus))).statusCode).toBe(404);
    // another tenant's admin sees this tenant's student and program as nonexistent
    expect((await open('foreignAdmin', student, openBody(main))).statusCode).toBe(404);
    // unknown student, unknown program, cohort of another program
    expect((await open('admin', uuidv7(), openBody(main))).statusCode).toBe(404);
    expect((await open('admin', student, openBody(main, { programId: uuidv7() }))).statusCode).toBe(
      404,
    );
    expect(
      (await open('admin', student, openBody(main, { cohortId: sibling.cohort }))).statusCode,
    ).toBe(404);
    // an ineligible student: generic 409, and the envelope carries no SQL or student detail
    const suspended = await mkStudent('SUSPENDED');
    const r = await open('admin', suspended, openBody(main));
    expect(r.statusCode).toBe(409);
    const text = r.body;
    expect(r.json<{ error: { message: string } }>().error.message).toBe(
      'The student cannot be enrolled in a program.',
    );
    expect(text).not.toMatch(/SUSPENDED|constraint|SELECT|INSERT|stack|student_programs/i);
    expect(await enrolments(student)).toHaveLength(0);
    // a second ACTIVE enrolment is 409
    await opened(student);
    expect((await open('admin', student, openBody(sibling))).statusCode).toBe(409);
  });
});

// ---- close --------------------------------------------------------------------------------------------------------
describe('POST /api/v1/students/:id/programs/:pid/close', () => {
  it.each(['COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED'] as const)(
    '200 as %s with the DTO, ETag "2", and one CLOSED event; the quoted If-Match "1" is accepted',
    async (outcome) => {
      const student = await mkStudent();
      const pid = await opened(student);
      const r = await close('admin', student, pid, closeBody({ outcome }), { ifMatch: '"1"' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['etag']).toBe('"2"');
      const body = r.json<{ success: boolean; data: Record<string, unknown> }>();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        id: pid,
        studentId: student,
        status: outcome,
        endDate: '2025-01-15',
        version: 2,
        entryType: 'REGULAR',
        campusId: main.campus,
        departmentId: main.dept,
      });
      expect(await eventTypes(pid)).toEqual(['OPENED', 'CLOSED']);
    },
  );

  it('If-Match: missing is 428; weak, garbage and empty-ish values are 428/400; stale and "0" are 409; unquoted works', async () => {
    const student = await mkStudent();
    const pid = await opened(student);
    expect((await close('admin', student, pid, closeBody())).statusCode).toBe(428);
    for (const bad of ['W/"1"', 'abc', '"abc"', '-1', '1.5']) {
      const r = await close('admin', student, pid, closeBody(), { ifMatch: bad });
      expect(r.statusCode, bad).toBe(400);
    }
    for (const stale of ['"2"', '99', '0', 'null']) {
      const r = await close('admin', student, pid, closeBody(), { ifMatch: stale });
      expect(r.statusCode, stale).toBe(409);
    }
    expect(await rowOf(pid)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect((await close('admin', student, pid, closeBody(), { ifMatch: '1' })).statusCode).toBe(
      200,
    );
  });

  it('closing twice is 409 (retry after success), with the current or the old version', async () => {
    const student = await mkStudent();
    const pid = await opened(student);
    await close('admin', student, pid, closeBody(), { ifMatch: '"1"' });
    for (const v of ['"1"', '"2"', '*']) {
      const r = await close('admin', student, pid, closeBody(), { ifMatch: v });
      expect(r.statusCode, v).toBe(409);
    }
    expect(await eventTypes(pid)).toEqual(['OPENED', 'CLOSED']);
  });

  it('rejects an unsupported outcome, bad dates, a bad reason, extra fields and bad ids with 400', async () => {
    const student = await mkStudent();
    const pid = await opened(student);
    const bad: unknown[] = [
      undefined,
      {},
      closeBody({ outcome: 'ACTIVE' }),
      closeBody({ outcome: 'ON_LEAVE' }),
      closeBody({ outcome: 'completed' }),
      closeBody({ endDate: '2025/01/15' }),
      closeBody({ endDate: '2025-02-30' }),
      closeBody({ endDate: '2024-07-31' }), // before the start date
      closeBody({ endDate: '2200-01-01' }), // future
      closeBody({ reason: 'abc' }),
      closeBody({ status: 'COMPLETED' }),
      closeBody({ campusId: otherCampus.campus }),
    ];
    for (const payload of bad) {
      const r = await close('admin', student, pid, payload, { ifMatch: '"1"' });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await close('admin', 'nope', pid, closeBody(), { ifMatch: '"1"' })).statusCode).toBe(
      400,
    );
    expect(
      (await close('admin', student, 'nope', closeBody(), { ifMatch: '"1"' })).statusCode,
    ).toBe(400);
    expect(await rowOf(pid)).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  it('401 / 403 first: no session, no CSRF, and roles without the permission never reach the version check', async () => {
    const student = await mkStudent();
    const pid = await opened(student);
    expect((await close(null, student, pid, closeBody(), { ifMatch: '"1"' })).statusCode).toBe(401);
    expect(
      (await close('admin', student, pid, closeBody(), { ifMatch: '"1"', csrf: null })).statusCode,
    ).toBe(403);
    for (const user of ['faculty', 'hod', 'student'] as const) {
      const r = await close(user, student, pid, closeBody(), { ifMatch: '"99"' });
      expect(r.statusCode, user).toBe(403);
    }
    expect(await rowOf(pid)).toMatchObject({ status: 'ACTIVE', version: 1 });
  });

  it('404 hides out-of-scope, cross-tenant, unknown and wrong-student enrolments (even with a wrong version)', async () => {
    const student = await mkStudent();
    const elsewhere = await mkStudent();
    const pid = await opened(student, otherCampus);
    const h = { ifMatch: '"99"' }; // a wrong version must not be revealed before the 404
    expect((await close('campusAdmin', student, pid, closeBody(), h)).statusCode).toBe(404);
    expect((await close('foreignAdmin', student, pid, closeBody(), h)).statusCode).toBe(404);
    expect((await close('admin', student, uuidv7(), closeBody(), h)).statusCode).toBe(404);
    // the enrolment exists, but belongs to another student than the one named in the path
    expect((await close('admin', elsewhere, pid, closeBody(), h)).statusCode).toBe(404);
    expect((await close('admin', uuidv7(), pid, closeBody(), h)).statusCode).toBe(404);
    expect(await rowOf(pid)).toMatchObject({ status: 'ACTIVE', version: 1 });
    // and the right student with the right version works
    expect((await close('admin', student, pid, closeBody(), { ifMatch: '"1"' })).statusCode).toBe(
      200,
    );
  });
});
