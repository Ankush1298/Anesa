import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, GRANTEE_A, ORG_A, TEMP_A } from '../support/fixtures.js';

// Grant versus deactivation / soft delete, with TWO real connections. A dedicated campus and department are
// created (and removed) here, because these tests COMMIT status changes and must not disturb other files.
const LCK_CAMPUS = '01939a00-0000-7000-8000-00000000ca77';
const LCK_DEPT = '01939a00-0000-7000-8000-00000000de77';
const REASON = 'Concurrency test grant';

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 6 });
const db = new Database(pool);
const ctx = issueTrustedContext({ tenantId: ORG_A, userId: CTX.staffA.user, actorKind: 'STAFF' });

beforeAll(async () => {
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Lock campus', 'LCK', 'UTC')`,
    [LCK_CAMPUS, ORG_A],
  );
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Lock dept', 'LCKD')`,
    [LCK_DEPT, ORG_A, LCK_CAMPUS],
  );
});
afterAll(async () => {
  await adminQuery('DELETE FROM app.role_assignments WHERE scope_id = ANY($1::uuid[])', [
    [LCK_CAMPUS, LCK_DEPT],
  ]);
  await adminQuery('DELETE FROM app.departments WHERE id = $1', [LCK_DEPT]);
  await adminQuery('DELETE FROM app.campuses WHERE id = $1', [LCK_CAMPUS]);
  await db.close();
});
const reset = async (): Promise<void> => {
  await adminQuery(`UPDATE app.campuses SET status = 'ACTIVE' WHERE id = $1`, [LCK_CAMPUS]);
  await adminQuery(
    `UPDATE app.departments SET status = 'ACTIVE', deleted_at = NULL WHERE id = $1`,
    [LCK_DEPT],
  );
  await adminQuery('DELETE FROM app.role_assignments WHERE scope_id = ANY($1::uuid[])', [
    [LCK_CAMPUS, LCK_DEPT],
  ]);
};

class Rollback extends Error {}
const gateOf = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
const roleId = async (tx: TenantTx, code: string): Promise<string> =>
  (await tx.query<{ id: string }>('SELECT id FROM app.roles WHERE code = $1', [code])).rows[0]!.id;
const grant = async (
  tx: TenantTx,
  user: string,
  scope: 'CAMPUS' | 'DEPARTMENT',
  id: string,
): Promise<string> =>
  RoleAssignmentService.grant(tx, ctx, {
    targetUserId: user,
    roleId: await roleId(tx, scope === 'CAMPUS' ? 'STAFF' : 'HOD'),
    scopeType: scope,
    scopeId: id,
    reason: REASON,
  });
const code = (p: Promise<unknown>): Promise<number | 'ok' | 'other'> =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.statusCode : 'other'),
  );

/** Polls pg_stat_activity until a backend is waiting on a lock in a statement matching `like`. */
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
const settled = <T>(p: Promise<T>): { done: () => boolean } => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  return { done: () => done };
};

/** A deactivation transaction that holds its row locks until `release` opens, then commits. */
function deactivate(
  statements: readonly string[],
  held: { open: () => void },
  release: Promise<void>,
): Promise<void> {
  return db.withTenant(ctx, async (tx) => {
    for (const sql of statements) await tx.query(sql, []);
    held.open();
    await release;
  });
}
const CAMPUS_OFF = `UPDATE app.campuses SET status = 'INACTIVE' WHERE id = '${LCK_CAMPUS}'`;
const DEPT_OFF = `UPDATE app.departments SET status = 'INACTIVE' WHERE id = '${LCK_DEPT}'`;
const DEPT_DELETE = `UPDATE app.departments SET deleted_at = now() WHERE id = '${LCK_DEPT}'`;

