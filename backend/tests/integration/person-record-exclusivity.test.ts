import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { contractVersions, migrate } from '../../tools/db/migrate.js';
import { CTX, ORG_A, ORG_B, seedFixtures, type Ctx } from '../support/fixtures.js';
import { dropAll, freshDatabase, type FreshDb } from '../support/fresh-db.js';

// X1 (migration 0016): a user holds a student record OR an employee record per organization, enforced by triggers
// that serialise on an advisory lock. The races below need two real, concurrent, uncommitted transactions, so this
// file runs ONLY against its own throw-away database (freshDatabase) on the disposable server the global setup
// provides, never against the shared integration database other files write to. beforeAll refuses to continue unless
// the connected database is that throw-away one. Every user is created fresh here, and the database is dropped by
// dropAll; transactions are rolled back in afterEach even when a test fails.

const PERSON_RECORD_EXCLUSIVE = 'person_record_exclusive';
const EXCLUSION_VIOLATION = '23P01';
const INSUFFICIENT_PRIVILEGE = '42501';

let fresh: FreshDb;
let admin: pg.Pool;
const sessions: pg.Client[] = [];

interface Session {
  c: pg.Client;
  pid: number;
}

async function open(actor: Ctx | null, url: string = fresh.runtime): Promise<Session> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  sessions.push(c);
  await c.query('BEGIN');
  if (actor) {
    await c.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.actor_kind', $3, true)`,
      [actor.tenant, actor.user, actor.kind],
    );
  }
  const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return { c, pid };
}

/** Resolves with the pg error (code + constraint) of a statement that must fail. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
  throw new Error('expected the statement to fail');
}

/** Backend-PID wait detection: polls until `pid` is blocked by a lock held by `blocker`. No sleeps-as-synchronisation. */
async function waitBlockedBy(pid: number, blocker: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await admin.query(
      `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND $2 = ANY (pg_blocking_pids($1))`,
      [pid, blocker],
    );
    if (r.rowCount) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`backend ${pid} never blocked on backend ${blocker}`);
}

/** Same, when the waiting backend belongs to a pool and its PID is not known: returns the blocked PID. */
async function waitAnyBlockedBy(blocker: number): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const r = await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND $1 = ANY (pg_blocking_pids(pid))`,
      [blocker],
    );
    if (r.rows[0]) return r.rows[0].pid;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on backend ${blocker}`);
}

