import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// A PostgreSQL lock timeout (55P03) or statement timeout (57014) on the enrolment paths is a safe, retryable
// 503 DATABASE_BUSY over HTTP: close, the structural guards (department / cohort PATCH) and the locks inside open's
// idempotent work. The claim wait for the SAME key stays the intentional 409 IDEMPOTENCY_IN_PROGRESS. Real timeouts: the
// app's pool uses a short lock_timeout / statement_timeout through a connection option (test-only; the runtime role's
// own are 10 s / 30 s), and another session holds the row lock. Own private tenant; nothing is asserted tenant-wide.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const base = inject('dbRuntimeUrl');
const LOCK_1S = '-c lock_timeout=1000ms';
const STMT_1S = '-c lock_timeout=0 -c statement_timeout=1000';

// createPool pins statement_timeout at the connection level, which would override the option, so the short-timeout apps
// use a plain pg.Pool with startup options (same technique as tests/integration/idempotency.test.ts).
const mkApp = (options: string) => {
  const db = new Database(new pg.Pool({ connectionString: base, max: 4, options }));
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: base, APP_ORIGINS: APP_ORIGIN }),
    db,
    logger: false,
  });
  return { db, app };
};
const lockApp = mkApp(LOCK_1S);
const stmtApp = mkApp(STMT_1S);

let T!: IsolatedTenant;
let session: { cookie: string; csrf: string };
let stmtSession: { cookie: string; csrf: string };
let PERIOD: string;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

async function login(app: ReturnType<typeof mkApp>['app'], email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}
interface Structure {
  dept: string;
  program: string;
  cohort: string;
}
async function mkStructure(): Promise<Structure> {
  const dept = uuidv7();
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Timeout dept', $4)`,
    [dept, T.orgId, T.campusId, code('D')],
  );
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Timeout program', $5, 'UG', 8)`,
    [program, T.orgId, dept, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Timeout cohort')`,
    [cohort, T.orgId, program],
  );
  return { dept, program, cohort };
}
async function mkStudent(): Promise<string> {
  const user = uuidv7();
  const email = `to-${RUN}-${user.slice(-12)}@isolated.test`;
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
     VALUES ($1, $2, $3, $4, '2024-07-01', 'ACTIVE')`,
    [id, T.orgId, user, `TO${RUN}${seq++}`],
  );
  return id;
}
async function mkEnrolment(student: string, s: Structure): Promise<string> {
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.student_programs (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01', 'ACTIVE')`,
    [id, T.orgId, student, s.program, s.cohort, T.campusId, s.dept],
  );
  return id;
}

