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

// GET /api/v1/students?admissionNumber= over HTTP: exact lookup of at most one student, with the approved scope contract
// (docs/architecture/v3/21-students.md §0b). Private tenants only; every assertion is about rows created here.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 6 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Actor =
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'registrarOrg'
  | 'registrarCampus'
  | 'faculty'
  | 'student'
  | 'foreignAdmin';
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

interface Place {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Place; // the tenant's campus + department (HOD / campus holders' scope)
let sibling!: Place; // same campus, another department
let elsewhere!: Place; // another campus
let PERIOD: string;

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
async function mkPlace(tenant: IsolatedTenant, campus: string, dept?: string): Promise<Place> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Dir dept', $4)`,
      [d, tenant.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Dir program', $5, 'UG', 8)`,
    [program, tenant.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Dir cohort')`,
    [cohort, tenant.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
async function mkStudent(
  tenant: IsolatedTenant,
  admissionNumber: string,
  displayName = 'Directory Student',
  status = 'ACTIVE',
): Promise<string> {
  const user = uuidv7();
  const email = `dir-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [user, tenant.orgId, email, displayName],
  );
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', $5)`,
    [id, tenant.orgId, user, admissionNumber, status],
  );
  return id;
}
async function enrol(student: string, p: Place, status = 'ACTIVE'): Promise<void> {
  await adminQuery(
    `INSERT INTO app.student_programs
       (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, end_date, status, exit_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01', $8, $9, $10)`,
    [
      uuidv7(),
      T.orgId,
      student,
      p.program,
      p.cohort,
      p.campus,
      p.dept,
      status === 'ACTIVE' ? null : '2025-01-15',
      status,
      status === 'ACTIVE' ? null : 'Closed by the directory test',
    ],
  );
}
const num = (tag: string): string => `${tag}${RUN}${seq++}`;

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
  main = await mkPlace(T, T.campusId, T.departmentId);
  sibling = await mkPlace(T, T.campusId);
  const campus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Other campus', $3, 'Asia/Kolkata')`,
    [campus, T.orgId, code('C')],
  );
  elsewhere = await mkPlace(T, campus);
  sessions.admin = await login(T.emails.admin);
  sessions.campusAdmin = await login(T.emails.campusAdmin);
  sessions.hod = await login(T.emails.hod);
  sessions.registrarOrg = await login(T.emails.registrarOrg);
  sessions.registrarCampus = await login(T.emails.registrarCampus);
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
    await c.query('SET LOCAL session_replication_role = replica');
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
  await adminQuery('DELETE FROM app.students WHERE organization_id = ANY($1::uuid[])', [
    [T.orgId, OTHER.orgId],
  ]);
  await T.cleanup();
  await OTHER.cleanup();
});