async function newUser(org: string = ORG_A): Promise<string> {
  const id = uuidv7();
  const email = `x1-${id}@exclusivity.test`;
  await admin.query(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await admin.query(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'X1 user', 'ACTIVE', $1)`,
    [id, org, email],
  );
  return id;
}

const insStudent = (s: Session, userId: string, org: string = ORG_A) =>
  s.c.query(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ($1, $2, $3, $4, '2024-07-01')`,
    [uuidv7(), org, userId, `X1-${userId.slice(-12)}`],
  );
const insEmployee = (s: Session, userId: string, org: string = ORG_A) =>
  s.c.query(
    `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
     VALUES ($1, $2, $3, $4, 'STAFF', '2024-01-01')`,
    [uuidv7(), org, userId, `X1-${userId.slice(-12)}`],
  );

async function counts(userId: string): Promise<{ students: number; employees: number }> {
  const r = await admin.query<{ s: string; e: string }>(
    `SELECT (SELECT count(*) FROM app.students  WHERE user_id = $1) AS s,
            (SELECT count(*) FROM app.employees WHERE user_id = $1) AS e`,
    [userId],
  );
  return { students: Number(r.rows[0]!.s), employees: Number(r.rows[0]!.e) };
}

beforeAll(async () => {
  fresh = await freshDatabase();
  await migrate({ connectionString: fresh.migrator, allowContract: contractVersions() });
  await seedFixtures(fresh.admin);
  admin = new pg.Pool({ connectionString: fresh.admin, max: 4 });

  // Positive identification of the disposable database before anything concurrent runs.
  const who = (
    await admin.query<{ name: string; port: number }>(
      'SELECT current_database() AS name, inet_server_port() AS port',
    )
  ).rows[0]!;
  expect(who.name).toBe(fresh.name);
  expect(who.name).toMatch(/^campusos_mig_[0-9a-f]{10}$/);
  expect(who.name).not.toBe('campusos_dev');
  expect(Number(who.port)).not.toBe(54329);
  expect(new URL(inject('serverAdminUrl')).port).not.toBe('54329');
}, 180_000);

afterEach(async () => {
  for (const c of sessions.splice(0)) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
});

afterAll(async () => {
  await admin?.end();
  await dropAll();
});

describe('migration 0016: the guard function', () => {
  it('is a SECURITY INVOKER, VOLATILE trigger function with a pinned search_path, not executable by PUBLIC', async () => {
    const r = await admin.query(
      `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'enforce_person_record_exclusive'`,
    );
    expect(r.rows).toEqual([
      {
        prosecdef: false,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog'],
        owner: 'app_migrator',
        public_exec: false,
      },
    ]);
  });

  it('is attached as BEFORE INSERT on students and employees and BEFORE UPDATE OF user_id on students only', async () => {
    const r = await admin.query<{ tgrelid: string; tgname: string; def: string }>(
      `SELECT tgrelid::regclass::text AS tgrelid, tgname, pg_get_triggerdef(oid) AS def
         FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%person_exclusive%' ORDER BY tgname`,
    );
    expect(r.rows.map((x) => [x.tgrelid, x.tgname])).toEqual([
      ['app.employees', 'employees_person_exclusive_ins'],
      ['app.students', 'students_person_exclusive_ins'],
      ['app.students', 'students_person_exclusive_upd'],
    ]);
    const byName = Object.fromEntries(r.rows.map((x) => [x.tgname, x.def]));
    expect(byName['employees_person_exclusive_ins']).toMatch(
      /BEFORE INSERT ON app\.employees FOR EACH ROW/,
    );
    expect(byName['students_person_exclusive_ins']).toMatch(
      /BEFORE INSERT ON app\.students FOR EACH ROW/,
    );
    expect(byName['students_person_exclusive_upd']).toMatch(
      /BEFORE UPDATE OF user_id ON app\.students/,
    );
    expect(byName['students_person_exclusive_upd']).toMatch(
      /WHEN \(\(\(old\.user_id\)::uuid IS DISTINCT FROM \(new\.user_id\)::uuid\)\)/i,
    );
  });
});

describe('both insertion orders inside one transaction', () => {
  it('student first, then employee for the same user: 23P01 / person_record_exclusive', async () => {
    const u = await newUser();
    const s = await open(CTX.staffA);
    await insStudent(s, u);
    const err = await failure(insEmployee(s, u));
    expect(err.code).toBe(EXCLUSION_VIOLATION);
    expect(err.constraint).toBe(PERSON_RECORD_EXCLUSIVE);
  });

  it('employee first, then student for the same user: 23P01 / person_record_exclusive', async () => {
    const u = await newUser();
    const s = await open(CTX.staffA);
    await insEmployee(s, u);
    const err = await failure(insStudent(s, u));
    expect(err.code).toBe(EXCLUSION_VIOLATION);
    expect(err.constraint).toBe(PERSON_RECORD_EXCLUSIVE);
  });

  it('a committed record on one side blocks a new record on the other side', async () => {
    const withStudent = await newUser();
    const withEmployee = await newUser();
    const setup = await open(CTX.staffA);
    await insStudent(setup, withStudent);
    await insEmployee(setup, withEmployee);
    await setup.c.query('COMMIT');

    const s = await open(CTX.staffA);
    expect((await failure(insEmployee(s, withStudent))).constraint).toBe(PERSON_RECORD_EXCLUSIVE);
    const s2 = await open(CTX.staffA);
    expect((await failure(insStudent(s2, withEmployee))).constraint).toBe(PERSON_RECORD_EXCLUSIVE);
  });

  it('different users are unaffected: one student and one employee in the same transaction both succeed', async () => {
    const a = await newUser();
    const b = await newUser();
    const s = await open(CTX.staffA);
    await insStudent(s, a);
    await insEmployee(s, b);
    await s.c.query('COMMIT');
    expect(await counts(a)).toEqual({ students: 1, employees: 0 });
    expect(await counts(b)).toEqual({ students: 0, employees: 1 });
  });
});

// Migration 0017 revoked UPDATE (user_id) from app_runtime: no runtime session can repoint a student any more, so the
// guard's repoint path is now defence in depth for privileged sessions (superuser / a future audited service role).
// These tests keep exercising it through a superuser session, which bypasses RLS and column privileges but NOT triggers.
describe('repointing a student', () => {
  it('the runtime role can no longer repoint a student at all (column privilege revoked in 0017)', async () => {
    const owner = await newUser();
    const target = await newUser();
    const studentId = uuidv7();
    const setup = await open(null, fresh.admin);
    await setup.c.query(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ($1, $2, $3, $4, '2024-07-01')`,
      [studentId, ORG_A, owner, `X1-${owner.slice(-12)}`],
    );
    await setup.c.query('COMMIT');
    const s = await open(CTX.staffA);
    const err = await failure(
      s.c.query(`UPDATE app.students SET user_id = $1 WHERE id = $2`, [target, studentId]),
    );
    expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await counts(owner)).toEqual({ students: 1, employees: 0 });
  });

  it("to an employee's user is rejected; to a free user succeeds; changing other columns never fires the guard", async () => {
    const owner = await newUser();
    const employeeUser = await newUser();
    const freeUser = await newUser();
    const setup = await open(CTX.staffA);
    const studentId = uuidv7();
    await setup.c.query(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ($1, $2, $3, $4, '2024-07-01')`,
      [studentId, ORG_A, owner, `X1-${owner.slice(-12)}`],
    );
    await insEmployee(setup, employeeUser);
    await setup.c.query('COMMIT');

    const repoint = (s: Session, to: string) =>
      s.c.query(`UPDATE app.students SET user_id = $1 WHERE id = $2 AND organization_id = $3`, [
        to,
        studentId,
        ORG_A,
      ]);

    const bad = await open(null, fresh.admin);
    const err = await failure(repoint(bad, employeeUser));
    expect(err.code).toBe(EXCLUSION_VIOLATION);
    expect(err.constraint).toBe(PERSON_RECORD_EXCLUSIVE);

    const ok = await open(null, fresh.admin);
    await repoint(ok, freeUser);
    await ok.c.query(`UPDATE app.students SET status = 'ACTIVE' WHERE id = $1`, [studentId]);
    await ok.c.query('COMMIT');
    expect(await counts(owner)).toEqual({ students: 0, employees: 0 });
    expect(await counts(freeUser)).toEqual({ students: 1, employees: 0 });
    expect(await counts(employeeUser)).toEqual({ students: 0, employees: 1 });
  });

  it('a student whose user already is an employee (legacy row) can still change status: the guard only fires on user_id changes', async () => {
    const u = await newUser();
    const studentId = uuidv7();
    // Superuser inserts with the guard bypassed, to model pre-existing data this migration does not rewrite.
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ($1, $2, $3, $4, '2024-07-01')`,
        [studentId, ORG_A, u, `X1-${u.slice(-12)}`],
      );
      await c.query(
        `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
         VALUES ($1, $2, $3, $4, 'STAFF', '2024-01-01')`,
        [uuidv7(), ORG_A, u, `X1-${u.slice(-12)}`],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const s = await open(CTX.staffA);
    await s.c.query(`UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1`, [studentId]);
    await s.c.query('COMMIT');
    expect(await counts(u)).toEqual({ students: 1, employees: 1 });
  });
});

describe('RLS still rejects unauthorised writes', () => {
  it('a STUDENT actor, a missing context and another tenant cannot insert either record, and no row appears', async () => {
    const u = await newUser();

    const asStudent = await open(CTX.studentA);
    expect((await failure(insStudent(asStudent, u))).code).toBe(INSUFFICIENT_PRIVILEGE);
    const asStudent2 = await open(CTX.studentA);
    expect((await failure(insEmployee(asStudent2, u))).code).toBe(INSUFFICIENT_PRIVILEGE);

    const noContext = await open(null);
    expect((await failure(insStudent(noContext, u))).code).toBe(INSUFFICIENT_PRIVILEGE);
    const noContext2 = await open(null);
    expect((await failure(insEmployee(noContext2, u))).code).toBe(INSUFFICIENT_PRIVILEGE);

    // STAFF of another tenant naming ORG_A rows
    const otherTenant = await open(CTX.staffB);
    expect((await failure(insEmployee(otherTenant, u, ORG_A))).code).toBe(INSUFFICIENT_PRIVILEGE);
    const otherTenant2 = await open(CTX.staffB);
    expect((await failure(insStudent(otherTenant2, u, ORG_A))).code).toBe(INSUFFICIENT_PRIVILEGE);

    expect(await counts(u)).toEqual({ students: 0, employees: 0 });
  });

  it('a student actor cannot repoint their own row at someone else (column privilege) and the guard does not leak a clash', async () => {
    const employeeUser = await newUser();
    const setup = await open(CTX.staffA);
    await insEmployee(setup, employeeUser);
    await setup.c.query('COMMIT');

    // CTX.studentA owns a seeded student row; since 0017 changing user_id is refused by the column privilege (before
    // 0017 it was the students_student_self WITH CHECK). Either way: 42501, and no clash information is returned.
    const s = await open(CTX.studentA);
    const err = await failure(
      s.c.query(`UPDATE app.students SET user_id = $1 WHERE user_id = $2`, [
        employeeUser,
        CTX.studentA.user,
      ]),
    );
    expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('users of one organization never collide with the same-looking records of another', async () => {
    // Exclusivity is per (organization, user): a student of ORG_B and an employee of ORG_A are different accounts.
    const a = await newUser(ORG_A);
    const b = await newUser(ORG_B);
    const sa = await open(CTX.staffA);
    await insEmployee(sa, a, ORG_A);
    await sa.c.query('COMMIT');
    const sb = await open(CTX.staffB);
    await insStudent(sb, b, ORG_B);
    await sb.c.query('COMMIT');
    expect(await counts(a)).toEqual({ students: 0, employees: 1 });
    expect(await counts(b)).toEqual({ students: 1, employees: 0 });
  });
});

describe('concurrent races on one account (dedicated disposable database, backend-PID wait detection)', () => {
  it('student insert holds the lock; the concurrent employee insert waits, then fails 23P01 after the commit', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    const t2 = await open(CTX.staffA);
    await insStudent(t1, u); // uncommitted: holds the advisory lock
    const waiting = failure(insEmployee(t2, u));
    await waitBlockedBy(t2.pid, t1.pid);
    await t1.c.query('COMMIT');
    const err = await waiting;
    expect(err.code).toBe(EXCLUSION_VIOLATION);
    expect(err.constraint).toBe(PERSON_RECORD_EXCLUSIVE);
    await t2.c.query('ROLLBACK');
    expect(await counts(u)).toEqual({ students: 1, employees: 0 });
  });

  it('employee insert holds the lock; the concurrent student insert waits, then fails 23P01 after the commit', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    const t2 = await open(CTX.staffA);
    await insEmployee(t1, u);
    const waiting = failure(insStudent(t2, u));
    await waitBlockedBy(t2.pid, t1.pid);
    await t1.c.query('COMMIT');
    const err = await waiting;
    expect(err.code).toBe(EXCLUSION_VIOLATION);
    expect(err.constraint).toBe(PERSON_RECORD_EXCLUSIVE);
    await t2.c.query('ROLLBACK');
    expect(await counts(u)).toEqual({ students: 0, employees: 1 });
  });

  it('a repoint of a student to the user holds the lock; the concurrent employee insert for that user waits, then fails', async () => {
    const owner = await newUser();
    const target = await newUser();
    const studentId = uuidv7();
    const setup = await open(CTX.staffA);
    await setup.c.query(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ($1, $2, $3, $4, '2024-07-01')`,
      [studentId, ORG_A, owner, `X1-${owner.slice(-12)}`],
    );
    await setup.c.query('COMMIT');

    const t1 = await open(null, fresh.admin); // privileged repoint (see the note above the repointing tests)
    const t2 = await open(CTX.staffA);
    await t1.c.query(`UPDATE app.students SET user_id = $1 WHERE id = $2`, [target, studentId]);
    const waiting = failure(insEmployee(t2, target));
    await waitBlockedBy(t2.pid, t1.pid);
    await t1.c.query('COMMIT');
    expect((await waiting).constraint).toBe(PERSON_RECORD_EXCLUSIVE);
    await t2.c.query('ROLLBACK');
    expect(await counts(target)).toEqual({ students: 1, employees: 0 });
  });

  it('a rollback by the first transaction lets the waiting transaction succeed (student first, then employee)', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    const t2 = await open(CTX.staffA);
    await insStudent(t1, u);
    const waiting = insEmployee(t2, u);
    await waitBlockedBy(t2.pid, t1.pid);
    await t1.c.query('ROLLBACK');
    await waiting; // proceeds and succeeds
    await t2.c.query('COMMIT');
    expect(await counts(u)).toEqual({ students: 0, employees: 1 });
  });

  it('a rollback by the first transaction lets the waiting transaction succeed (employee first, then student)', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    const t2 = await open(CTX.staffA);
    await insEmployee(t1, u);
    const waiting = insStudent(t2, u);
    await waitBlockedBy(t2.pid, t1.pid);
    await t1.c.query('ROLLBACK');
    await waiting;
    await t2.c.query('COMMIT');
    expect(await counts(u)).toEqual({ students: 1, employees: 0 });
  });

  it('writers for DIFFERENT users never wait on each other', async () => {
    const a = await newUser();
    const b = await newUser();
    const t1 = await open(CTX.staffA);
    const t2 = await open(CTX.staffA);
    await insStudent(t1, a); // holds a's lock, uncommitted
    await insEmployee(t2, b); // must not block
    await t2.c.query('COMMIT');
    await t1.c.query('COMMIT');
    expect(await counts(a)).toEqual({ students: 1, employees: 0 });
    expect(await counts(b)).toEqual({ students: 0, employees: 1 });
  });
});

