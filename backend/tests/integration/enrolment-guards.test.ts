import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CohortService } from '../../src/modules/academics/academic.service.js';
import { DepartmentService } from '../../src/modules/organization/department.service.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Step 2B: deactivation guards. A department (update to INACTIVE, soft delete) and a cohort (status leaving ACTIVE) that
// still hold an ACTIVE student_programs row are refused with 409, and the guards hold against a concurrently opening
// enrolment. Everything commits, so it runs in a private tenant; the enrolments are inserted with the harness superuser
// (the enrolment SERVICE does not exist yet) following the lock order the service will use.

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 8 });
const db = new Database(pool);

let T!: IsolatedTenant;
const ctxFor = (user: string) =>
  issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STAFF' });

const status = (p: Promise<unknown>): Promise<number | undefined> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : undefined),
  );

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}

const PERIOD = uuidv7();
let year = 2000;

/** A new department in the tenant's campus, with an ACTIVE program and one ACTIVE cohort. */
async function structure(): Promise<{ dept: string; program: string; cohort: string }> {
  const dept = uuidv7();
  const program = uuidv7();
  const cohort = uuidv7();
  const code = dept.slice(-8);
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Guard dept', $4)`,
    [dept, T.orgId, T.campusId, code],
  );
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Guard program', $5, 'UG', 8)`,
    [program, T.orgId, dept, PERIOD, code],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, $4, 'Guard cohort')`,
    [cohort, T.orgId, program, year++],
  );
  return { dept, program, cohort };
}

const enrolSql = `INSERT INTO app.student_programs
  (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-07-01', 'ACTIVE')`;
const enrol = (s: { dept: string; program: string; cohort: string }, student: string) =>
  adminQuery(enrolSql, [uuidv7(), T.orgId, student, s.program, s.cohort, T.campusId, s.dept]);
const closeAll = (student: string) =>
  adminQuery(
    `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-01-01', exit_reason = 'Closed by the test'
      WHERE organization_id = $1 AND student_id = $2 AND status = 'ACTIVE'`,
    [T.orgId, student],
  );

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
}, 60_000);

afterAll(async () => {
  await db.close();
  // append-only/RESTRICT chains: remove the committed test rows with triggers skipped, in one transaction
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of ['student_programs', 'cohorts', 'programs', 'period_types']) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
});

const deptStatus = async (id: string) =>
  (
    await adminQuery<{ status: string; deleted: boolean }>(
      'SELECT status, deleted_at IS NOT NULL AS deleted FROM app.departments WHERE id = $1',
      [id],
    )
  )[0];
const cohortStatus = async (id: string) =>
  (await adminQuery<{ status: string }>('SELECT status FROM app.cohorts WHERE id = $1', [id]))[0]
    ?.status;

describe('department deactivation and soft delete with active enrolments', () => {
  it('update to INACTIVE: refused (409) while an ACTIVE enrolment exists, allowed for a department without one and after the enrolment is closed', async () => {
    const admin = ctxFor(T.users.admin);
    const used = await structure();
    const empty = await structure();
    await enrol(used, T.students.one);

    expect(
      await status(
        db.withTenant(admin, (tx) =>
          DepartmentService.update(tx, admin, used.dept, { status: 'INACTIVE' }),
        ),
      ),
    ).toBe(409);
    expect((await deptStatus(used.dept))?.status).toBe('ACTIVE');

    expect(
      await status(
        db.withTenant(admin, (tx) =>
          DepartmentService.update(tx, admin, empty.dept, { status: 'INACTIVE' }),
        ),
      ),
    ).toBe(200);
    expect((await deptStatus(empty.dept))?.status).toBe('INACTIVE');

    // a rename does not deactivate, so it is allowed even with the enrolment
    expect(
      await status(
        db.withTenant(admin, (tx) =>
          DepartmentService.update(tx, admin, used.dept, { name: 'Renamed' }),
        ),
      ),
    ).toBe(200);

    // closed enrolments do not block
    await closeAll(T.students.one);
    expect(
      await status(
        db.withTenant(admin, (tx) =>
          DepartmentService.update(tx, admin, used.dept, { status: 'INACTIVE' }),
        ),
      ),
    ).toBe(200);
  });

  it('soft delete: refused (409) while an ACTIVE enrolment exists, allowed without one and after closing', async () => {
    const admin = ctxFor(T.users.admin);
    const used = await structure();
    const empty = await structure();
    await enrol(used, T.students.one);

    expect(
      await status(
        db.withTenant(admin, (tx) => DepartmentService.softDelete(tx, admin, used.dept)),
      ),
    ).toBe(409);
    expect(await deptStatus(used.dept)).toEqual({ status: 'ACTIVE', deleted: false });

    expect(
      await status(
        db.withTenant(admin, (tx) => DepartmentService.softDelete(tx, admin, empty.dept)),
      ),
    ).toBe(200);
    expect(await deptStatus(empty.dept)).toEqual({ status: 'INACTIVE', deleted: true });

    await closeAll(T.students.one);
    expect(
      await status(
        db.withTenant(admin, (tx) => DepartmentService.softDelete(tx, admin, used.dept)),
      ),
    ).toBe(200);
  });

  it('authorization comes first: a caller without the permission gets 403, never the enrolment conflict', async () => {
    const used = await structure();
    await enrol(used, T.students.one);
    const faculty = ctxFor(T.users.faculty);
    expect(
      await status(
        db.withTenant(faculty, (tx) =>
          DepartmentService.update(tx, faculty, used.dept, { status: 'INACTIVE' }),
        ),
      ),
    ).toBe(403);
    expect(
      await status(
        db.withTenant(faculty, (tx) => DepartmentService.softDelete(tx, faculty, used.dept)),
      ),
    ).toBe(403);
    // a campus admin of the SAME campus is in scope and is refused with the conflict
    const campusAdmin = ctxFor(T.users.campusAdmin);
    expect(
      await status(
        db.withTenant(campusAdmin, (tx) =>
          DepartmentService.update(tx, campusAdmin, used.dept, { status: 'INACTIVE' }),
        ),
      ),
    ).toBe(409);
    await closeAll(T.students.one);
  });
});

