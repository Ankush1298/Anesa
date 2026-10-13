import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Database, type TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { StudentService } from '../../src/modules/students/student.service.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// The person-identity invariant (docs/architecture/v3/21-students.md §6): an account with a student record has no
// staff-capable role assignment, and student / employee records exclude each other. Service level (the shared
// person lock, the explicit checks) and database level (the migration 0020 trigger backstop) against the shared
// disposable integration database, in a private tenant. Ordering is synchronised with gates and by waiting until the
// contender is observably blocked on a lock (scoped to this run's waiter pool by application_name).

const RUN = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 12 });
const db = new Database(pool);
const WAITER_APP = `it-person-waiter-${RUN}`;
const waiterDb = new Database(
  createPool({
    connectionString: inject('dbRuntimeUrl'),
    ssl: false,
    max: 6,
    applicationName: WAITER_APP,
  }),
);
const created: string[] = [];

let T!: IsolatedTenant;
let admin!: TrustedContext;
beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  admin = issueTrustedContext({ tenantId: T.orgId, userId: T.users.admin, actorKind: 'STAFF' });
});
afterAll(async () => {
  await T.cleanup();
  await adminQuery('DELETE FROM app.role_assignments WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.students WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.employees WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.users WHERE id = ANY($1::uuid[])', [created]).catch(
    () => undefined,
  );
  await adminQuery('DELETE FROM platform.identities WHERE id = ANY($1::uuid[])', [created]).catch(
    () => undefined,
  );
  await adminQuery("DELETE FROM app.roles WHERE organization_id = $1 AND code LIKE 'XTEST%'", [
    T.orgId,
  ]).catch(() => undefined);
  await waiterDb.close();
  await db.close();
});