describe('grant vs deactivation: the grant takes its locks first', () => {
  it.each([
    ['campus', 'CAMPUS' as const, LCK_CAMPUS, [CAMPUS_OFF]],
    [
      'department (campus-first deactivation)',
      'DEPARTMENT' as const,
      LCK_DEPT,
      [CAMPUS_OFF, DEPT_OFF],
    ],
    ['department (soft delete)', 'DEPARTMENT' as const, LCK_DEPT, [DEPT_DELETE]],
  ])(
    '%s: the deactivation waits for the grant, then both complete (no deadlock)',
    async (_n, scope, id, statements) => {
      await reset();
      const granted = gateOf();
      const release = gateOf();
      const A = db
        .withTenant(ctx, async (tx) => {
          await grant(tx, GRANTEE_A, scope, id);
          granted.open();
          await release.wait;
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
      await granted.wait;
      const B = db.withTenant(ctx, async (tx) => {
        for (const sql of statements) await tx.query(sql, []);
      });
      const b = settled(B);
      await waitUntilBlocked('UPDATE app.%');
      expect(b.done()).toBe(false); // genuinely waiting on the grant's lock
      release.open();
      await A;
      await B; // completes: a deadlock would reject with 40P01 (or hang past the test timeout)
      const rows = await adminQuery<{ status: string }>(
        `SELECT status FROM app.campuses WHERE id = $1`,
        [LCK_CAMPUS],
      );
      expect(rows[0]?.status).toBe(statements.includes(CAMPUS_OFF) ? 'INACTIVE' : 'ACTIVE');
      await reset();
    },
  );
});

describe('grant vs deactivation: the deactivation commits first', () => {
  it.each([
    ['campus', 'CAMPUS' as const, LCK_CAMPUS, [CAMPUS_OFF]],
    [
      'department (campus-first deactivation)',
      'DEPARTMENT' as const,
      LCK_DEPT,
      [CAMPUS_OFF, DEPT_OFF],
    ],
    ['department (inactive)', 'DEPARTMENT' as const, LCK_DEPT, [DEPT_OFF]],
    [
      'department (soft delete: stale unlocked read, caught by the second lock)',
      'DEPARTMENT' as const,
      LCK_DEPT,
      [DEPT_DELETE],
    ],
  ])(
    '%s: the waiting grant re-checks and is refused with 404; nothing is written',
    async (_n, scope, id, statements) => {
      await reset();
      const held = gateOf();
      const release = gateOf();
      const D = deactivate(statements, held, release.wait);
      await held.wait;
      // NOT rolled back: if an invalid grant were possible it would be COMMITTED and found below.
      const G = code(db.withTenant(ctx, (tx) => grant(tx, GRANTEE_A, scope, id)));
      await waitUntilBlocked('%FOR SHARE%');
      release.open();
      await D;
      expect(await G).toBe(404);
      const rows = await adminQuery(
        'SELECT 1 FROM app.role_assignments WHERE scope_id = ANY($1::uuid[])',
        [[LCK_CAMPUS, LCK_DEPT]],
      );
      expect(rows).toEqual([]);
      await reset();
    },
  );
});

describe('grant vs grant, and what deactivation leaves alone', () => {
  it('two overlapping grants on the same scope do not block each other', async () => {
    await reset();
    const first = gateOf();
    const release = gateOf();
    const A = db
      .withTenant(ctx, async (tx) => {
        await grant(tx, GRANTEE_A, 'DEPARTMENT', LCK_DEPT);
        first.open();
        await release.wait;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    await first.wait;
    // completes while A still holds its locks (and rolls back)
    await db
      .withTenant(ctx, async (tx) => {
        await grant(tx, TEMP_A, 'DEPARTMENT', LCK_DEPT);
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    release.open();
    await A;
  });

  it('a committed grant survives a later deactivation, and revoking it still works afterwards', async () => {
    await reset();
    const id = await db.withTenant(ctx, (tx) => grant(tx, GRANTEE_A, 'CAMPUS', LCK_CAMPUS));
    await db.withTenant(ctx, async (tx) => {
      await tx.query(CAMPUS_OFF, []);
    });
    const kept = await adminQuery<{ status: string }>(
      'SELECT status FROM app.role_assignments WHERE id = $1',
      [id],
    );
    expect(kept[0]?.status).toBe('ACTIVE'); // existing assignments are not touched
    await db.withTenant(ctx, (tx) => RoleAssignmentService.revoke(tx, ctx, id, REASON));
    const gone = await adminQuery<{ status: string }>(
      'SELECT status FROM app.role_assignments WHERE id = $1',
      [id],
    );
    expect(gone[0]?.status).toBe('REVOKED');
    expect(await code(db.withTenant(ctx, (tx) => grant(tx, GRANTEE_A, 'CAMPUS', LCK_CAMPUS)))).toBe(
      404,
    );
    await reset();
  });
});