const lookup = (user: Actor | null, query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/students${query}`,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
const find = (user: Actor | null, admissionNumber: string) =>
  lookup(user, `?admissionNumber=${encodeURIComponent(admissionNumber)}`);
type Entry = Record<string, unknown>;
const entryOf = (r: { json: <X>() => X }) => r.json<{ success: boolean; data: Entry }>().data;
const errOf = (r: { json: <X>() => X }) =>
  r.json<{ error: { code: string; message: string } }>().error;

describe('the response contract', () => {
  it('200 { success, data } with exactly the five reviewed fields, and no-store caching', async () => {
    const n = num('RC');
    const id = await mkStudent(T, n, 'Asha Verma', 'ADMITTED');
    const r = await find('admin', n);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json<{ success: boolean }>().success).toBe(true);
    expect(entryOf(r)).toEqual({
      id,
      admissionNumber: n,
      displayName: 'Asha Verma',
      status: 'ADMITTED',
      hasActiveEnrolment: false,
    });
  });

  it('never carries admission date, account, e-mail, guardians, placement, history or reasons, even for a placed student', async () => {
    const n = num('PV');
    const id = await mkStudent(T, n);
    await enrol(id, main);
    await enrol(id, elsewhere, 'COMPLETED'); // closed history in another campus, with an exit reason
    const r = await find('admin', n);
    expect(r.statusCode).toBe(200);
    expect(Object.keys(entryOf(r)).sort()).toEqual([
      'admissionNumber',
      'displayName',
      'hasActiveEnrolment',
      'id',
      'status',
    ]);
    for (const leak of [
      'admissionDate',
      'admission_date',
      'userId',
      'email',
      'guardian',
      'campus',
      'department',
      'program',
      'cohort',
      'exit',
      'reason',
      'Closed by the directory test',
      '2024-07-01',
    ]) {
      expect(r.body, leak).not.toContain(leak);
    }
  });
});

describe('who finds whom', () => {
  it('an UNPLACED student (never enrolled) is found by every holder, whatever their scope, with hasActiveEnrolment false', async () => {
    const n = num('UN');
    await mkStudent(T, n);
    for (const user of [
      'admin',
      'registrarOrg',
      'campusAdmin',
      'hod',
      'registrarCampus',
    ] as const) {
      const r = await find(user, n);
      expect(r.statusCode, user).toBe(200);
      expect(entryOf(r)['hasActiveEnrolment'], user).toBe(false);
    }
  });

  it('"unplaced" means NO ACTIVE enrolment: a student whose enrolments are all closed is found exactly like one who never enrolled', async () => {
    const closed = num('CL');
    const never = num('NV');
    const closedId = await mkStudent(T, closed);
    await mkStudent(T, never);
    await enrol(closedId, elsewhere, 'TRANSFERRED_OUT');
    for (const user of ['hod', 'campusAdmin'] as const) {
      const a = await find(user, closed);
      const b = await find(user, never);
      expect(a.statusCode, user).toBe(200);
      expect(entryOf(a)['hasActiveEnrolment']).toBe(false);
      expect(Object.keys(entryOf(a))).toEqual(Object.keys(entryOf(b))); // nothing distinguishes the history
    }
  });

  it('a PLACED student is found only inside the caller scope; true for in-scope holders, 404 outside', async () => {
    const inMain = num('IM');
    const inSibling = num('IS');
    const inElsewhere = num('IE');
    await enrol(await mkStudent(T, inMain), main);
    await enrol(await mkStudent(T, inSibling), sibling);
    await enrol(await mkStudent(T, inElsewhere), elsewhere);

    // organization-wide holders see all placed students
    for (const user of ['admin', 'registrarOrg'] as const) {
      for (const n of [inMain, inSibling, inElsewhere]) {
        const r = await find(user, n);
        expect(r.statusCode, `${user} ${n}`).toBe(200);
        expect(entryOf(r)['hasActiveEnrolment']).toBe(true);
      }
    }
    // HOD: department only
    expect((await find('hod', inMain)).statusCode).toBe(200);
    expect(entryOf(await find('hod', inMain))['hasActiveEnrolment']).toBe(true);
    expect((await find('hod', inSibling)).statusCode).toBe(404);
    expect((await find('hod', inElsewhere)).statusCode).toBe(404);
    // campus holders: the whole campus, not the other campus
    for (const user of ['campusAdmin', 'registrarCampus'] as const) {
      expect((await find(user, inMain)).statusCode, user).toBe(200);
      expect((await find(user, inSibling)).statusCode, user).toBe(200);
      expect((await find(user, inElsewhere)).statusCode, user).toBe(404);
    }
  });

  it('hidden and nonexistent are indistinguishable: same status, code and message', async () => {
    const hidden = num('HD');
    await enrol(await mkStudent(T, hidden), elsewhere);
    const a = await find('campusAdmin', hidden);
    const b = await find('campusAdmin', num('NX'));
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(errOf(a).code).toBe(errOf(b).code);
    expect(errOf(a).message).toBe(errOf(b).message);
  });

  it('when a student becomes placed outside the scope it disappears for scoped holders; when the enrolment closes it reappears', async () => {
    const n = num('MV');
    const id = await mkStudent(T, n);
    expect((await find('hod', n)).statusCode).toBe(200);
    await enrol(id, elsewhere);
    expect((await find('hod', n)).statusCode).toBe(404);
    await adminQuery(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-01-15', exit_reason = 'Closed by the directory test'
        WHERE student_id = $1 AND status = 'ACTIVE'`,
      [id],
    );
    expect((await find('hod', n)).statusCode).toBe(200);
  });

  it('finding a student confers no enrolment right: a campus admin who found an unplaced student still gets 404 enrolling into another campus', async () => {
    const n = num('NE');
    const id = await mkStudent(T, n);
    expect((await find('campusAdmin', n)).statusCode).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${id}/programs`,
      payload: {
        programId: elsewhere.program,
        cohortId: elsewhere.cohort,
        startDate: '2024-08-01',
        reason: 'Admitted to the program',
      },
      cookies: { session_token: sessions.campusAdmin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': sessions.campusAdmin.csrf,
        'idempotency-key': randomUUID(),
      },
    });
    expect(r.statusCode).toBe(404);
  });

  it('the match is exact and case-sensitive', async () => {
    const n = num('Ab');
    await mkStudent(T, n);
    expect((await find('admin', n.toLowerCase())).statusCode).toBe(404);
    expect((await find('admin', n.slice(0, -1))).statusCode).toBe(404);
    expect((await find('admin', `${n}x`)).statusCode).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("another tenant's admin cannot see this tenant's students, placed or not; each tenant resolves its own number", async () => {
    const shared = num('TI');
    const mine = await mkStudent(T, shared, 'Tenant T student');
    const theirs = await mkStudent(OTHER, shared, 'Other tenant student');
    expect((await find('admin', shared)).json<{ data: { id: string } }>().data.id).toBe(mine);
    expect((await find('foreignAdmin', shared)).json<{ data: { id: string } }>().data.id).toBe(
      theirs,
    );
    const onlyMine = num('TJ');
    await mkStudent(T, onlyMine);
    expect((await find('foreignAdmin', onlyMine)).statusCode).toBe(404);
  });
});

describe('permission and authentication', () => {
  it('401 without a session; 403 for faculty and for a student actor', async () => {
    const n = num('PM');
    await mkStudent(T, n);
    expect((await find(null, n)).statusCode).toBe(401);
    expect((await find('faculty', n)).statusCode).toBe(403);
    expect((await find('student', n)).statusCode).toBe(403);
  });
});

describe('strict query validation', () => {
  it('rejects a missing, empty, malformed or oversized admissionNumber with 400', async () => {
    for (const q of [
      '',
      '?admissionNumber=',
      '?admissionNumber=%20abc',
      '?admissionNumber=abc%20',
      '?admissionNumber=a%20b',
      '?admissionNumber=-abc',
      '?admissionNumber=a%2Fb',
      '?admissionNumber=%27%20OR%201%3D1--',
      `?admissionNumber=${'A'.repeat(51)}`,
    ]) {
      expect((await lookup('admin', q)).statusCode, q).toBe(400);
    }
  });

  it('rejects unknown parameters (name, limit, offset, cursor, tenant and scope fields) and repeated parameters with 400', async () => {
    const n = num('QV');
    await mkStudent(T, n);
    for (const extra of [
      'name=Asha',
      'limit=5',
      'offset=0',
      'cursor=abc',
      `organizationId=${T.orgId}`,
      `campusId=${T.campusId}`,
      `departmentId=${T.departmentId}`,
      'status=ACTIVE',
      'q=Asha',
    ]) {
      const r = await lookup('admin', `?admissionNumber=${n}&${extra}`);
      expect(r.statusCode, extra).toBe(400);
    }
    expect((await lookup('admin', `?admissionNumber=${n}&admissionNumber=${n}`)).statusCode).toBe(
      400,
    );
    // and the valid form still works
    expect((await lookup('admin', `?admissionNumber=${n}`)).statusCode).toBe(200);
  });

  it('there is no listing or name search: a name is not an admission number', async () => {
    await mkStudent(T, num('NS'), 'Zoe Searchable');
    expect((await find('admin', 'Zoe Searchable')).statusCode).toBe(400);
    expect((await find('admin', 'Zoe')).statusCode).toBe(404);
  });
});