describe('EmployeeService maps the exclusivity violation to a controlled 409', () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(createPool({ connectionString: fresh.runtime, ssl: false, max: 2 }));
  });
  afterAll(async () => {
    await db.close();
  });

  const ctx = () =>
    issueTrustedContext({
      tenantId: CTX.staffA.tenant,
      userId: CTX.staffA.user,
      actorKind: CTX.staffA.kind,
    });
  const body = (userId: string) => ({
    userId,
    employeeCode: `X1-${userId.slice(-12)}`,
    employeeType: 'FACULTY' as const,
    joiningDate: '2024-06-01',
    reason: 'Initial onboarding',
  });

  it('the losing request of a race (student record committed after the service pre-check) is 409 CONFLICT, not 500', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    await insStudent(t1, u); // uncommitted: invisible to the service pre-check, holds the lock

    const request = db
      .withTenant(ctx(), (tx) => EmployeeService.create(tx, ctx(), body(u)))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    await waitAnyBlockedBy(t1.pid);
    await t1.c.query('COMMIT');

    const err = await request;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('CONFLICT');
    expect((err as AppError).message).toBe('This account already has a student record.');
    expect(await counts(u)).toEqual({ students: 1, employees: 0 });
  });

  it('if the other transaction rolls back instead, the same request succeeds', async () => {
    const u = await newUser();
    const t1 = await open(CTX.staffA);
    await insStudent(t1, u);
    const request = db.withTenant(ctx(), (tx) => EmployeeService.create(tx, ctx(), body(u)));
    await waitAnyBlockedBy(t1.pid);
    await t1.c.query('ROLLBACK');
    await expect(request).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await counts(u)).toEqual({ students: 0, employees: 1 });
  });

  it('only the exclusivity violation is mapped: a duplicate employee code stays its own 409 message', async () => {
    const a = await newUser();
    const b = await newUser();
    const code = `X1-DUP-${a.slice(-8)}`;
    await db.withTenant(ctx(), (tx) =>
      EmployeeService.create(tx, ctx(), { ...body(a), employeeCode: code }),
    );
    const err = await db
      .withTenant(ctx(), (tx) =>
        EmployeeService.create(tx, ctx(), { ...body(b), employeeCode: code }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).message).toBe('An employee with this code already exists.');
  });
});
