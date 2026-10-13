import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Database, type TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { StudentService } from '../../src/modules/students/student.service.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Service-level tests of StudentService.create against the shared disposable integration database: atomicity with the
// audit event and the idempotency claim, and the lock protocol against concurrent employee creation and role grants.
// Targets are accounts created here (unique ids); assertions look only at rows these tests created. Concurrency is
// synchronised with gates and by waiting until the second backend is observably blocked on a lock.

const RUN = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 8 });
const db = new Database(pool);
// The contender that is EXPECTED to block runs on its own pool with an application_name unique to this run, so
// waitUntilBlocked cannot be satisfied by a lock wait from another test file running concurrently on the same database.
const WAITER_APP = `it-student-waiter-${RUN}`;
const waiterDb = new Database(
  createPool({
    connectionString: inject('dbRuntimeUrl'),
    ssl: false,
    max: 4,
    applicationName: WAITER_APP,
  }),
);
const created: string[] = [];

// Tenant A is shared with files that assert it is untouched, so this file commits only to a private tenant.
let T!: IsolatedTenant;
let admin!: TrustedContext;
beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  admin = issueTrustedContext({ tenantId: T.orgId, userId: T.users.admin, actorKind: 'STAFF' });
});

async function newUser(): Promise<string> {
  const id = uuidv7();
  const email = `svc-${RUN.toLowerCase()}-${id.slice(-12)}@isolated.test`;
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

afterAll(async () => {
  await T.cleanup();
  await adminQuery('DELETE FROM app.students WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.employees WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.role_assignments WHERE user_id = ANY($1::uuid[])', [created]);
  await adminQuery('DELETE FROM app.users WHERE id = ANY($1::uuid[])', [created]).catch(
    () => undefined,
  );
  await adminQuery('DELETE FROM platform.identities WHERE id = ANY($1::uuid[])', [created]).catch(
    () => undefined,
  );
  await waiterDb.close();
  await db.close();
});

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

const keyOf = (): string => `svc-${RUN}-${randomUUID()}`.slice(0, 64);
const input = (userId: string) => ({
  userId,
  admissionNumber: `V${RUN}-${++counter}`,
  admissionDate: '2024-07-01',
  reason: 'Admitted after counselling',
});
const create = (tx: TenantTx, userId: string, key = keyOf()) =>
  StudentService.create(tx, admin, input(userId), { idempotencyKey: key });
const students = (userId: string) =>
  adminQuery('SELECT id FROM app.students WHERE user_id = $1', [userId]);
const statusOf = (p: Promise<unknown>): Promise<number | string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e as { statusCode?: number }).statusCode ?? 'other',
  );

class Rollback extends Error {}

