import { afterAll, describe, expect, inject, it } from 'vitest';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  CTX,
  ORG_A,
  ORG_B,
  STAFF_A,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
} from '../support/fixtures.js';
import { withRuntimeClient } from '../support/db-harness.js';

// max = 1 puts every request on the SAME physical connection: the worst case for context leakage.
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 1 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

const issue = (c: (typeof CTX)[keyof typeof CTX]) =>
  issueTrustedContext({ tenantId: c.tenant, userId: c.user, actorKind: c.kind });
const staffA = issue(CTX.staffA);
const studentA = issue(CTX.studentA);
const staffB = issue(CTX.staffB);

interface Seen {
  t: string | null;
  u: string | null;
  k: string | null;
  pid: number;
}
/** What a brand-new, context-less user of this pooled connection would see. */
const rawContext = async (): Promise<Seen> => {
  const r = await pool.query<Seen>(
    `SELECT NULLIF(current_setting('app.tenant_id', true), '')  AS t,
            NULLIF(current_setting('app.user_id', true), '')    AS u,
            NULLIF(current_setting('app.actor_kind', true), '') AS k,
            pg_backend_pid() AS pid`,
  );
  return r.rows[0] as Seen;
};
const rawStudentCount = async (): Promise<number> =>
  Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM app.students')).rows[0]?.n);

