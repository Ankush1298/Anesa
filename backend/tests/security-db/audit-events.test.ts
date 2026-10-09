import { describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';
import { CTX, ORG_A, ORG_B, STAFF_A, STAFF_B, USER_A, STUDENT_A } from '../support/fixtures.js';

// Layer-2 proofs for app.audit_events (migration 0007), exercised with raw SQL and no application
// code. Rows written by admin helpers are inside transactions that are ALWAYS rolled back.
const ID = (n: number): string => `01939a00-0000-7000-8000-00000000f${String(n).padStart(3, '0')}`;
const COLS = `(id, organization_id, actor_type, actor_user_id, action, resource_type, risk_tier)`;
const insertRow = (id: string, org: string, actor: string, actorType = 'USER'): string =>
  `INSERT INTO app.audit_events ${COLS} VALUES ('${id}', '${org}', '${actorType}', ${actor === 'NULL' ? 'NULL' : `'${actor}'`}, 'role.assignment.grant', 'role_assignment', 2)`;

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const code = async (c: pg.Client, sql: string, params: unknown[] = []): Promise<string> => {
  await c.query('SAVEPOINT s');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT s');
    return 'OK';
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return `${(e as { code?: string }).code ?? '?'}:${(e as Error).message}`;
  }
};

describe('structure: monthly range partitions, composite primary key, fail-closed coverage', () => {
  it('the parent is a RANGE-partitioned table on occurred_at with PRIMARY KEY (id, occurred_at)', async () => {
    const [p] = await adminQuery<{ relkind: string; strat: string; key: string[] }>(
      `SELECT c.relkind, pt.partstrat AS strat,
              ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = pt.partrelid AND a.attnum = ANY (pt.partattrs)) AS key
         FROM pg_class c JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
        WHERE c.oid = 'app.audit_events'::regclass`,
    );
    expect(p).toEqual({ relkind: 'p', strat: 'r', key: ['occurred_at'] });
    const pk = await adminQuery<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = 'app.audit_events'::regclass AND i.indisprimary ORDER BY a.attname`,
    );
    expect(pk.map((r) => r.attname)).toEqual(['id', 'occurred_at']);
  });

  it('27 contiguous monthly partitions 2026-10..2028-12 exist and there is NO default partition', async () => {
    const parts = await adminQuery<{ relname: string; bound: string }>(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'app.audit_events'::regclass ORDER BY 1`,
    );
    expect(parts).toHaveLength(27);
    expect(parts.some((p) => /DEFAULT/.test(p.bound))).toBe(false);
    const expected: string[] = [];
    for (let y = 2026, m = 10; y < 2028 || m <= 12; m++) {
      if (m === 13) {
        y++;
        m = 1;
      }
      expected.push(`audit_events_${y}_${String(m).padStart(2, '0')}`);
      if (y === 2028 && m === 12) break;
    }
    expect(parts.map((p) => p.relname)).toEqual(expected);
  });

  it('every partition: owned by app_migrator, RLS enabled and forced, append-only trigger inherited, no grants to anyone', async () => {
    const rows = await adminQuery<{
      relname: string;
      owner: string;
      rls: boolean;
      forced: boolean;
      trig: number;
      acl: string | null;
    }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_events_immutable' AND NOT t.tgisinternal) AS trig,
              c.relacl::text AS acl
         FROM pg_class c WHERE c.relkind = 'r' AND c.relispartition AND c.relnamespace = 'app'::regnamespace AND c.relname LIKE 'audit_events\\_%'`,
    );
    expect(rows).toHaveLength(27);
    for (const r of rows) {
      expect(r, r.relname).toMatchObject({
        owner: 'app_migrator',
        rls: true,
        forced: true,
        trig: 1,
      });
      expect(r.acl, `${r.relname} must carry no explicit grants`).toBeNull();
    }
    const [parent] = await adminQuery<{ rls: boolean; forced: boolean; owner: string }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'app.audit_events'::regclass`,
    );
    expect(parent).toEqual({ rls: true, forced: true, owner: 'app_migrator' });
  });

  it('TRIPWIRE: partitions exist at least 3 months ahead (add a new partition migration before this fails)', async () => {
    const [r] = await adminQuery<{ ok: boolean; last: string }>(
      `SELECT max(substring(c.relname FROM '(\\d{4}_\\d{2})$')) AS last,
              max(to_date(substring(c.relname FROM '(\\d{4}_\\d{2})$'), 'YYYY_MM')) >=
                (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months')::date AS ok
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'app.audit_events'::regclass`,
    );
    expect(
      r?.ok,
      `last provisioned audit partition is ${r?.last}; add the next months with a NEW migration (docs/architecture/v3/17-audit-foundation.md)`,
    ).toBe(true);
  });
});