/** Another session that holds an exclusive row lock until released (BEGIN ... SELECT ... FOR UPDATE). */
async function holdRow(table: string, id: string): Promise<() => Promise<void>> {
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT 1 FROM app.${table} WHERE id = $1 FOR UPDATE`, [id]);
  return async () => {
    await c.query('ROLLBACK');
    await c.end();
  };
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  await lockApp.app.ready();
  await stmtApp.app.ready();
  session = await login(lockApp.app, T.emails.admin);
  stmtSession = await login(stmtApp.app, T.emails.admin);
}, 90_000);

afterAll(async () => {
  await lockApp.app.close();
  await stmtApp.app.close();
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
  await T.cleanup();
});

const post = (
  h: { app: ReturnType<typeof mkApp>['app']; s: { cookie: string; csrf: string } },
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  method: 'POST' | 'PATCH' = 'POST',
) =>
  h.app.inject({
    method,
    url,
    payload: payload as never,
    cookies: { session_token: h.s.cookie },
    headers: { origin: APP_ORIGIN, 'x-csrf-token': h.s.csrf, ...headers },
  });
const withLock = {
  app: lockApp.app,
  get s() {
    return session;
  },
};
const withStmt = {
  app: stmtApp.app,
  get s() {
    return stmtSession;
  },
};

const closeBody = { outcome: 'COMPLETED', endDate: '2025-01-15', reason: 'Programme completed' };
const BUSY = { code: 'DATABASE_BUSY', message: 'The service is busy. Retry the request.' };
function expectSafe503(r: { statusCode: number; body: string; json: <X>() => X }): void {
  expect(r.statusCode).toBe(503);
  expect(r.json<{ error: Record<string, unknown> }>().error).toMatchObject(BUSY);
  for (const leak of [
    '55P03',
    '57014',
    'lock',
    'timeout',
    'canceling',
    'student_programs',
    'SELECT',
    'FOR NO KEY',
  ]) {
    expect(r.body, leak).not.toContain(leak);
  }
}
const state = async (id: string) =>
  (
    await adminQuery<{ status: string; version: number }>(
      'SELECT status, version FROM app.student_programs WHERE id = $1',
      [id],
    )
  )[0];
const sideEffects = (id: string) =>
  adminQuery(
    `SELECT 1 FROM app.student_program_events WHERE student_program_id = $1 AND event_type = 'CLOSED'
     UNION ALL SELECT 1 FROM app.audit_events WHERE organization_id = $2 AND resource_id = $1 AND action = 'student_program.close'`,
    [id, T.orgId],
  );

describe('close', () => {
  it('a lock timeout on the enrolment row is 503 DATABASE_BUSY, leaves no partial write, and a retry succeeds', async () => {
    const student = await mkStudent();
    const id = await mkEnrolment(student, await mkStructure());
    const release = await holdRow('student_programs', id);
    let r;
    try {
      r = await post(withLock, `/api/v1/students/${student}/programs/${id}/close`, closeBody, {
        'if-match': '"1"',
      });
    } finally {
      await release();
    }
    expectSafe503(r);
    expect(await state(id)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await sideEffects(id)).toHaveLength(0);
    const retry = await post(
      withLock,
      `/api/v1/students/${student}/programs/${id}/close`,
      closeBody,
      { 'if-match': '"1"' },
    );
    expect(retry.statusCode).toBe(200);
  }, 30_000);

  it('a statement timeout (57014) while waiting on the row is the same safe 503', async () => {
    const student = await mkStudent();
    const id = await mkEnrolment(student, await mkStructure());
    const release = await holdRow('student_programs', id);
    let r;
    try {
      r = await post(withStmt, `/api/v1/students/${student}/programs/${id}/close`, closeBody, {
        'if-match': '"1"',
      });
    } finally {
      await release();
    }
    expectSafe503(r);
    expect(await state(id)).toEqual({ status: 'ACTIVE', version: 1 });
  }, 30_000);
});

describe('open', () => {
  it('a lock timeout on the student row inside the idempotent work is 503; nothing (not even the key claim) is persisted; the same key then succeeds', async () => {
    const student = await mkStudent();
    const s = await mkStructure();
    const key = randomUUID();
    const body = {
      programId: s.program,
      cohortId: s.cohort,
      startDate: '2024-08-01',
      reason: 'Admitted to the program',
    };
    const release = await holdRow('students', student);
    let r;
    try {
      r = await post(withLock, `/api/v1/students/${student}/programs`, body, {
        'idempotency-key': key,
      });
    } finally {
      await release();
    }
    expectSafe503(r);
    expect(
      await adminQuery('SELECT 1 FROM app.student_programs WHERE student_id = $1', [student]),
    ).toHaveLength(0);
    expect(
      await adminQuery(
        'SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2',
        [T.orgId, key],
      ),
    ).toHaveLength(0);
    const retry = await post(withLock, `/api/v1/students/${student}/programs`, body, {
      'idempotency-key': key,
    });
    expect(retry.statusCode).toBe(201);
  }, 30_000);

  it('waiting for the SAME idempotency key stays the intentional 409 IDEMPOTENCY_IN_PROGRESS, not 503', async () => {
    const student = await mkStudent();
    const s = await mkStructure();
    const key = randomUUID();
    const body = {
      programId: s.program,
      cohortId: s.cohort,
      startDate: '2024-08-01',
      reason: 'Admitted to the program',
    };
    // another transaction holds an uncommitted claim of this exact (tenant, principal, key)
    const holder = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO app.idempotency_keys (organization_id, user_id, key, operation, request_hash, expires_at)
       VALUES ($1, $2, $3, 'POST /api/v1/students/:id/programs', $4, now() + interval '1 hour')`,
      [T.orgId, T.users.admin, key, 'a'.repeat(64)],
    );
    let r;
    try {
      r = await post(withLock, `/api/v1/students/${student}/programs`, body, {
        'idempotency-key': key,
      });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(
      await adminQuery('SELECT 1 FROM app.student_programs WHERE student_id = $1', [student]),
    ).toHaveLength(0);
  }, 30_000);
});

describe('structural guards', () => {
  it('department PATCH: a lock timeout on the department row is 503 and the department is unchanged', async () => {
    const s = await mkStructure();
    const release = await holdRow('departments', s.dept);
    let r;
    try {
      r = await post(
        withLock,
        `/api/v1/organization/departments/${s.dept}`,
        { status: 'INACTIVE' },
        {},
        'PATCH',
      );
    } finally {
      await release();
    }
    expectSafe503(r);
    const [d] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.departments WHERE id = $1',
      [s.dept],
    );
    expect(d?.status).toBe('ACTIVE');
  }, 30_000);

  it('cohort PATCH: a lock timeout on the cohort row is 503 and the cohort is unchanged', async () => {
    const s = await mkStructure();
    const release = await holdRow('cohorts', s.cohort);
    let r;
    try {
      r = await post(
        withLock,
        `/api/v1/academics/cohorts/${s.cohort}`,
        { status: 'CLOSED' },
        {},
        'PATCH',
      );
    } finally {
      await release();
    }
    expectSafe503(r);
    const [c] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.cohorts WHERE id = $1',
      [s.cohort],
    );
    expect(c?.status).toBe('ACTIVE');
  }, 30_000);

  it("the guards' own refusal is untouched: an ACTIVE enrolment still gives 409 CONFLICT, not 503", async () => {
    const s = await mkStructure();
    await mkEnrolment(await mkStudent(), s);
    const dept = await post(
      withLock,
      `/api/v1/organization/departments/${s.dept}`,
      { status: 'INACTIVE' },
      {},
      'PATCH',
    );
    expect(dept.statusCode).toBe(409);
    const cohort = await post(
      withLock,
      `/api/v1/academics/cohorts/${s.cohort}`,
      { status: 'CLOSED' },
      {},
      'PATCH',
    );
    expect(cohort.statusCode).toBe(409);
  }, 30_000);
});