describe('Connection pool isolation — Invariant D', () => {
  it('[21] Request A establishes Tenant A context', async () => {
    const seen = await db.withTenant(staffA, async (tx) => {
      const ctx = await tx.query<{ t: string; pid: number }>(
        'SELECT app.current_tenant_id() AS t, pg_backend_pid() AS pid',
      );
      const rows = await tx.query<{ id: string }>('SELECT id FROM app.students');
      return { ctx: ctx.rows[0], ids: rows.rows.map((r) => r.id).sort() };
    });
    expect(seen.ctx?.t).toBe(ORG_A);
    expect(seen.ids).toEqual([STUDENT_A, STUDENT_B].sort());
  });

  it('[22-25] connection returns to the pool; Request B gets the SAME connection and inherits nothing', async () => {
    // [21] Request A
    const a = await db.withTenant(staffA, async (tx) => {
      const r = await tx.query<{ pid: number; n: number }>(
        'SELECT pg_backend_pid() AS pid, count(*)::int AS n FROM app.students',
      );
      return r.rows[0] as { pid: number; n: number };
    });
    expect(a.n).toBe(2);

    // [22] the connection is back in the pool and [25] its context was cleared automatically
    const between = await rawContext();
    expect(between.pid).toBe(a.pid); // [23] the very same backend process is handed out again
    expect(between).toMatchObject({ t: null, u: null, k: null });
    // [24] and without a context of its own it can read nothing
    expect(await rawStudentCount()).toBe(0);

    // [23-24] Request B (a different tenant) on that same connection
    const b = await db.withTenant(staffB, async (tx) => {
      const r = await tx.query<{ pid: number; t: string }>(
        'SELECT pg_backend_pid() AS pid, app.current_tenant_id() AS t',
      );
      const ids = await tx.query<{ id: string }>('SELECT id FROM app.students');
      const a2 = await tx.query<{ id: string }>(
        'SELECT id FROM app.students WHERE organization_id = $1',
        [ORG_A],
      );
      return {
        pid: r.rows[0]?.pid,
        t: r.rows[0]?.t,
        ids: ids.rows.map((x) => x.id),
        leaked: a2.rows,
      };
    });
    expect(b.pid).toBe(a.pid);
    expect(b.t).toBe(ORG_B);
    expect(b.ids).toEqual([STUDENT_C]);
    expect(b.leaked).toEqual([]);

    expect(await rawContext()).toMatchObject({ t: null, u: null, k: null });
  });

  it('context is transaction-local: gone after COMMIT and after ROLLBACK (raw proof)', async () => {
    await withRuntimeClient(async (c) => {
      for (const end of ['COMMIT', 'ROLLBACK']) {
        await c.query('BEGIN');
        await c.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', 'STAFF', true)",
          [ORG_A, STAFF_A],
        );
        const inside = await c.query("SELECT current_setting('app.tenant_id') AS t");
        expect(inside.rows[0]).toEqual({ t: ORG_A });
        await c.query(end);
        const after = await c.query(
          "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS t, NULLIF(current_setting('app.user_id', true), '') AS u",
        );
        expect(after.rows[0], `after ${end}`).toEqual({ t: null, u: null });
        const n = await c.query('SELECT count(*)::int AS n FROM app.students');
        expect(n.rows[0], `rows visible after ${end}`).toEqual({ n: 0 });
      }
    });
  });

  it('an error inside the work rolls back, clears the context and leaves the connection healthy', async () => {
    const pidBefore = (await rawContext()).pid;
    await expect(
      db.withTenant(staffA, async (tx) => {
        await tx.query("UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1", [STUDENT_A]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await rawContext()).toMatchObject({ pid: pidBefore, t: null, u: null, k: null });
    const status = await db.withTenant(
      staffA,
      async (tx) =>
        (
          await tx.query<{ status: string }>('SELECT status FROM app.students WHERE id = $1', [
            STUDENT_A,
          ])
        ).rows[0]?.status,
    );
    expect(status).toBe('ACTIVE'); // the update was rolled back
  });

  it('a failing SQL statement inside the work also leaves no context behind', async () => {
    await expect(
      db.withTenant(staffA, (tx) => tx.query('SELECT * FROM app.no_such_table')),
    ).rejects.toThrow();
    expect(await rawContext()).toMatchObject({ t: null, u: null, k: null });
    expect(await rawStudentCount()).toBe(0);
  });

  it('a student request after a staff request on the same connection is still restricted to that student', async () => {
    const staffRows = await db.withTenant(
      staffA,
      async (tx) => (await tx.query('SELECT id FROM app.students')).rowCount,
    );
    expect(staffRows).toBe(2);
    const studentRows = await db.withTenant(studentA, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM app.students')).rows.map((r) => r.id),
    );
    expect(studentRows).toEqual([STUDENT_A]);
  });

  it("stress: 90 interleaved requests over a small pool never see another request's context or rows", async () => {
    const smallPool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 3 });
    const sdb = new Database(smallPool);
    try {
      const plan = [
        { ctx: staffA, expect: [STUDENT_A, STUDENT_B].sort(), tenant: ORG_A },
        { ctx: studentA, expect: [STUDENT_A], tenant: ORG_A },
        { ctx: staffB, expect: [STUDENT_C], tenant: ORG_B },
      ];
      const results = await Promise.all(
        Array.from({ length: 90 }, async (_v, i) => {
          const p = plan[i % 3] as (typeof plan)[number];
          return sdb.withTenant(p.ctx, async (tx) => {
            await tx.query('SELECT 1'); // yield to the event loop so requests interleave
            const t = await tx.query<{ t: string }>('SELECT app.current_tenant_id() AS t');
            const ids = await tx.query<{ id: string }>('SELECT id FROM app.students');
            return { want: p, tenant: t.rows[0]?.t, ids: ids.rows.map((r) => r.id).sort() };
          });
        }),
      );
      for (const r of results) {
        expect(r.tenant).toBe(r.want.tenant);
        expect(r.ids).toEqual(r.want.expect);
      }
    } finally {
      await sdb.close();
    }
  });

  it('even a poisoned SESSION-level setting on a pooled connection cannot override the trusted transaction context', async () => {
    // This is what a bug (or injection) using set_config(..., false) would do. TenantTx refuses to run such SQL;
    // here we do it on the raw pool to prove that, even then, withTenant() writes its own transaction-local values.
    await pool.query(
      "SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false), set_config('app.actor_kind', 'STAFF', false)",
      [ORG_A, STAFF_A],
    );
    try {
      const seen = await db.withTenant(staffB, async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM app.students')).rows.map((r) => r.id),
      );
      expect(seen).toEqual([STUDENT_C]);
    } finally {
      await pool.query('RESET ALL'); // clean the poisoned connection for the remaining tests
    }
    expect(await rawContext()).toMatchObject({ t: null, u: null, k: null });
  });
});