describe('partition routing (UTC month boundaries) and out-of-range behaviour', () => {
  const route = (c: pg.Client, ts: string): Promise<string> =>
    c
      .query<{ t: string }>(
        `INSERT INTO app.audit_events ${COLS.replace(')', ', occurred_at)')}
         VALUES ('${ID(1)}', '${ORG_A}', 'USER', '${STAFF_A}', 'role.assignment.grant', 'role_assignment', 2, $1::timestamptz)
         RETURNING tableoid::regclass::text AS t`,
        [ts],
      )
      .then((r) => r.rows[0]!.t);

  it('rows land in the partition of their UTC month, inclusive lower bound / exclusive upper bound, regardless of the session time zone', async () => {
    await withAdmin(async (c) => {
      await c.query("SET LOCAL timezone = 'Asia/Kolkata'");
      expect(await route(c, '2026-10-15 12:00:00+00')).toBe('app.audit_events_2026_10');
      expect(await route(c, '2026-10-01 00:00:00+00')).toBe('app.audit_events_2026_10');
      expect(await route(c, '2026-10-31 23:59:59.999999+00')).toBe('app.audit_events_2026_10');
      expect(await route(c, '2026-11-01 00:00:00+00')).toBe('app.audit_events_2026_11');
      // 05:29:59 IST on 1 Nov is still 31 Oct in UTC: the boundary is UTC, not the session zone
      expect(await route(c, '2026-11-01 05:29:59+05:30')).toBe('app.audit_events_2026_10');
      expect(await route(c, '2028-12-31 23:59:59+00')).toBe('app.audit_events_2028_12');
    });
  });

  it('every one of the 27 months routes to its own partition at both edges', async () => {
    await withAdmin(async (c) => {
      for (let i = 0; i < 27; i++) {
        const y = 2026 + Math.floor((9 + i) / 12);
        const m = ((9 + i) % 12) + 1;
        const mm = String(m).padStart(2, '0');
        const lastMs = new Date(Date.UTC(y, m, 1) - 1).toISOString(); // last millisecond of the month (UTC)
        expect(await route(c, `${y}-${mm}-01 00:00:00+00`)).toBe(`app.audit_events_${y}_${mm}`);
        expect(await route(c, lastMs)).toBe(`app.audit_events_${y}_${mm}`);
      }
    });
  });

  it('a timestamp OUTSIDE the provisioned months is REJECTED (23514, no partition), never stored or parked', async () => {
    await withAdmin(async (c) => {
      for (const ts of [
        '2026-09-30 23:59:59.999999+00',
        '2029-01-01 00:00:00+00',
        '1999-01-01 00:00:00+00',
        '2100-06-01 00:00:00+00',
      ]) {
        const res = await code(
          c,
          `INSERT INTO app.audit_events ${COLS.replace(')', ', occurred_at)')}
           VALUES ('${ID(2)}', '${ORG_A}', 'USER', '${STAFF_A}', 'role.assignment.grant', 'role_assignment', 2, '${ts}')`,
        );
        expect(res, ts).toMatch(/^23514:.*no partition of relation/);
      }
      const n = await c.query('SELECT count(*)::int AS n FROM app.audit_events WHERE id = $1', [
        ID(2),
      ]);
      expect(n.rows[0]).toEqual({ n: 0 });
    });
  });

  it('the primary key is (id, occurred_at): the same id may not be inserted twice in the same instant', async () => {
    await withAdmin(async (c) => {
      const ins = `INSERT INTO app.audit_events ${COLS.replace(')', ', occurred_at)')} VALUES ('${ID(3)}', '${ORG_A}', 'USER', '${STAFF_A}', 'role.assignment.grant', 'role_assignment', 2, '2026-10-15 00:00:00+00')`;
      expect(await code(c, ins)).toBe('OK');
      expect(await code(c, ins)).toMatch(/^23505:/);
    });
  });
});

describe('append-only: no role can change or remove an audit row', () => {
  it('UPDATE and DELETE are rejected for the superuser too (trigger), on the parent and on a partition directly', async () => {
    await withAdmin(async (c) => {
      await c.query(insertRow(ID(10), ORG_A, STAFF_A));
      for (const sql of [
        `UPDATE app.audit_events SET risk_tier = 3 WHERE id = '${ID(10)}'`,
        `UPDATE app.audit_events SET reason_text = 'rewritten' WHERE id = '${ID(10)}'`,
        `DELETE FROM app.audit_events WHERE id = '${ID(10)}'`,
        `UPDATE app.audit_events_2026_10 SET risk_tier = 3 WHERE id = '${ID(10)}'`,
        `DELETE FROM app.audit_events_2026_10 WHERE id = '${ID(10)}'`,
        // moving a row between partitions is an UPDATE too
        `UPDATE app.audit_events SET occurred_at = '2026-11-15 00:00:00+00' WHERE id = '${ID(10)}'`,
      ]) {
        expect(await code(c, sql), sql).toMatch(/^23001:.*append-only/);
      }
      const still = await c.query('SELECT risk_tier FROM app.audit_events WHERE id = $1', [ID(10)]);
      expect(still.rows).toEqual([{ risk_tier: 2 }]);
    });
  });

  it('the schema owner (app_migrator) sees no audit rows and its writes are refused or no-ops (FORCE RLS + trigger)', async () => {
    await withAdmin(async (c) => {
      await c.query(insertRow(ID(11), ORG_A, STAFF_A));
    });
    const owner = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM app.audit_events')).rows[0],
      ).toEqual({ n: 0 });
      const del = await owner.query('DELETE FROM app.audit_events');
      expect(del.rowCount).toBe(0);
      await owner.query('ROLLBACK');
    } finally {
      await owner.end();
    }
  });
});