describe('atomicity: student, audit event and idempotency claim commit or roll back together', () => {
  it('everything written by a create is undone when the surrounding transaction fails afterwards', async () => {
    const u = await newUser();
    const key = keyOf();
    let studentId = '';
    await db
      .withTenant(admin, async (tx) => {
        const r = await create(tx, u, key);
        studentId = (r.body['data'] as { id: string }).id;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(studentId).not.toBe('');
    expect(await students(u)).toEqual([]);
    expect(
      await adminQuery('SELECT 1 FROM app.audit_events WHERE resource_id = $1', [studentId]),
    ).toEqual([]);
    expect(await adminQuery('SELECT 1 FROM app.idempotency_keys WHERE key = $1', [key])).toEqual(
      [],
    );
  });

  it('a committed create leaves all three: the student, one audit event, one stored response', async () => {
    const u = await newUser();
    const key = keyOf();
    const r = await db.withTenant(admin, (tx) => create(tx, u, key));
    expect(r.status).toBe(201);
    const id = (r.body['data'] as { id: string }).id;
    expect(await students(u)).toEqual([{ id }]);
    expect(
      await adminQuery('SELECT 1 FROM app.audit_events WHERE resource_id = $1', [id]),
    ).toHaveLength(1);
    const [stored] = await adminQuery(
      'SELECT response_status, response_body FROM app.idempotency_keys WHERE key = $1',
      [key],
    );
    expect(stored).toEqual({ response_status: 201, response_body: r.body });
  });

  it('an audit failure rolls the whole create back (fail closed): no student, no claim', async () => {
    const u = await newUser();
    const key = keyOf();
    // The audit row is written with an invalid meta: recordAudit rejects it before touching the database.
    await expect(
      db.withTenant(admin, (tx) =>
        StudentService.create(tx, admin, input(u), {
          idempotencyKey: key,
          meta: { ip: 'not-an-ip' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUDIT_INVALID' });
    expect(await students(u)).toEqual([]);
    expect(await adminQuery('SELECT 1 FROM app.idempotency_keys WHERE key = $1', [key])).toEqual(
      [],
    );
  });
});

describe('concurrency with employee creation (account lock, then migration 0016 guard)', () => {
  it('employee create in flight first: the student create waits, then is refused (409) and creates nothing', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const employee = db.withTenant(admin, async (tx) => {
      await EmployeeService.create(tx, admin, {
        userId: u,
        employeeCode: `EC${RUN}-${++counter}`,
        employeeType: 'STAFF',
        joiningDate: '2024-01-01',
        reason: 'Onboarding for race test',
      });
      inside.open();
      await release.wait;
    });
    await inside.wait; // the employee exists, uncommitted, and holds a share lock on the account
    const student = waiterDb.withTenant(admin, (tx) => create(tx, u));
    const outcome = statusOf(student);
    await waitUntilBlocked('%FROM app.users%FOR UPDATE%');
    release.open();
    await employee;
    expect(await outcome).toBe(409);
    expect(await students(u)).toEqual([]);
    expect(await adminQuery('SELECT 1 FROM app.employees WHERE user_id = $1', [u])).toHaveLength(1);
  });

  it('student create in flight first: the employee create waits, then is refused (409) and creates nothing', async () => {
    const u = await newUser();
    const inside = gateOf();
    const release = gateOf();
    const student = db.withTenant(admin, async (tx) => {
      await create(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait;
    const employee = waiterDb.withTenant(admin, (tx) =>
      EmployeeService.create(tx, admin, {
        userId: u,
        employeeCode: `EC${RUN}-${++counter}`,
        employeeType: 'STAFF',
        joiningDate: '2024-01-01',
        reason: 'Onboarding for race test',
      }),
    );
    const outcome = statusOf(employee);
    await waitUntilBlocked('%FROM app.users%FOR SHARE%');
    release.open();
    await student;
    expect(await outcome).toBe(409);
    expect(await students(u)).toHaveLength(1);
    expect(await adminQuery('SELECT 1 FROM app.employees WHERE user_id = $1', [u])).toEqual([]);
  });
});

describe('concurrency with a role grant (the real RoleAssignmentService.grant)', () => {
  const facultyRole = async (): Promise<string> =>
    (
      await adminQuery<{ id: string }>(
        "SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'FACULTY'",
        [T.orgId],
      )
    )[0]!.id;
  const grant = (tx: TenantTx, userId: string, roleId: string) =>
    RoleAssignmentService.grant(tx, admin, {
      targetUserId: userId,
      roleId,
      scopeType: 'ORGANIZATION',
      reason: 'Granting for the concurrency test',
    });

  it('a grant IN FLIGHT (inserted, uncommitted) when the student create starts: the create waits for it, sees it once committed, and is refused (409)', async () => {
    const u = await newUser();
    const roleId = await facultyRole();
    const inside = gateOf();
    const release = gateOf();
    const granting = db.withTenant(admin, async (tx) => {
      await grant(tx, u, roleId);
      inside.open();
      await release.wait;
    });
    await inside.wait; // the assignment row exists, uncommitted, and holds the foreign key's share-key lock on the account
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => create(tx, u)));
    await waitUntilBlocked('%FROM app.users%FOR UPDATE%');
    release.open();
    await granting;
    expect(await outcome).toBe(409);
    expect(await students(u)).toEqual([]);
    expect(
      await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [u]),
    ).toHaveLength(1);
  });

  it('a grant in flight that ROLLS BACK does not block the student create', async () => {
    const u = await newUser();
    const roleId = await facultyRole();
    const inside = gateOf();
    const release = gateOf();
    const granting = db
      .withTenant(admin, async (tx) => {
        await grant(tx, u, roleId);
        inside.open();
        await release.wait;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    await inside.wait;
    const outcome = statusOf(waiterDb.withTenant(admin, (tx) => create(tx, u)));
    await waitUntilBlocked('%FROM app.users%FOR UPDATE%');
    release.open();
    await granting;
    expect(await outcome).toBe('resolved');
    expect(await students(u)).toHaveLength(1);
  });

  it('a grant that COMMITTED before the create starts is refused by the check (409), whatever its scope', async () => {
    const u = await newUser();
    await db.withTenant(admin, async (tx) => grant(tx, u, await facultyRole()));
    expect(await statusOf(db.withTenant(admin, (tx) => create(tx, u)))).toBe(409);
    expect(await students(u)).toEqual([]);
  });

  it('two creates for the SAME account with DIFFERENT keys: exactly one student; the other request is a 409 and caches nothing', async () => {
    const u = await newUser();
    const keys = [keyOf(), keyOf()];
    const results = await Promise.allSettled(
      keys.map((k) => db.withTenant(admin, (tx) => create(tx, u, k))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect((lost as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(await students(u)).toHaveLength(1);
    const claims = await adminQuery(
      'SELECT key FROM app.idempotency_keys WHERE key = ANY($1::text[])',
      [keys],
    );
    expect(claims).toHaveLength(1); // only the winner's key is stored
  });

  // KNOWN, UNRESOLVED RACE (docs/architecture/v3/21-students.md §6): the student create only protects its own side.
  // RoleAssignmentService.grant reads the user without a lock and takes its foreign-key share-key lock at the very
  // end, so a grant that starts after a student create has begun is NOT refused: it waits, then commits. This test
  // pins the CURRENT behaviour so that a future fix (a lock plus a student-record check in the role-grant service,
  // which needs its own design decision) has to change it deliberately.
  it('KNOWN GAP: a grant that starts while a student create is in flight waits for it and then LANDS on the new student account', async () => {
    const u = await newUser();
    const roleId = await facultyRole();
    const inside = gateOf();
    const release = gateOf();
    const creating = db.withTenant(admin, async (tx) => {
      await create(tx, u);
      inside.open();
      await release.wait;
    });
    await inside.wait; // the student exists, uncommitted, and holds FOR UPDATE on the account
    const granting = waiterDb.withTenant(admin, (tx) => grant(tx, u, roleId));
    const outcome = statusOf(granting);
    await waitUntilBlocked('%INSERT INTO app.role_assignments%');
    release.open();
    await creating;
    expect(await outcome).toBe('resolved'); // the gap: nothing refuses the grant
    expect(await students(u)).toHaveLength(1);
    expect(
      await adminQuery(
        "SELECT 1 FROM app.role_assignments WHERE user_id = $1 AND status = 'ACTIVE'",
        [u],
      ),
    ).toHaveLength(1);
  });
});
