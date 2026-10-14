import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CohortService, ProgramService } from '../../src/modules/academics/academic.service.js';
import { CampusService } from '../../src/modules/organization/campus.service.js';
import { DepartmentService } from '../../src/modules/organization/department.service.js';
import {
  StudentProgramService,
  type CloseOutcome,
} from '../../src/modules/students/student-program.service.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import type { ExpectedVersion } from '../../src/shared/settings/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { STUDENT_A } from '../support/fixtures.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// StudentProgramService.open / close against the shared disposable integration database. Everything commits, so it runs
// in a private tenant; every assertion looks at rows these tests created (by id), never at tenant-wide counts.

const RUN = randomBytes(3).toString('hex');
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 10 });
const db = new Database(pool);
const WAITER_APP = `it-sprog-waiter-${RUN}`;
const waiterDb = new Database(
  createPool({
    connectionString: inject('dbRuntimeUrl'),
    ssl: false,
    max: 6,
    applicationName: WAITER_APP,
  }),
);

let T!: IsolatedTenant;
let PERIOD: string;
const ctxFor = (user: string): TrustedContext =>
  issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STAFF' });
let adminCtx!: TrustedContext;
const extraUsers: Record<string, string> = {};
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

interface Structure {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Structure; // the tenant's campus and main department
let sibling!: Structure; // same campus, ANOTHER department
let other!: Structure; // ANOTHER campus

async function mkCampus(tz = 'Asia/Kolkata'): Promise<string> {
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Test campus', $3, $4)`,
    [id, T.orgId, code('C'), tz],
  );
  return id;
}
async function mkStructure(campus: string, dept?: string): Promise<Structure> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Test dept', $4)`,
      [d, T.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Test program', $5, 'UG', 8)`,
    [program, T.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Test cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
async function mkUser(role?: { code: string; scope: 'CAMPUS' | 'DEPARTMENT'; id: string }) {
  const id = uuidv7();
  const email = `sp-${RUN}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [id, T.orgId, email],
  );
  if (role) {
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
              CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [uuidv7(), T.orgId, id, role.code, role.scope, role.id],
    );
  }
  return id;
}
let admissionSeq = 0;
async function mkStudent(status = 'ACTIVE', admission = '2024-07-01'): Promise<string> {
  const user = await mkUser();
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, T.orgId, user, `SP${RUN}${admissionSeq++}`, admission, status],
  );
  return id;
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  adminCtx = ctxFor(T.users.admin);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkStructure(T.campusId, T.departmentId);
  sibling = await mkStructure(T.campusId);
  other = await mkStructure(await mkCampus());
  extraUsers.deptAdmin = await mkUser({
    code: 'DEPARTMENT_ADMIN',
    scope: 'DEPARTMENT',
    id: T.departmentId,
  });
}, 60_000);

afterAll(async () => {
  await db.close();
  await waiterDb.close();
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
});

// ---- helpers ---------------------------------------------------------------------------------------------------
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = $2
          AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like, WAITER_APP],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}
const outcome = (p: Promise<unknown>): Promise<number> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : -1),
  );

const base = (s: Structure, over: object = {}) => ({
  programId: s.program,
  cohortId: s.cohort,
  startDate: '2024-08-01',
  reason: 'Admitted to the program',
  ...over,
});
type OpenOver = Partial<{ programId: string; cohortId: string; startDate: string; reason: string }>;
const openAs = (
  runner: Database,
  ctx: TrustedContext,
  student: string,
  s: Structure,
  over: OpenOver = {},
  opts: { key?: unknown; meta?: { requestId?: string } } = {},
) =>
  runner.withTenant(ctx, (tx) =>
    StudentProgramService.open(tx, ctx, student, base(s, over), {
      idempotencyKey: 'key' in opts ? opts.key : randomUUID(),
      ...(opts.meta ? { meta: opts.meta } : {}),
    }),
  );
const open = (student: string, s: Structure, over: OpenOver = {}, opts = {}) =>
  openAs(db, adminCtx, student, s, over, opts);
const idOf = (r: { body: Record<string, unknown> }): string =>
  (r.body['data'] as { id: string }).id;

const closeAs = (
  runner: Database,
  ctx: TrustedContext,
  id: string,
  over: Partial<{ outcome: unknown; endDate: string; reason: string }> = {},
  expected: ExpectedVersion = { type: 'version', version: 1 },
  meta?: { requestId?: string },
) =>
  runner.withTenant(ctx, (tx) =>
    StudentProgramService.close(
      tx,
      ctx,
      id,
      {
        outcome: 'COMPLETED' as CloseOutcome,
        endDate: '2025-01-15',
        reason: 'Programme completed',
        ...over,
      } as never,
      { expected, ...(meta ? { meta } : {}) },
    ),
  );
const close = (id: string, over = {}, expected?: ExpectedVersion) =>
  closeAs(db, adminCtx, id, over, expected);

const row = async (id: string) =>
  (
    await adminQuery<Record<string, unknown>>(
      `SELECT status, version, start_date::text AS start_date, end_date::text AS end_date, exit_reason, entry_type,
              previous_student_program_id, campus_id, department_id, program_id, cohort_id, student_id
         FROM app.student_programs WHERE id = $1`,
      [id],
    )
  )[0];
const events = (id: string) =>
  adminQuery<Record<string, unknown>>(
    `SELECT event_type, from_status, to_status, effective_date::text AS effective_date, reason, actor_user_id, student_id
       FROM app.student_program_events WHERE student_program_id = $1 ORDER BY occurred_at`,
    [id],
  );
const audits = (id: string) =>
  adminQuery<Record<string, unknown>>(
    `SELECT action, resource_type, subject_student_id, campus_id, department_id, risk_tier, reason_text, changes, actor_user_id
       FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at`,
    [T.orgId, id],
  );
const studentStatus = async (id: string) =>
  (await adminQuery<{ status: string }>('SELECT status FROM app.students WHERE id = $1', [id]))[0]
    ?.status;
const enrolmentsOf = (student: string) =>
  adminQuery<{ id: string; status: string }>(
    'SELECT id, status FROM app.student_programs WHERE student_id = $1',
    [student],
  );
const claim = (key: string) =>
  adminQuery('SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2', [
    T.orgId,
    key,
  ]);
const reject = (p: Promise<unknown>, status: number, code?: string) =>
  expect(p).rejects.toMatchObject({ statusCode: status, ...(code ? { code } : {}) });

// ---- open ---------------------------------------------------------------------------------------------------------
describe('open: success, persistence and idempotency', () => {
  it('opens a REGULAR enrolment with the program-derived scope, its OPENED event and one audit record; students.status is untouched', async () => {
    const student = await mkStudent('ADMITTED');
    const r = await open(student, main);
    expect(r.status).toBe(201);
    expect(r.replayed).toBe(false);
    const id = idOf(r);

    expect(await row(id)).toMatchObject({
      status: 'ACTIVE',
      version: 1,
      start_date: '2024-08-01',
      end_date: null,
      exit_reason: null,
      entry_type: 'REGULAR',
      previous_student_program_id: null,
      campus_id: main.campus,
      department_id: main.dept,
      program_id: main.program,
      cohort_id: main.cohort,
      student_id: student,
    });
    expect(await events(id)).toEqual([
      {
        event_type: 'OPENED',
        from_status: null,
        to_status: 'ACTIVE',
        effective_date: '2024-08-01',
        reason: 'Admitted to the program',
        actor_user_id: T.users.admin,
        student_id: student,
      },
    ]);
    const a = await audits(id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: 'student_program.open',
      resource_type: 'student_program',
      subject_student_id: student,
      campus_id: main.campus,
      department_id: main.dept,
      risk_tier: 2,
      reason_text: 'Admitted to the program',
      actor_user_id: T.users.admin,
    });
    expect(await studentStatus(student)).toBe('ADMITTED');
  });

  it('an ACTIVE student is enrollable too, and the reason is trimmed before it is stored', async () => {
    const student = await mkStudent('ACTIVE');
    const id = idOf(await open(student, main, { reason: '   Admitted after review   ' }));
    expect((await events(id))[0]?.['reason']).toBe('Admitted after review');
  });

  it('replays the original response for the same key and request: no second enrolment, event or audit record', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    const first = await open(student, main, {}, { key });
    const second = await open(student, main, {}, { key });
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const id = idOf(first);
    expect(await enrolmentsOf(student)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
    expect(await audits(id)).toHaveLength(1);
  });

  it('the same key with a different request is 422 (different date, different student), and nothing new is written', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    await open(student, main, {}, { key });
    await reject(
      open(student, main, { startDate: '2024-08-02' }, { key }),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await reject(open(await mkStudent(), main, {}, { key }), 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await enrolmentsOf(student)).toHaveLength(1);
  });

  it('a missing key is 428, a malformed one 400, and neither writes anything', async () => {
    const student = await mkStudent();
    await reject(open(student, main, {}, { key: undefined }), 428);
    await reject(open(student, main, {}, { key: 'short' }), 400);
    await reject(open(student, main, {}, { key: ['a'.repeat(20), 'b'.repeat(20)] }), 400);
    expect(await enrolmentsOf(student)).toHaveLength(0);
  });

  it('a failed request is not cached: the same key succeeds once the cause is gone', async () => {
    const student = await mkStudent('SUSPENDED');
    const key = randomUUID();
    await reject(open(student, main, {}, { key }), 409);
    expect(await claim(key)).toHaveLength(0);
    await adminQuery(`UPDATE app.students SET status = 'ACTIVE' WHERE id = $1`, [student]);
    const r = await open(student, main, {}, { key });
    expect(r.status).toBe(201);
    expect(r.replayed).toBe(false);
  });
});

describe('open: request shape', () => {
  it('rejects malformed ids, dates and reasons with 400 before anything is read', async () => {
    const student = await mkStudent();
    await reject(open('not-a-uuid', main), 400);
    await reject(open(student, main, { programId: 'x' }), 400);
    await reject(open(student, main, { cohortId: 'x' }), 400);
    for (const startDate of ['2024-13-01', '2024-02-30', '01/08/2024', '1899-12-31']) {
      await reject(open(student, main, { startDate }), 400);
    }
    for (const reason of ['abc', ' abcd ', 'x'.repeat(501)]) {
      await reject(open(student, main, { reason }), 400);
    }
    expect(await enrolmentsOf(student)).toHaveLength(0);
  });
});

describe('open: authorization and scope', () => {
  it('roles without the permission get 403 before any resource-specific answer, even for a student who is already enrolled', async () => {
    const student = await mkStudent();
    await open(student, main);
    for (const user of [T.users.faculty, T.users.hod, T.users.studentOne]) {
      await reject(openAs(db, ctxFor(user), student, main), 403);
    }
  });

  it('holders whose scope contains the target program may open; the same holders are 404 for a program outside it', async () => {
    const inScope: [string, string][] = [
      ['college admin (organization)', T.users.admin],
      ['registrar (organization)', T.users.registrarOrg],
      ['campus admin of the campus', T.users.campusAdmin],
      ['registrar of the campus', T.users.registrarCampus],
      ['department admin of the department', extraUsers.deptAdmin!],
    ];
    for (const [label, user] of inScope) {
      const r = await openAs(db, ctxFor(user), await mkStudent(), main);
      expect(r.status, label).toBe(201);
    }
    // out of scope: another campus (campus holders), another department of the same campus (department admin)
    for (const user of [T.users.campusAdmin, T.users.registrarCampus]) {
      await reject(openAs(db, ctxFor(user), await mkStudent(), other), 404);
    }
    await reject(openAs(db, ctxFor(extraUsers.deptAdmin!), await mkStudent(), sibling), 404);
  });

  it('a student placed where the caller cannot see is 404 (not a conflict); where the caller can see it is 409', async () => {
    const student = await mkStudent();
    await open(student, other); // active in ANOTHER campus
    await reject(openAs(db, ctxFor(T.users.campusAdmin), student, main), 404);
    await reject(open(student, main), 409); // organization-wide admin sees the placement
  });

  it('a missing program, a program of another tenant, and an unknown student are all 404', async () => {
    const student = await mkStudent();
    await reject(open(student, main, { programId: uuidv7() }), 404);
    await reject(open(uuidv7(), main), 404);
    await reject(open(STUDENT_A, main), 404); // a tenant A student, seen from this tenant
  });
});

describe('open: structure state and relations', () => {
  it('an inactive campus, an inactive or soft-deleted department and an inactive program are 404; nothing is written', async () => {
    const student = await mkStudent();
    const cases: [string, () => Promise<Structure>, string][] = [
      [
        'campus INACTIVE',
        async () => {
          const s = await mkStructure(await mkCampus());
          await adminQuery(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [
            s.dept,
          ]);
          await adminQuery(`UPDATE app.campuses SET status = 'INACTIVE' WHERE id = $1`, [s.campus]);
          return s;
        },
        '',
      ],
      [
        'department INACTIVE',
        async () => {
          const s = await mkStructure(T.campusId);
          await adminQuery(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [
            s.dept,
          ]);
          return s;
        },
        '',
      ],
      [
        'department soft-deleted',
        async () => {
          const s = await mkStructure(T.campusId);
          await adminQuery(
            `UPDATE app.departments SET status = 'INACTIVE', deleted_at = now() WHERE id = $1`,
            [s.dept],
          );
          return s;
        },
        '',
      ],
      [
        'program INACTIVE',
        async () => {
          const s = await mkStructure(T.campusId);
          await adminQuery(`UPDATE app.cohorts SET status = 'CLOSED' WHERE id = $1`, [s.cohort]);
          await adminQuery(`UPDATE app.programs SET status = 'INACTIVE' WHERE id = $1`, [
            s.program,
          ]);
          return s;
        },
        '',
      ],
    ];
    for (const [label, make] of cases) {
      await reject(open(student, await make()), 404, 'RESOURCE_NOT_FOUND');
      expect(await enrolmentsOf(student), label).toHaveLength(0);
    }
  });

  it('a cohort of another program is 404; a cohort that is no longer ACTIVE is 409', async () => {
    const student = await mkStudent();
    await reject(open(student, main, { cohortId: sibling.cohort }), 404);
    const s = await mkStructure(T.campusId);
    await adminQuery(`UPDATE app.cohorts SET status = 'GRADUATED' WHERE id = $1`, [s.cohort]);
    await reject(open(student, s), 409);
    expect(await enrolmentsOf(student)).toHaveLength(0);
  });
});

describe('open: student rules and dates', () => {
  it('only ADMITTED and ACTIVE students are enrollable', async () => {
    for (const status of [
      'SUSPENDED',
      'ON_LEAVE',
      'DISCONTINUED',
      'GRADUATED',
      'TRANSFERRED_OUT',
    ]) {
      const student = await mkStudent(status);
      // the body never names the student's status, and is identical for every ineligible status
      const err: unknown = await open(student, main).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 409 });
      expect((err as Error).message).toBe('The student cannot be enrolled in a program.');
      expect(await enrolmentsOf(student), status).toHaveLength(0);
    }
  });

  it('start before the admission date is 400; the admission day itself and any later past day are fine', async () => {
    const student = await mkStudent('ACTIVE', '2024-07-01');
    const err: unknown = await open(student, main, { startDate: '2024-06-30' }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ statusCode: 400 });
    // the body does not disclose the admission date or that the comparison was with it
    expect((err as Error).message).toBe('startDate is not acceptable for this student.');
    expect((err as Error).message).not.toMatch(/2024|admission/i);
    expect((await open(student, main, { startDate: '2024-07-01' })).status).toBe(201);
  });

  it("start after the campus's local today is 400; today itself is fine; the campus time zone decides", async () => {
    const kiri = await mkStructure(await mkCampus('Pacific/Kiritimati')); // UTC+14
    const pago = await mkStructure(await mkCampus('Pacific/Pago_Pago')); // UTC-11
    const [tz] = await adminQuery<{ k: string; p: string }>(
      `SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS k, (now() AT TIME ZONE 'Pacific/Pago_Pago')::date::text AS p`,
    );
    const k = tz!.k;
    const p = tz!.p;
    expect(k > p).toBe(true); // 25 hours apart: the local dates always differ
    await reject(open(await mkStudent(), pago, { startDate: k }), 400);
    expect((await open(await mkStudent(), kiri, { startDate: k })).status).toBe(201);
    expect((await open(await mkStudent(), pago, { startDate: p })).status).toBe(201);
    await reject(open(await mkStudent(), kiri, { startDate: '2200-01-01' }), 400);
  });

  it('a student who already has an ACTIVE enrolment is 409; after it is closed a new one can be opened', async () => {
    const student = await mkStudent();
    const first = idOf(await open(student, main));
    await reject(open(student, sibling), 409);
    await reject(open(student, main), 409);
    await close(first);
    expect((await open(student, sibling, { startDate: '2025-02-01' })).status).toBe(201);
    expect((await enrolmentsOf(student)).filter((e) => e.status === 'ACTIVE')).toHaveLength(1);
  });
});

describe('open: atomicity', () => {
  it('a failing audit write (after the enrolment and event were written) rolls everything back, including the idempotency claim', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    await reject(
      open(student, main, {}, { key, meta: { requestId: 'not-a-uuid' } }),
      500,
      'AUDIT_INVALID',
    );
    expect(await enrolmentsOf(student)).toHaveLength(0);
    expect(
      await adminQuery('SELECT 1 FROM app.student_program_events WHERE student_id = $1', [student]),
    ).toHaveLength(0);
    expect(await claim(key)).toHaveLength(0);
    // and the same key then works
    expect((await open(student, main, {}, { key })).status).toBe(201);
  });
});

// ---- close --------------------------------------------------------------------------------------------------------
describe('close: outcomes and persistence', () => {
  it.each(['COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED'] as const)(
    'closes as %s: version bumped, scope frozen, exactly one CLOSED event and one audit record, students.status untouched',
    async (outcomeValue) => {
      const student = await mkStudent('ACTIVE');
      const id = idOf(await open(student, main));
      const before = await row(id);
      const dto = await close(id, { outcome: outcomeValue, reason: `Closed as ${outcomeValue}` });
      expect(dto).toMatchObject({
        id,
        status: outcomeValue,
        endDate: '2025-01-15',
        exitReason: `Closed as ${outcomeValue}`,
        version: 2,
        campusId: main.campus,
        departmentId: main.dept,
        startDate: '2024-08-01',
      });
      expect(await row(id)).toMatchObject({
        status: outcomeValue,
        end_date: '2025-01-15',
        version: 2,
        campus_id: before?.['campus_id'],
        department_id: before?.['department_id'],
        program_id: before?.['program_id'],
        cohort_id: before?.['cohort_id'],
      });
      const ev = await events(id);
      expect(ev.map((e) => e['event_type'])).toEqual(['OPENED', 'CLOSED']);
      expect(ev[1]).toMatchObject({
        from_status: 'ACTIVE',
        to_status: outcomeValue,
        effective_date: '2025-01-15',
        reason: `Closed as ${outcomeValue}`,
        actor_user_id: T.users.admin,
      });
      const a = await audits(id);
      expect(a.map((x) => x['action'])).toEqual(['student_program.open', 'student_program.close']);
      expect(a[1]).toMatchObject({
        subject_student_id: student,
        campus_id: main.campus,
        department_id: main.dept,
        risk_tier: 2,
        reason_text: `Closed as ${outcomeValue}`,
      });
      expect(await studentStatus(student)).toBe('ACTIVE');
    },
  );

  it('the end date may equal the start date; "exists" and a matching version are accepted', async () => {
    const id = idOf(await open(await mkStudent(), main));
    expect((await close(id, { endDate: '2024-08-01' }, { type: 'exists' })).version).toBe(2);
  });
});

describe('close: authorization, scope and validation', () => {
  it('no permission is 403; out of scope and missing are 404; a malformed id is 400', async () => {
    const id = idOf(await open(await mkStudent(), other));
    await reject(closeAs(db, ctxFor(T.users.faculty), id), 403);
    await reject(closeAs(db, ctxFor(T.users.campusAdmin), id), 404);
    await reject(closeAs(db, ctxFor(extraUsers.deptAdmin!), id), 404);
    await reject(close(uuidv7()), 404);
    await reject(close('nope'), 400);
    expect((await row(id))?.['status']).toBe('ACTIVE');
    const mine = idOf(await open(await mkStudent(), main));
    expect((await closeAs(db, ctxFor(extraUsers.deptAdmin!), mine)).status).toBe('COMPLETED');
  });

  it('403 comes before any version or state detail', async () => {
    const id = idOf(await open(await mkStudent(), main));
    await close(id);
    await reject(
      closeAs(db, ctxFor(T.users.faculty), id, {}, { type: 'version', version: 99 }),
      403,
    );
  });

  it('an unsupported outcome, a malformed date and a bad reason are 400', async () => {
    const id = idOf(await open(await mkStudent(), main));
    for (const o of ['ACTIVE', 'ON_LEAVE', 'completed', '', undefined, 7]) {
      await reject(close(id, { outcome: o }), 400);
    }
    await reject(close(id, { endDate: '2025-02-30' }), 400);
    await reject(close(id, { reason: 'abc' }), 400);
    expect((await row(id))?.['status']).toBe('ACTIVE');
  });

  it('an end date before the start date, or after the campus-local today, is 400', async () => {
    const id = idOf(await open(await mkStudent(), main));
    await reject(close(id, { endDate: '2024-07-31' }), 400);
    await reject(close(id, { endDate: '2200-01-01' }), 400);
    const kiri = await mkStructure(await mkCampus('Pacific/Kiritimati'));
    const pago = await mkStructure(await mkCampus('Pacific/Pago_Pago'));
    const [tzk] = await adminQuery<{ k: string }>(
      `SELECT (now() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS k`,
    );
    const k = tzk!.k;
    const inPago = idOf(await open(await mkStudent(), pago));
    await reject(close(inPago, { endDate: k }), 400); // tomorrow, locally
    const inKiri = idOf(await open(await mkStudent(), kiri));
    expect((await close(inKiri, { endDate: k })).status).toBe('COMPLETED');
  });
});

describe('close: version and lifecycle conflicts', () => {
  it('a stale or "initial" expected version is 409 and changes nothing', async () => {
    const id = idOf(await open(await mkStudent(), main));
    await reject(close(id, {}, { type: 'version', version: 2 }), 409);
    await reject(close(id, {}, { type: 'initial' }), 409);
    expect(await row(id)).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(await events(id)).toHaveLength(1);
  });

  it('closing twice is 409 for every expected version, and writes no second event or audit record', async () => {
    const id = idOf(await open(await mkStudent(), main));
    await close(id);
    await reject(close(id, {}, { type: 'version', version: 2 }), 409);
    await reject(close(id, {}, { type: 'version', version: 1 }), 409);
    await reject(close(id, {}, { type: 'exists' }), 409);
    expect(await events(id)).toHaveLength(2);
    expect(await audits(id)).toHaveLength(2);
  });

  it('a failing audit write rolls the close back: enrolment still ACTIVE at version 1, no CLOSED event', async () => {
    const id = idOf(await open(await mkStudent(), main));
    await reject(
      closeAs(db, adminCtx, id, {}, { type: 'version', version: 1 }, { requestId: 'not-a-uuid' }),
      500,
      'AUDIT_INVALID',
    );
    expect(await row(id)).toMatchObject({ status: 'ACTIVE', version: 1, end_date: null });
    expect((await events(id)).map((e) => e['event_type'])).toEqual(['OPENED']);
    expect((await audits(id)).map((a) => a['action'])).toEqual(['student_program.open']);
    expect((await close(id)).status).toBe('COMPLETED');
  });
});

// ---- concurrency --------------------------------------------------------------------------------------------------
describe('concurrency', () => {
  /** Runs `holder` inside an open transaction and keeps it open until released. */
  async function holding<T2>(
    ctx: TrustedContext,
    holder: (tx: Parameters<Parameters<Database['withTenant']>[1]>[0]) => Promise<unknown>,
    during: () => Promise<T2>,
  ): Promise<T2> {
    const held = gate();
    const release = gate();
    const a = db.withTenant(ctx, async (tx) => {
      await holder(tx);
      held.open();
      await release.wait;
    });
    a.catch(() => held.open());
    await held.wait;
    try {
      return await during();
    } finally {
      release.open();
      await a.catch(() => undefined);
    }
  }

  it('two concurrent opens for one student: the second waits on the student lock and is refused (409); exactly one ACTIVE enrolment', async () => {
    const student = await mkStudent();
    let loser!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, student, base(main), {
          idempotencyKey: randomUUID(),
        }),
      async () => {
        loser = outcome(openAs(waiterDb, adminCtx, student, sibling));
        await waitUntilBlocked('%app.students%FOR NO KEY UPDATE%');
      },
    );
    expect(await loser).toBe(409);
    expect((await enrolmentsOf(student)).filter((e) => e.status === 'ACTIVE')).toHaveLength(1);
  });

  it('open while a close is uncommitted is 409 (the old enrolment is still ACTIVE); after the close commits the open succeeds', async () => {
    const student = await mkStudent();
    const first = idOf(await open(student, main));
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.close(
          tx,
          adminCtx,
          first,
          { outcome: 'COMPLETED', endDate: '2025-01-15', reason: 'Programme completed' },
          { expected: { type: 'version', version: 1 } },
        ),
      async () => {
        expect(await outcome(openAs(waiterDb, adminCtx, student, sibling))).toBe(409);
      },
    );
    expect((await open(student, sibling, { startDate: '2025-02-01' })).status).toBe(201);
  });

  it('two concurrent closes of one enrolment: the second waits on the row lock and is refused (409); one CLOSED event', async () => {
    const id = idOf(await open(await mkStudent(), main));
    let loser!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.close(
          tx,
          adminCtx,
          id,
          { outcome: 'DISCONTINUED', endDate: '2025-01-15', reason: 'Left the programme' },
          { expected: { type: 'version', version: 1 } },
        ),
      async () => {
        loser = outcome(closeAs(waiterDb, adminCtx, id));
        await waitUntilBlocked('%app.student_programs%FOR NO KEY UPDATE%');
      },
    );
    expect(await loser).toBe(409);
    expect((await events(id)).filter((e) => e['event_type'] === 'CLOSED')).toHaveLength(1);
    expect((await row(id))?.['status']).toBe('DISCONTINUED');
  });

  it('a department deactivation that starts while an enrolment is being opened waits, then is refused (409)', async () => {
    const s = await mkStructure(T.campusId);
    let deactivation!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, STUDENT_FOR(), base(s), {
          idempotencyKey: randomUUID(),
        }),
      async () => {
        deactivation = outcome(
          waiterDb.withTenant(adminCtx, (tx) =>
            DepartmentService.update(tx, adminCtx, s.dept, { status: 'INACTIVE' }),
          ),
        );
        await waitUntilBlocked('%app.departments%FOR NO KEY UPDATE%');
      },
    );
    expect(await deactivation).toBe(409);
    const [d] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.departments WHERE id = $1',
      [s.dept],
    );
    expect(d?.status).toBe('ACTIVE');
  });

  it('a department deactivation that commits first makes the waiting open 404 (nothing written)', async () => {
    const s = await mkStructure(T.campusId);
    const student = await mkStudent();
    let opening!: Promise<number>;
    await holding(
      adminCtx,
      (tx) => DepartmentService.update(tx, adminCtx, s.dept, { status: 'INACTIVE' }),
      async () => {
        opening = outcome(openAs(waiterDb, adminCtx, student, s));
        await waitUntilBlocked('%app.departments%FOR SHARE%');
      },
    );
    expect(await opening).toBe(404);
    expect(await enrolmentsOf(student)).toHaveLength(0);
  });

  it('a cohort closure that starts while an enrolment is being opened waits, then is refused (409)', async () => {
    const s = await mkStructure(T.campusId);
    let closing!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, STUDENT_FOR(), base(s), {
          idempotencyKey: randomUUID(),
        }),
      async () => {
        closing = outcome(
          waiterDb.withTenant(adminCtx, (tx) =>
            CohortService.update(tx, adminCtx, s.cohort, { status: 'CLOSED' }),
          ),
        );
        await waitUntilBlocked('%app.cohorts%FOR NO KEY UPDATE%');
      },
    );
    expect(await closing).toBe(409);
  });

  it('a cohort closure that commits first makes the waiting open 409 (the cohort is no longer open); nothing written', async () => {
    const s = await mkStructure(T.campusId);
    const student = await mkStudent();
    let opening!: Promise<number>;
    await holding(
      adminCtx,
      (tx) => CohortService.update(tx, adminCtx, s.cohort, { status: 'CLOSED' }),
      async () => {
        opening = outcome(openAs(waiterDb, adminCtx, student, s));
        await waitUntilBlocked('%app.cohorts%FOR SHARE%');
      },
    );
    expect(await opening).toBe(409);
    expect(await enrolmentsOf(student)).toHaveLength(0);
  });

  // ---- concurrent identical idempotency keys, and campus / program deactivation ------------------------------------
  const activeEnrolments = async (student: string) =>
    (await enrolmentsOf(student)).filter((e) => e.status === 'ACTIVE');
  const claimsOf = (key: string) =>
    adminQuery('SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2', [
      T.orgId,
      key,
    ]);

  it('two concurrent opens with the SAME key and request: the second waits on the key claim, then replays the first result; one enrolment, one claim', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    let second!: ReturnType<typeof openAs>;
    const first = await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, student, base(main), { idempotencyKey: key }),
      async () => {
        second = openAs(waiterDb, adminCtx, student, main, {}, { key });
        second.catch(() => undefined);
        await waitUntilBlocked('%INSERT INTO app.idempotency_keys%');
      },
    );
    void first;
    const replay = await second;
    expect(replay.status).toBe(201);
    expect(replay.replayed).toBe(true);
    const enrolments = await enrolmentsOf(student);
    expect(enrolments).toHaveLength(1);
    expect(idOf(replay)).toBe(enrolments[0]!.id);
    expect(await claimsOf(key)).toHaveLength(1);
    expect(await events(enrolments[0]!.id)).toHaveLength(1);
    expect(await audits(enrolments[0]!.id)).toHaveLength(1);
  });

  it('two concurrent opens with the SAME key but a DIFFERENT request: the loser gets 422 after the winner commits; nothing extra is written', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    let loser!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, student, base(main), { idempotencyKey: key }),
      async () => {
        loser = outcome(
          openAs(waiterDb, adminCtx, student, main, { startDate: '2024-08-02' }, { key }),
        );
        await waitUntilBlocked('%INSERT INTO app.idempotency_keys%');
      },
    );
    expect(await loser).toBe(422);
    expect(await enrolmentsOf(student)).toHaveLength(1);
    expect(await claimsOf(key)).toHaveLength(1);
  });

  it('six simultaneous identical requests: exactly one executes, five replay it; no deadlock; one enrolment', async () => {
    const student = await mkStudent();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        openAs(i % 2 === 0 ? db : waiterDb, adminCtx, student, main, {}, { key }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => idOf(r))).size).toBe(1);
    expect(await enrolmentsOf(student)).toHaveLength(1);
    expect(await claimsOf(key)).toHaveLength(1);
  });

  it('open vs campus deactivation, open first: the deactivation waits on the campus lock, then is refused (409, the department is active); campus stays ACTIVE', async () => {
    const campus = await mkCampus();
    const s = await mkStructure(campus);
    const student = await mkStudent();
    let deactivation!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, student, base(s), {
          idempotencyKey: randomUUID(),
        }),
      async () => {
        deactivation = outcome(
          waiterDb.withTenant(adminCtx, (tx) =>
            CampusService.update(tx, adminCtx, campus, { status: 'INACTIVE' }),
          ),
        );
        await waitUntilBlocked('%app.campuses%FOR NO KEY UPDATE%');
      },
    );
    expect(await deactivation).toBe(409);
    expect((await activeEnrolments(student)).length).toBe(1);
    const [c] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.campuses WHERE id = $1',
      [campus],
    );
    expect(c?.status).toBe('ACTIVE');
  });

  it('open vs campus deactivation, deactivation first (its departments already inactive): the waiting open is 404 and writes nothing', async () => {
    const campus = await mkCampus();
    const s = await mkStructure(campus);
    await adminQuery(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [s.dept]);
    const student = await mkStudent();
    let opening!: Promise<number>;
    await holding(
      adminCtx,
      (tx) => CampusService.update(tx, adminCtx, campus, { status: 'INACTIVE' }),
      async () => {
        opening = outcome(openAs(waiterDb, adminCtx, student, s));
        await waitUntilBlocked('%app.campuses%FOR SHARE%');
      },
    );
    expect(await opening).toBe(404);
    expect(await enrolmentsOf(student)).toHaveLength(0);
    const [c] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.campuses WHERE id = $1',
      [campus],
    );
    expect(c?.status).toBe('INACTIVE');
  });

  it('open vs program deactivation, open first: the deactivation waits on the program lock, then is refused (409, the cohort is active); program stays ACTIVE', async () => {
    const s = await mkStructure(T.campusId);
    const student = await mkStudent();
    let deactivation!: Promise<number>;
    await holding(
      adminCtx,
      (tx) =>
        StudentProgramService.open(tx, adminCtx, student, base(s), {
          idempotencyKey: randomUUID(),
        }),
      async () => {
        deactivation = outcome(
          waiterDb.withTenant(adminCtx, (tx) =>
            ProgramService.update(tx, adminCtx, s.program, { status: 'INACTIVE' }),
          ),
        );
        await waitUntilBlocked('%app.programs%FOR NO KEY UPDATE%');
      },
    );
    expect(await deactivation).toBe(409);
    expect((await activeEnrolments(student)).length).toBe(1);
    const [p] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.programs WHERE id = $1',
      [s.program],
    );
    expect(p?.status).toBe('ACTIVE');
  });

  it('open vs program deactivation, deactivation first (its cohort already closed): the waiting open is 404 and writes nothing', async () => {
    const s = await mkStructure(T.campusId);
    await adminQuery(`UPDATE app.cohorts SET status = 'CLOSED' WHERE id = $1`, [s.cohort]);
    const student = await mkStudent();
    let opening!: Promise<number>;
    await holding(
      adminCtx,
      (tx) => ProgramService.update(tx, adminCtx, s.program, { status: 'INACTIVE' }),
      async () => {
        opening = outcome(openAs(waiterDb, adminCtx, student, s));
        await waitUntilBlocked('%app.programs%FOR SHARE%');
      },
    );
    expect(await opening).toBe(404);
    expect(await enrolmentsOf(student)).toHaveLength(0);
    const [p] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.programs WHERE id = $1',
      [s.program],
    );
    expect(p?.status).toBe('INACTIVE');
  });

  // a fresh student for the holder of an opening; created before the race starts
  function STUDENT_FOR(): string {
    return preparedStudents.pop()!;
  }
  const preparedStudents: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) preparedStudents.push(await mkStudent());
  });
});