describe('runtime role privileges: INSERT on a fixed column list, nothing else', () => {
  const allowed = [
    'id',
    'organization_id',
    'actor_type',
    'actor_user_id',
    'on_behalf_of_user_id',
    'session_id',
    'request_id',
    'ip',
    'user_agent',
    'action',
    'resource_type',
    'resource_id',
    'subject_student_id',
    'campus_id',
    'department_id',
    'risk_tier',
    'changes',
    'reason_code',
    'reason_text',
    'metadata',
  ];

  it('column-level privileges: INSERT only on the listed columns; occurred_at (server clock) is NOT insertable; no SELECT/UPDATE/REFERENCES anywhere', async () => {
    const cols = await adminQuery<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'app.audit_events'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    );
    expect(cols.map((c) => c.attname).sort()).toEqual([...allowed, 'occurred_at'].sort());
    for (const { attname } of cols) {
      const [r] = await adminQuery<Record<string, boolean>>(
        `SELECT has_column_privilege('app_runtime', 'app.audit_events', $1, 'INSERT') AS ins,
                has_column_privilege('app_runtime', 'app.audit_events', $1, 'SELECT') AS sel,
                has_column_privilege('app_runtime', 'app.audit_events', $1, 'UPDATE') AS upd,
                has_column_privilege('app_runtime', 'app.audit_events', $1, 'REFERENCES') AS refs`,
        [attname],
      );
      expect(r, attname).toEqual({
        ins: attname !== 'occurred_at',
        sel: false,
        upd: false,
        refs: false,
      });
    }
    const [t] = await adminQuery<Record<string, boolean>>(
      `SELECT has_table_privilege('app_runtime','app.audit_events','SELECT') AS sel,
              has_table_privilege('app_runtime','app.audit_events','UPDATE') AS upd,
              has_table_privilege('app_runtime','app.audit_events','DELETE') AS del,
              has_table_privilege('app_runtime','app.audit_events','TRUNCATE') AS trunc,
              has_table_privilege('app_runtime','app.audit_events','TRIGGER') AS trig`,
    );
    expect(t).toEqual({ sel: false, upd: false, del: false, trunc: false, trig: false });
  });

  it('the runtime role has no privilege at all on any partition, and nothing is granted to PUBLIC', async () => {
    const rows = await adminQuery<{ relname: string; any_priv: boolean }>(
      `SELECT c.relname,
              has_table_privilege('app_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any_priv
         FROM pg_class c WHERE c.relkind = 'r' AND c.relispartition AND c.relnamespace = 'app'::regnamespace AND c.relname LIKE 'audit_events\\_%'`,
    );
    expect(rows).toHaveLength(27);
    expect(rows.filter((r) => r.any_priv)).toEqual([]);
    const pub = await adminQuery(
      `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'app' AND table_name LIKE 'audit_events%' AND grantee = 'PUBLIC'`,
    );
    expect(pub).toEqual([]);
    const direct = await runAs(
      CTX.staffA,
      insertRow(ID(20), ORG_A, STAFF_A).replace('app.audit_events', 'app.audit_events_2026_10'),
    );
    expect(direct.error?.code).toBe('42501');
  });

  it('runtime cannot SELECT / UPDATE / DELETE / TRUNCATE (permission denied), even with a valid context', async () => {
    for (const sql of [
      'SELECT count(*) FROM app.audit_events',
      'SELECT id FROM app.audit_events',
      "UPDATE app.audit_events SET risk_tier = 1 WHERE id = '" + ID(30) + "'",
      'DELETE FROM app.audit_events',
      'TRUNCATE app.audit_events',
    ]) {
      expect((await runAs(CTX.staffA, sql)).error?.code, sql).toBe('42501');
    }
  });

  it('INSERT ... RETURNING is refused too (no SELECT privilege), so nothing can be read back through an insert', async () => {
    const r = await runAs(CTX.staffA, insertRow(ID(31), ORG_A, STAFF_A) + ' RETURNING id');
    expect(r.error?.code).toBe('42501');
  });
});