async function newUser(): Promise<string> {
  const id = uuidv7();
  const email = `pid-${RUN.toLowerCase()}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [id, T.orgId, email],
  );
  created.push(id);
  return id;
}

const gateOf = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
/** Polls until a backend of THIS run's waiter pool waits on a lock in a statement matching `like`. */
async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $2
          AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like, WAITER_APP],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}
const LOCK = '%pg_advisory_xact_lock%';

class Rollback extends Error {}
const rolledBack = (e: unknown): void => {
  if (!(e instanceof Rollback)) throw e;
};
const statusOf = (p: Promise<unknown>): Promise<number | string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e as { statusCode?: number }).statusCode ?? `other:${String(e)}`,
  );

const roleIds = new Map<string, string>();
async function roleId(code: string): Promise<string> {
  const known = roleIds.get(code);
  if (known) return known;
  const id = (
    await adminQuery<{ id: string }>(
      'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
      [T.orgId, code],
    )
  )[0]!.id;
  roleIds.set(code, id);
  return id;
}
const grant = async (tx: TenantTx, userId: string, code: string) =>
  RoleAssignmentService.grant(tx, admin, {
    targetUserId: userId,
    roleId: await roleId(code),
    scopeType: 'ORGANIZATION',
    reason: 'Granting for the identity invariant test',
  });
const createStudent = (tx: TenantTx, userId: string) =>
  StudentService.create(
    tx,
    admin,
    {
      userId,
      admissionNumber: `P${RUN}-${++counter}`,
      admissionDate: '2024-07-01',
      reason: 'Admitted after counselling',
    },
    { idempotencyKey: `pid-${RUN}-${randomUUID()}`.slice(0, 64) },
  );
const createEmployee = (tx: TenantTx, userId: string) =>
  EmployeeService.create(tx, admin, {
    userId,
    employeeCode: `PE${RUN}-${++counter}`,
    employeeType: 'STAFF',
    joiningDate: '2024-01-01',
    reason: 'Onboarding for the identity test',
  });
const hasStudent = async (u: string): Promise<boolean> =>
  (await adminQuery('SELECT 1 FROM app.students WHERE user_id = $1', [u])).length > 0;
const hasEmployee = async (u: string): Promise<boolean> =>
  (await adminQuery('SELECT 1 FROM app.employees WHERE user_id = $1', [u])).length > 0;
const assignmentsOf = (u: string) =>
  adminQuery<{ code: string }>(
    `SELECT r.code FROM app.role_assignments ra JOIN app.roles r ON r.id = ra.role_id
      WHERE ra.user_id = $1 AND ra.status = 'ACTIVE'`,
    [u],
  );

/** A superuser connection held open in a transaction (the raw, privileged writer). */
async function rawWriter(applicationName?: string): Promise<pg.Client> {
  const c = new pg.Client({
    connectionString: inject('dbAdminUrl'),
    ...(applicationName ? { application_name: applicationName } : {}),
  });
  await c.connect();
  await c.query('BEGIN');
  return c;
}
const rawAssignment = (
  c: pg.Client,
  userId: string,
  code: string,
  extra: { status?: string; from?: string; until?: string | null } = {},
) =>
  c.query(
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, status, valid_from, valid_until)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION', NULL, $5, COALESCE($6::timestamptz, now() - interval '1 minute'), $7::timestamptz
       FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
    [
      uuidv7(),
      T.orgId,
      userId,
      code,
      extra.status ?? 'ACTIVE',
      extra.from ?? null,
      extra.until ?? null,
    ],
  );
const sqlState = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => `${(e as { code?: string }).code}/${(e as { constraint?: string }).constraint}`,
  );

describe('sequential rules (service layer)', () => {
  it('a staff role is refused on an account with a committed student record (409), nothing is stored', async () => {
    const u = await newUser();
    await db.withTenant(admin, (tx) => createStudent(tx, u));
    for (const code of ['FACULTY', 'STAFF', 'COLLEGE_ADMIN']) {
      expect(await statusOf(db.withTenant(admin, (tx) => grant(tx, u, code))), code).toBe(409);
    }
    expect(await assignmentsOf(u)).toEqual([]);
  });

  it('a STUDENT role requires an existing student record: refused before it, allowed after it; afterwards staff roles are still refused', async () => {
    const u = await newUser();
    expect(await statusOf(db.withTenant(admin, (tx) => grant(tx, u, 'STUDENT')))).toBe(409);
    expect(await assignmentsOf(u)).toEqual([]);

    await db.withTenant(admin, (tx) => createStudent(tx, u));
    await db.withTenant(admin, (tx) => grant(tx, u, 'STUDENT'));
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['STUDENT']);
    expect(await statusOf(db.withTenant(admin, (tx) => grant(tx, u, 'FACULTY')))).toBe(409);
    // the student create flow itself is unchanged for an account that ALREADY holds a STUDENT role (see student-routes)
  });

  it('a STUDENT role is refused on an employee account; an employee account may receive staff roles', async () => {
    const u = await newUser();
    await db.withTenant(admin, (tx) => createEmployee(tx, u));
    expect(await statusOf(db.withTenant(admin, (tx) => grant(tx, u, 'STUDENT')))).toBe(409);
    await db.withTenant(admin, (tx) => grant(tx, u, 'FACULTY'));
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['FACULTY']);
  });

  it('revoking the staff role lets the student record be created (revoked rows never conflict)', async () => {
    const u = await newUser();
    const id = await db.withTenant(admin, (tx) => grant(tx, u, 'FACULTY'));
    expect(await statusOf(db.withTenant(admin, (tx) => createStudent(tx, u)))).toBe(409);
    await db.withTenant(admin, (tx) =>
      RoleAssignmentService.revoke(tx, admin, id, 'Revoked for the identity test'),
    );
    expect(await statusOf(db.withTenant(admin, (tx) => createStudent(tx, u)))).toBe('resolved');
  });
});

describe('the two orderings of a staff grant against a student create (deterministic)', () => {
  it('student create IN FLIGHT first: the grant waits on the person lock, then is refused (409)', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const creating = db.withTenant(admin, async (tx) => {
      await createStudent(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => grant(tx, u, 'FACULTY')));
    await waitUntilBlocked(LOCK);
    release.open();
    await creating;
    expect(await outcome).toBe(409);
    expect(await hasStudent(u)).toBe(true);
    expect(await assignmentsOf(u)).toEqual([]);
  });

  it('grant IN FLIGHT first: the student create waits on the person lock, then is refused (409)', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const granting = db.withTenant(admin, async (tx) => {
      await grant(tx, u, 'FACULTY');
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => createStudent(tx, u)));
    await waitUntilBlocked(LOCK);
    release.open();
    await granting;
    expect(await outcome).toBe(409);
    expect(await hasStudent(u)).toBe(false);
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['FACULTY']);
  });

  it('student create in flight that ROLLS BACK: the waiting grant then SUCCEEDS (the student never existed)', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const creating = db
      .withTenant(admin, async (tx) => {
        await createStudent(tx, u);
        inside.open();
        await release.wait;
        throw new Rollback();
      })
      .catch(rolledBack);
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => grant(tx, u, 'FACULTY')));
    await waitUntilBlocked(LOCK);
    release.open();
    await creating;
    expect(await outcome).toBe('resolved');
    expect(await hasStudent(u)).toBe(false);
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['FACULTY']);
  });

  it('grant in flight that ROLLS BACK: the waiting student create then SUCCEEDS', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const granting = db
      .withTenant(admin, async (tx) => {
        await grant(tx, u, 'FACULTY');
        inside.open();
        await release.wait;
        throw new Rollback();
      })
      .catch(rolledBack);
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => createStudent(tx, u)));
    await waitUntilBlocked(LOCK);
    release.open();
    await granting;
    expect(await outcome).toBe('resolved');
    expect(await hasStudent(u)).toBe(true);
    expect(await assignmentsOf(u)).toEqual([]);
  });
});

describe('the STUDENT role against a student create', () => {
  it('a STUDENT grant waits for the in-flight student create and then SUCCEEDS', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const creating = db.withTenant(admin, async (tx) => {
      await createStudent(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => grant(tx, u, 'STUDENT')));
    await waitUntilBlocked(LOCK);
    release.open();
    await creating;
    expect(await outcome).toBe('resolved');
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['STUDENT']);
  });

  it('a STUDENT grant waiting on a student create that ROLLS BACK is then refused (409): there is no student', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const creating = db
      .withTenant(admin, async (tx) => {
        await createStudent(tx, u);
        inside.open();
        await release.wait;
        throw new Rollback();
      })
      .catch(rolledBack);
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => grant(tx, u, 'STUDENT')));
    await waitUntilBlocked(LOCK);
    release.open();
    await creating;
    expect(await outcome).toBe(409);
    expect(await assignmentsOf(u)).toEqual([]);
  });
});

describe('employee creation joins the same lock (no new eligibility rule)', () => {
  it('employee create in flight first: a FACULTY grant waits, then SUCCEEDS (an employee may hold staff roles)', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const employing = db.withTenant(admin, async (tx) => {
      await createEmployee(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => grant(tx, u, 'FACULTY')));
    await waitUntilBlocked(LOCK);
    release.open();
    await employing;
    expect(await outcome).toBe('resolved');
    expect(await hasEmployee(u)).toBe(true);
    expect((await assignmentsOf(u)).map((r) => r.code)).toEqual(['FACULTY']);
  });

  it('grant in flight first: the employee create waits, then SUCCEEDS', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const granting = db.withTenant(admin, async (tx) => {
      await grant(tx, u, 'FACULTY');
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => createEmployee(tx, u)));
    await waitUntilBlocked(LOCK);
    release.open();
    await granting;
    expect(await outcome).toBe('resolved');
    expect(await hasEmployee(u)).toBe(true);
  });

  it('employee create against an in-flight student create: refused (409), as before (0016), in both orders', async () => {
    for (const studentFirst of [true, false]) {
      const u = await newUser();
      const inside = gateOf();
      const release = gateOf();
      const first = db.withTenant(admin, async (tx) => {
        await (studentFirst ? createStudent(tx, u) : createEmployee(tx, u));
        inside.open();
        await release.wait;
      });
      await inside.wait;
      const second = statusOf(
        waiterDb.withTenant(admin, (tx): Promise<unknown> =>
          studentFirst ? createEmployee(tx, u) : createStudent(tx, u),
        ),
      );
      await waitUntilBlocked(LOCK);
      release.open();
      await first;
      expect(await second, String(studentFirst)).toBe(409);
      expect(await hasStudent(u)).toBe(studentFirst);
      expect(await hasEmployee(u)).toBe(!studentFirst);
    }
  });

  it('three writers for one account at once, repeated: no deadlock (40P01) and no 500 escapes; the invariant holds afterwards', async () => {
    for (let round = 0; round < 12; round++) {
      const u = await newUser();
      const settled = await Promise.allSettled([
        db.withTenant(admin, (tx) => createStudent(tx, u)),
        db.withTenant(admin, (tx) => createEmployee(tx, u)),
        db.withTenant(admin, (tx) => grant(tx, u, 'FACULTY')),
      ]);
      for (const r of settled) {
        if (r.status === 'rejected') {
          const e = r.reason as { code?: string; statusCode?: number };
          expect(e.code, `round ${round}`).not.toBe('40P01');
          expect(e.statusCode, `round ${round}: ${String(r.reason)}`).toBe(409);
        }
      }
      const student = await hasStudent(u);
      const employee = await hasEmployee(u);
      const staff = (await assignmentsOf(u)).length > 0;
      expect(student && employee, `round ${round}: student and employee`).toBe(false);
      expect(student && staff, `round ${round}: student and staff role`).toBe(false);
    }
  });
});

describe('privileged raw writers meet the same lock and the same predicate (migration 0020 trigger)', () => {
  it('a raw staff-role insert IN FLIGHT: the student create waits on the lock the TRIGGER took, then is refused (409)', async () => {
    const u = await newUser();
    const raw = await rawWriter();
    try {
      await rawAssignment(raw, u, 'FACULTY'); // trigger takes the person lock; uncommitted
      const outcome = statusOf(waiterDb.withTenant(admin, (tx) => createStudent(tx, u)));
      await waitUntilBlocked(LOCK);
      await raw.query('COMMIT');
      expect(await outcome).toBe(409);
    } finally {
      await raw.end();
    }
    expect(await hasStudent(u)).toBe(false);
  });

  it('a student create IN FLIGHT: a raw staff-role insert waits on the person lock and is then refused by the trigger (23P01 person_record_exclusive)', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const creating = db.withTenant(admin, async (tx) => {
      await createStudent(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const raw = await rawWriter(WAITER_APP);
    try {
      const attempt = sqlState(rawAssignment(raw, u, 'FACULTY'));
      await waitUntilBlocked('%INSERT INTO app.role_assignments%');
      release.open();
      await creating;
      expect(await attempt).toBe('23P01/person_record_exclusive');
    } finally {
      release.open();
      await raw.query('ROLLBACK').catch(() => undefined);
      await raw.end();
    }
    expect(await assignmentsOf(u)).toEqual([]);
  });
});

describe('predicate parity: engine SQL = trigger = preflight SQL of the rollout runbook', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runbook = readFileSync(
    join(here, '../../../docs/runbooks/students-contract-rollout.md'),
    'utf8',
  );
  const preflight = ((): string => {
    const section = runbook.slice(runbook.indexOf('## Person-identity preflight'));
    const m = /```sql\n([\s\S]*?)```/.exec(section);
    if (!m) throw new Error('the preflight SQL block is missing from the runbook');
    return m[1]!;
  })();

  const day = 86_400_000;
  const past = (n: number): string => new Date(Date.now() - n * day).toISOString();
  const future = (n: number): string => new Date(Date.now() + n * day).toISOString();
  // [label, role, options, expected to conflict]
  const matrix: [
    string,
    string,
    { status?: string; from?: string; until?: string | null },
    boolean,
  ][] = [
    ['active, open-ended', 'FACULTY', {}, true],
    ['active, window running', 'HOD', { from: past(2), until: future(2) }, true],
    ['future-dated, open-ended', 'FACULTY', { from: future(1) }, true],
    ['future-dated, with an end', 'FACULTY', { from: future(1), until: future(5) }, true],
    ['ended window', 'FACULTY', { from: past(3), until: past(1) }, false],
    ['revoked', 'FACULTY', { status: 'REVOKED' }, false],
    ['expired status', 'FACULTY', { status: 'EXPIRED' }, false],
    ['STUDENT, active', 'STUDENT', {}, false],
    ['STUDENT, future-dated', 'STUDENT', { from: future(1) }, false],
    ['STUDENT, ended', 'STUDENT', { from: past(3), until: past(1) }, false],
    ['unknown role code (fail closed)', 'XTEST_CUSTOM', {}, true],
  ];

  beforeAll(async () => {
    await adminQuery(
      `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, 'XTEST_CUSTOM', 'Custom test role')
       ON CONFLICT DO NOTHING`,
      [uuidv7(), T.orgId],
    );
  });

  it.each(matrix)(
    '%s',
    async (label, role, extra, conflicts) => {
      // 1. engine: the account has the assignment and NO student record
      const holder = await newUser();
      const setup = await rawWriter();
      await rawAssignment(setup, holder, role, extra);
      await setup.query('COMMIT');
      await setup.end();
      const engine = await db.withTenant(admin, (tx) =>
        AuthorizationEngine.hasStaffCapableAssignment(tx, T.orgId, holder),
      );
      expect(engine, `engine: ${label}`).toBe(conflicts);

      // 2. student-side trigger: creating the student record is refused iff the predicate holds
      const studentInsert = async (c: pg.Client, userId: string) =>
        c.query(
          `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
           VALUES ($1, $2, $3, $4, '2024-07-01', 'ADMITTED')`,
          [uuidv7(), T.orgId, userId, `PAR${RUN}-${++counter}`],
        );
      const probe = await rawWriter();
      const refused = await sqlState(studentInsert(probe, holder));
      await probe.query('ROLLBACK').catch(() => undefined);
      await probe.end();
      expect(refused, `student trigger: ${label}`).toBe(
        conflicts ? '23P01/person_record_exclusive' : undefined,
      );

      // 3. assignment-side trigger: on a student account the same row is refused iff the predicate holds
      const student = await newUser();
      await db.withTenant(admin, (tx) => createStudent(tx, student));
      const writer = await rawWriter();
      const refusedRow = await sqlState(rawAssignment(writer, student, role, extra));
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      expect(refusedRow, `assignment trigger: ${label}`).toBe(
        conflicts ? '23P01/person_record_exclusive' : undefined,
      );

      // 4. preflight: with the student record forced in (triggers off for this rolled-back transaction only)
      const pre = await rawWriter();
      try {
        await pre.query('SET LOCAL session_replication_role = replica');
        await studentInsert(pre, holder);
        const found = await pre.query(preflight);
        const mine = found.rows.filter((r: { user_id: string }) => r.user_id === holder);
        expect(mine.length > 0, `preflight: ${label}`).toBe(conflicts);
      } finally {
        await pre.query('ROLLBACK').catch(() => undefined);
        await pre.end();
      }
    },
    60_000,
  );

  it('valid_until REVIVAL: extending an ended staff window on a student account is refused by the trigger; shortening is not', async () => {
    const u = await newUser();
    await db.withTenant(admin, (tx) => createStudent(tx, u));
    const setup = await rawWriter();
    await rawAssignment(setup, u, 'FACULTY', { from: past(3), until: past(1) }); // ended: allowed
    await setup.query('COMMIT');
    await setup.end();

    const revive = await rawWriter();
    expect(
      await sqlState(
        revive.query(
          `UPDATE app.role_assignments SET valid_until = now() + interval '30 days'
            WHERE user_id = $1`,
          [u],
        ),
      ),
    ).toBe('23P01/person_record_exclusive');
    await revive.query('ROLLBACK').catch(() => undefined);
    await revive.end();

    const shorten = await rawWriter();
    expect(
      await sqlState(
        shorten.query(
          `UPDATE app.role_assignments SET valid_until = now() - interval '2 hours' WHERE user_id = $1`,
          [u],
        ),
      ),
    ).toBeUndefined();
    await shorten.query('ROLLBACK').catch(() => undefined);
    await shorten.end();
  });
});