describe('cohort status change with active enrolments', () => {
  it('ACTIVE -> CLOSED / GRADUATED: refused (409) while an ACTIVE enrolment exists; allowed without one and after closing; other edits unaffected', async () => {
    const admin = ctxFor(T.users.admin);
    const used = await structure();
    const empty = await structure();
    await enrol(used, T.students.one);

    for (const next of ['CLOSED', 'GRADUATED'] as const) {
      expect(
        await status(
          db.withTenant(admin, (tx) =>
            CohortService.update(tx, admin, used.cohort, { status: next }),
          ),
        ),
      ).toBe(409);
    }
    expect(await cohortStatus(used.cohort)).toBe('ACTIVE');

    expect(
      await status(
        db.withTenant(admin, (tx) =>
          CohortService.update(tx, admin, used.cohort, { name: 'Renamed cohort' }),
        ),
      ),
    ).toBe(200);

    expect(
      await status(
        db.withTenant(admin, (tx) =>
          CohortService.update(tx, admin, empty.cohort, { status: 'GRADUATED' }),
        ),
      ),
    ).toBe(200);
    expect(await cohortStatus(empty.cohort)).toBe('GRADUATED');

    await closeAll(T.students.one);
    expect(
      await status(
        db.withTenant(admin, (tx) =>
          CohortService.update(tx, admin, used.cohort, { status: 'CLOSED' }),
        ),
      ),
    ).toBe(200);
    expect(await cohortStatus(used.cohort)).toBe('CLOSED');
  });

  it('authorization comes first: no permission gives 403', async () => {
    const used = await structure();
    await enrol(used, T.students.one);
    const faculty = ctxFor(T.users.faculty);
    expect(
      await status(
        db.withTenant(faculty, (tx) =>
          CohortService.update(tx, faculty, used.cohort, { status: 'CLOSED' }),
        ),
      ),
    ).toBe(403);
    await closeAll(T.students.one);
  });
});

describe('concurrency: an enrolment opening under the share locks the enrolment service will take', () => {
  // The opener takes, in order: department FOR SHARE (status ACTIVE), program FOR SHARE, cohort FOR SHARE, then inserts.
  const open = async (
    s: { dept: string; program: string; cohort: string },
    student: string,
    held: Promise<void>,
    locked: () => void,
  ) => {
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const [table, id] of [
        ['departments', s.dept],
        ['programs', s.program],
        ['cohorts', s.cohort],
      ] as const) {
        const r = await c.query(
          `SELECT 1 FROM app.${table} WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' FOR SHARE`,
          [T.orgId, id],
        );
        expect(r.rowCount).toBe(1);
      }
      await c.query(enrolSql, [
        uuidv7(),
        T.orgId,
        student,
        s.program,
        s.cohort,
        T.campusId,
        s.dept,
      ]);
      locked();
      await held;
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };

  it('a cohort closure that starts while an enrolment is being opened waits, then is refused (409)', async () => {
    const admin = ctxFor(T.users.admin);
    const s = await structure();
    const locked = gate();
    const release = gate();
    const opener = open(s, T.students.two, release.wait, locked.open);
    await locked.wait;
    const closing = status(
      db.withTenant(admin, (tx) => CohortService.update(tx, admin, s.cohort, { status: 'CLOSED' })),
    );
    await waitUntilBlocked('%app.cohorts%FOR NO KEY UPDATE%');
    release.open();
    await opener;
    expect(await closing).toBe(409);
    expect(await cohortStatus(s.cohort)).toBe('ACTIVE');
    await closeAll(T.students.two);
  });

  it('a department deactivation and a soft delete that start while an enrolment is being opened wait, then are refused (409)', async () => {
    const admin = ctxFor(T.users.admin);
    for (const act of ['update', 'delete'] as const) {
      const s = await structure();
      const locked = gate();
      const release = gate();
      const opener = open(s, T.students.two, release.wait, locked.open);
      await locked.wait;
      const run = status(
        db.withTenant(admin, (tx) =>
          act === 'update'
            ? DepartmentService.update(tx, admin, s.dept, { status: 'INACTIVE' })
            : DepartmentService.softDelete(tx, admin, s.dept),
        ),
      );
      await waitUntilBlocked('%app.departments%FOR NO KEY UPDATE%');
      release.open();
      await opener;
      expect(await run, act).toBe(409);
      expect(await deptStatus(s.dept)).toEqual({ status: 'ACTIVE', deleted: false });
      await closeAll(T.students.two);
    }
  });

  it('the other order: a deactivation that commits first makes the next opening find nothing to lock', async () => {
    const admin = ctxFor(T.users.admin);
    const s = await structure();
    const committed = gate();
    const release = gate();
    const closing = db.withTenant(admin, async (tx) => {
      await CohortService.update(tx, admin, s.cohort, { status: 'CLOSED' });
      committed.open();
      await release.wait;
    });
    await committed.wait;
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      const lock = c.query(
        `SELECT 1 FROM app.cohorts WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' FOR SHARE`,
        [T.orgId, s.cohort],
      );
      await waitUntilBlocked('%app.cohorts%FOR SHARE%');
      release.open();
      await closing;
      expect((await lock).rowCount).toBe(0); // READ COMMITTED recheck: the closed cohort no longer qualifies
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });
});