describe('runtime INSERT: tenant, actor and context are enforced by RLS', () => {
  it('a correctly scoped insert succeeds and occurred_at defaults to the database clock', async () => {
    const ok = await runAs(CTX.staffA, insertRow(ID(40), ORG_A, STAFF_A));
    expect(ok.error).toBeUndefined();
    expect(ok.rowCount).toBe(1);
  });

  it('tenant A cannot write (or associate) an audit event with tenant B', async () => {
    const r = await runAs(CTX.staffA, insertRow(ID(41), ORG_B, STAFF_A));
    expect(r.error?.code).toBe('42501');
    const asB = await runAs(CTX.staffB, insertRow(ID(42), ORG_A, STAFF_B));
    expect(asB.error?.code).toBe('42501');
  });

  it('the actor cannot be forged: another user, another actor type, impersonation and NULL actor are all refused', async () => {
    const attempts = [
      insertRow(ID(43), ORG_A, USER_A), // another user of the same tenant
      insertRow(ID(44), ORG_A, STAFF_B), // a user of another tenant
      insertRow(ID(45), ORG_A, STAFF_A, 'SYSTEM'),
      insertRow(ID(46), ORG_A, STAFF_A, 'AI'),
      insertRow(ID(47), ORG_A, STAFF_A, 'PLATFORM_SUPPORT'),
      insertRow(ID(48), ORG_A, 'NULL'),
      insertRow(ID(49), ORG_A, STAFF_A)
        .replace("'role_assignment', 2)", `'role_assignment', 2)`)
        .replace(
          COLS,
          `(id, organization_id, actor_type, actor_user_id, action, resource_type, risk_tier, on_behalf_of_user_id)`,
        )
        .replace("'role_assignment', 2)", `'role_assignment', 2, '${USER_A}')`),
    ];
    for (const sql of attempts)
      expect((await runAs(CTX.staffA, sql)).error?.code, sql).toBe('42501');
  });

  it('a student actor can only ever write its own identity as actor (it cannot impersonate staff)', async () => {
    const own = await runAs(CTX.studentA, insertRow(ID(50), ORG_A, USER_A));
    expect(own.error).toBeUndefined();
    const spoof = await runAs(CTX.studentA, insertRow(ID(51), ORG_A, STAFF_A));
    expect(spoof.error?.code).toBe('42501');
    expect(STUDENT_A).toBeDefined();
  });

  it('writes require a valid tenant context: none, malformed, wrong tenant for the user, unknown actor kind', async () => {
    const sql = insertRow(ID(52), ORG_A, STAFF_A);
    for (const ctx of [
      {},
      { tenant: ORG_A },
      { tenant: 'not-a-uuid', user: STAFF_A, kind: 'STAFF' },
      { tenant: ORG_B, user: STAFF_A, kind: 'STAFF' }, // user is not a member of that tenant
      { tenant: ORG_A, user: STAFF_A, kind: 'root' },
    ]) {
      expect((await runAs(ctx, sql)).error?.code, JSON.stringify(ctx)).toBe('42501');
    }
  });

  it('table constraints reject malformed events (action format, risk tier, reason length, oversized JSON, bad user agent)', async () => {
    const base = (set: string, value: string): string =>
      `INSERT INTO app.audit_events ${COLS.replace(')', `, ${set})`)} VALUES ('${ID(53)}', '${ORG_A}', 'USER', '${STAFF_A}', 'role.assignment.grant', 'role_assignment', 2, ${value})`;
    const bad: string[] = [
      insertRow(ID(54), ORG_A, STAFF_A).replace("'role.assignment.grant'", "'GRANT'"),
      insertRow(ID(55), ORG_A, STAFF_A).replace("'role.assignment.grant'", "'single'"),
      insertRow(ID(56), ORG_A, STAFF_A).replace(', 2)', ', 4)'),
      insertRow(ID(57), ORG_A, STAFF_A).replace("'role_assignment'", "'Role Assignment'"),
      base('reason_text', "''"),
      base('reason_text', `'${'x'.repeat(501)}'`),
      base('user_agent', `'${'u'.repeat(257)}'`),
      base('changes', `'["not","an","object"]'::jsonb`),
      base('changes', `jsonb_build_object('k', repeat('x', 17000))`),
      base('reason_code', "'lower_case'"),
    ];
    for (const sql of bad) expect((await runAs(CTX.staffA, sql)).error?.code, sql).toBe('23514');
  });

  it('control: the same statements are accepted by the harness when well formed (rolled back)', async () => {
    const r = await runStepsAs(CTX.staffA, [
      [insertRow(ID(60), ORG_A, STAFF_A)],
      [insertRow(ID(61), ORG_A, STAFF_A)],
    ]);
    expect(r.error).toBeUndefined();
  });
});