describe('audit insert timeout (the business writes already done must roll back)', () => {
  /**
   * Holds ACCESS EXCLUSIVE on the current month's audit partition, so only the audit INSERT can wait.
   *
   * The partition is SHARED by every integration file running at the same time. A PENDING ACCESS EXCLUSIVE request
   * queues every later writer of the partition behind it, including a writer in another file whose own transaction
   * is waiting (at application level, invisible to PostgreSQL's deadlock detector) for a transaction that already
   * holds the partition, as the nested transactions of designation.test.ts do. An unbounded wait here turned that
   * into a 10 s lock timeout (503) in the other file. So the request never waits long: it is retried with a short
   * lock_timeout until it is granted, and the queue it forms is released after each failed attempt.
   */
  async function holdAuditPartition(): Promise<() => Promise<void>> {
    const [{ ym }] = (await adminQuery<{ ym: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS ym`,
    )) as [{ ym: string }];
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    // Cleanup helpers never throw: they run on error paths (and in `release`), where a second failure must not hide
    // the first. A broken connection drops its transaction and locks on the server anyway.
    c.on('error', () => undefined);
    const rollbackQuietly = async () => {
      try {
        await c.query('ROLLBACK');
      } catch {
        /* the connection is unusable; closing it releases everything */
      }
    };
    const closeQuietly = async () => {
      try {
        await c.end();
      } catch {
        /* already closed or never connected */
      }
    };
    try {
      await c.connect();
      for (let attempt = 0; ; attempt++) {
        await c.query('BEGIN');
        try {
          await c.query(`SET LOCAL lock_timeout = '150ms'`);
          await c.query(`LOCK TABLE app.audit_events_${ym} IN ACCESS EXCLUSIVE MODE`);
          break;
        } catch (err) {
          await rollbackQuietly();
          if ((err as { code?: string }).code !== '55P03' || attempt >= 100) throw err;
        }
        await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
      }
    } catch (err) {
      // connect, BEGIN, SET LOCAL, LOCK or an exhausted/non-55P03 retry: close the client, rethrow the ORIGINAL error
      await closeQuietly();
      throw err;
    }
    return async () => {
      await rollbackQuietly();
      await closeQuietly();
    };
  }

  it('close: the enrolment update and CLOSED event are rolled back and the answer is the safe 503; a retry then succeeds', async () => {
    const student = await mkStudent();
    const id = await mkEnrolment(student, await mkStructure());
    const release = await holdAuditPartition();
    let r;
    try {
      r = await post(withLock, `/api/v1/students/${student}/programs/${id}/close`, closeBody, {
        'if-match': '"1"',
      });
    } finally {
      await release();
    }
    expectSafe503(r);
    expect(r.body).not.toContain('AUDIT_WRITE_FAILED');
    expect(await state(id)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await sideEffects(id)).toHaveLength(0);
    const retry = await post(
      withLock,
      `/api/v1/students/${student}/programs/${id}/close`,
      closeBody,
      {
        'if-match': '"1"',
      },
    );
    expect(retry.statusCode).toBe(200);
    expect(await sideEffects(id)).toHaveLength(2); // exactly one CLOSED event and one audit record, from the retry
  }, 30_000);

  it('open: the enrolment, OPENED event and idempotency claim are rolled back; the same key then succeeds exactly once', async () => {
    const student = await mkStudent();
    const s = await mkStructure();
    const key = randomUUID();
    const body = {
      programId: s.program,
      cohortId: s.cohort,
      startDate: '2024-08-01',
      reason: 'Admitted to the program',
    };
    const release = await holdAuditPartition();
    let r;
    try {
      r = await post(withLock, `/api/v1/students/${student}/programs`, body, {
        'idempotency-key': key,
      });
    } finally {
      await release();
    }
    expectSafe503(r);
    expect(
      await adminQuery('SELECT 1 FROM app.student_programs WHERE student_id = $1', [student]),
    ).toHaveLength(0);
    expect(
      await adminQuery('SELECT 1 FROM app.student_program_events WHERE student_id = $1', [student]),
    ).toHaveLength(0);
    expect(
      await adminQuery(
        'SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2',
        [T.orgId, key],
      ),
    ).toHaveLength(0);
    const retry = await post(withLock, `/api/v1/students/${student}/programs`, body, {
      'idempotency-key': key,
    });
    expect(retry.statusCode).toBe(201);
    expect(
      await adminQuery('SELECT 1 FROM app.student_programs WHERE student_id = $1', [student]),
    ).toHaveLength(1);
  }, 30_000);
});
