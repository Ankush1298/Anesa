import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../../tools/db/migrate.js';
import {
  CAMPUS_1,
  CAMPUS_2,
  CAMPUS_B1,
  DEPT_1,
  ORG_A,
  TEMP_A,
  seedFixtures,
  UNKNOWN_V7,
} from '../support/fixtures.js';
import { dropAll, freshDatabase, sql, type FreshDb } from '../support/fresh-db.js';

// Expand/contract rollout (0008 expand, 0009 contract) against DISPOSABLE databases created by the global setup.
afterAll(dropAll);

const APPLIED_BY_DEFAULT = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008'];
const ledgerOf = async (db: FreshDb): Promise<string[]> =>
  (
    await sql<{ version: string }>(
      db.admin,
      'SELECT version FROM platform.schema_migrations ORDER BY 1',
    )
  ).map((r) => r.version);
const constraintNames = async (db: FreshDb): Promise<string[]> =>
  (
    await sql<{ conname: string }>(
      db.admin,
      `SELECT conname FROM pg_constraint WHERE conrelid = 'app.role_assignments'::regclass ORDER BY 1`,
    )
  ).map((r) => r.conname);

/** Full ledger rows: a refused or failed run must leave these unchanged, not just the list of versions. */
const ledgerRows = (db: FreshDb) =>
  sql<{ version: string; name: string; checksum: string; applied_at: Date }>(
    db.admin,
    'SELECT version, name, checksum, applied_at FROM platform.schema_migrations ORDER BY version',
  );
/**
 * Everything a migration could have changed in app/platform EXCEPT the ledger itself (a failed run may re-create an
 * empty ledger table): relations with their RLS flags, constraints, function bodies and policies.
 */
const objects = async (db: FreshDb): Promise<string> =>
  JSON.stringify(
    await sql(
      db.admin,
      `SELECT 'rel' AS k, n.nspname || '.' || c.relname || ':' || c.relkind::text || c.relrowsecurity::text || c.relforcerowsecurity::text AS v
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('app', 'platform') AND c.relname NOT LIKE 'schema\\_migrations%'
       UNION ALL
       SELECT 'con', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
         FROM pg_constraint
        WHERE connamespace IN ('app'::regnamespace, 'platform'::regnamespace)
          AND conrelid IS DISTINCT FROM to_regclass('platform.schema_migrations')
       UNION ALL
       SELECT 'fn', p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid))
         FROM pg_proc p WHERE p.pronamespace IN ('app'::regnamespace, 'platform'::regnamespace) AND p.prokind = 'f'
       UNION ALL
       SELECT 'pol', polrelid::regclass::text || ':' || polname FROM pg_policy
       ORDER BY 1, 2`,
    ),
  );
/** A temp directory holding exactly these migration files. */
const dirWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'campusos-phase-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
/** A copy of the REAL migrations 0001..n (a database "at 000n"). */
const realUpTo = (n: number): string => {
  const dir = mkdtempSync(join(tmpdir(), 'campusos-upto-'));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (Number(f.slice(0, 4)) <= n) cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
  }
  return dir;
};

describe('contract gate against a real database', () => {
  it('an ordinary run applies 0001-0008, defers 0009 and stays deferred on every later run', async () => {
    const db = await freshDatabase();
    const first = await migrate({ connectionString: db.migrator });
    expect(first.applied).toEqual(APPLIED_BY_DEFAULT);
    expect(first.deferred).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
      '0019',
    ]);
    expect(first.blockedBy).toBe('0009');
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);
    const names = await constraintNames(db);
    expect(names).toContain('ra_scope_id_check'); // legacy shape: expand phase only
    expect(names).not.toContain('ra_scope_integrity_ck');

    const second = await migrate({ connectionString: db.migrator });
    expect(second.applied).toEqual([]);
    expect(second.deferred).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
      '0019',
    ]);
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);

    const third = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(third.applied).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
    expect(third.deferred).toEqual(['0019']);
    expect(await constraintNames(db)).toContain('ra_scope_integrity_ck');
  });

  it('a wrong-version opt-in is refused before anything is applied', async () => {
    const db = await freshDatabase();
    for (const bad of ['0008', '0099', 'all']) {
      await expect(
        migrate({ connectionString: db.migrator, allowContract: [bad] }),
      ).rejects.toThrow(/no contract migration with that exact version/);
    }
    expect(await ledgerOf(db)).toEqual([]);
    expect(await sql(db.admin, `SELECT to_regclass('app.campuses') AS t`)).toEqual([{ t: null }]);
  });

  it('a database at 0007: --allow-contract 0009 is refused before any migration SQL is sent; the two steps then succeed in order', async () => {
    const db = await freshDatabase();
    // a database whose ledger is exactly 0001-0007 (the state before the academic-structure rollout)
    const at0007 = APPLIED_BY_DEFAULT.slice(0, 7);
    expect((await migrate({ connectionString: db.migrator, dir: realUpTo(7) })).applied).toEqual(
      at0007,
    );
    const ledgerBefore = await ledgerRows(db);

    // The planner refuses BEFORE any migration SQL is sent: neither 0008 nor 0009 is applied, nothing is half-done.
    await expect(
      migrate({ connectionString: db.migrator, allowContract: ['0009'] }),
    ).rejects.toThrow(/cannot run in the same invocation as pending 0008/);
    expect(await ledgerOf(db)).toEqual(at0007);
    expect(await ledgerRows(db)).toEqual(ledgerBefore); // no row added, changed or re-stamped
    expect(await sql(db.admin, `SELECT to_regclass('app.campuses') AS t`)).toEqual([{ t: null }]);
    expect(
      await sql(
        db.admin,
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'role_assignments' AND column_name IN ('campus_id', 'department_id')`,
      ),
    ).toHaveLength(0);
    expect(await constraintNames(db)).toContain('ra_scope_id_check');

    // The documented order still works: ordinary run (0008 only, 0009 deferred), then the explicit opt-in (0009 only).
    const step1 = await migrate({ connectionString: db.migrator });
    expect(step1.applied).toEqual(['0008']);
    expect(step1.deferred).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
      '0019',
    ]);
    const step2 = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(step2.applied).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
    expect(await ledgerOf(db)).toEqual([
      ...APPLIED_BY_DEFAULT,
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
    expect(await constraintNames(db)).toContain('ra_scope_integrity_ck');
  });

  it('stops at the first blocked contract migration; later migrations never run ahead of it; a failing contract migration rolls back', async () => {
    const db = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'campusos-gate-'));
    cpSync(
      join(DEFAULT_MIGRATIONS_DIR, '0001_context_primitives.sql'),
      join(dir, '0001_context_primitives.sql'),
    );
    writeFileSync(join(dir, '0002_expand.sql'), 'CREATE TABLE app.gate_ok (id int);');
    writeFileSync(
      join(dir, '0003_boom_contract.sql'),
      'CREATE TABLE app.gate_boom (id int);\nSELECT 1/0;',
    );
    writeFileSync(join(dir, '0004_after.sql'), 'CREATE TABLE app.gate_after (id int);');

    const ordinary = await migrate({ connectionString: db.migrator, dir });
    expect(ordinary.applied).toEqual(['0001', '0002']);
    expect(ordinary.deferred).toEqual(['0003', '0004']);

    await expect(
      migrate({ connectionString: db.migrator, dir, allowContract: ['0003'] }),
    ).rejects.toThrow();
    expect(await ledgerOf(db)).toEqual(['0001', '0002']);
    const tables = await sql<{ relname: string }>(
      db.admin,
      `SELECT relname FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relname LIKE 'gate\\_%' ORDER BY 1`,
    );
    expect(tables.map((t) => t.relname)).toEqual(['gate_ok']); // gate_boom rolled back, gate_after never ran
  });
});

// ---------------------------------------------------------------------------------------------------------
// 0009 on data that was written under the 0008 (expand) schema
// ---------------------------------------------------------------------------------------------------------
interface Legacy {
  db: FreshDb;
}
/**
 * Applies 0001-0008, seeds the fixtures, then rewrites every assignment into the LEGACY shape (scope_id only).
 * The schema stops at 0008, so the students are seeded in their pre-0017 shape (no admission_date): this database must
 * hold rows written under the old schema, which the later migrations (0009 ... 0017) then run over.
 */
async function legacyDatabase(): Promise<Legacy> {
  const db = await freshDatabase();
  const r = await migrate({ connectionString: db.migrator });
  expect(r.applied).toEqual(APPLIED_BY_DEFAULT);
  await seedFixtures(db.admin, { legacyStudentShape: true });
  await sql(db.admin, 'UPDATE app.role_assignments SET campus_id = NULL, department_id = NULL');
  return { db };
}

let n = 0;
async function addLegacyRow(
  db: FreshDb,
  o: {
    org?: string;
    type: string;
    scopeId: string | null;
    campusId?: string | null;
    departmentId?: string | null;
    status?: string;
  },
): Promise<void> {
  await sql(
    db.admin,
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, status)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $4::text, $5::uuid, $6::uuid, $7::uuid, $8
       FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'STAFF'`,
    [
      `01939a00-0000-7000-8000-00000000f1${String(++n).padStart(2, '0')}`,
      o.org ?? ORG_A,
      TEMP_A,
      o.type,
      o.scopeId,
      o.campusId ?? null,
      o.departmentId ?? null,
      o.status ?? 'ACTIVE',
    ],
  );
}

/** Everything 0009 could change: row data, constraints, the guard function, RLS flags and the ledger. */
async function schemaState(db: FreshDb): Promise<string> {
  const rows = await sql(
    db.admin,
    'SELECT to_jsonb(r) AS j FROM app.role_assignments r ORDER BY id',
  );
  const cons = await sql(
    db.admin,
    `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass) ORDER BY 1, 2`,
  );
  const guard = await sql(
    db.admin,
    `SELECT pg_get_functiondef('app.role_assignments_guard'::regproc) AS d`,
  );
  const rls = await sql(
    db.admin,
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass) ORDER BY 1`,
  );
  return JSON.stringify({ rows, cons, guard, rls, ledger: await ledgerOf(db) });
}

describe('migration 0009 on legacy data', () => {
  it('succeeds on valid legacy rows (every status), backfills the typed columns and installs the strict constraint', async () => {
    const { db } = await legacyDatabase();
    await addLegacyRow(db, { type: 'CAMPUS', scopeId: CAMPUS_2, status: 'REVOKED' });
    await addLegacyRow(db, { type: 'DEPARTMENT', scopeId: DEPT_1, status: 'EXPIRED' });
    const before = Number(
      (
        await sql<{ n: string }>(db.admin, 'SELECT count(*)::text AS n FROM app.role_assignments')
      )[0]?.n,
    );

    const result = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(result.applied).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);

    const rows = await sql<{
      scope_type: string;
      scope_id: string | null;
      campus_id: string | null;
      department_id: string | null;
    }>(db.admin, 'SELECT scope_type, scope_id, campus_id, department_id FROM app.role_assignments');
    expect(rows).toHaveLength(before);
    for (const r of rows) {
      expect(r.campus_id, r.scope_type).toBe(r.scope_type === 'CAMPUS' ? r.scope_id : null);
      expect(r.department_id, r.scope_type).toBe(r.scope_type === 'DEPARTMENT' ? r.scope_id : null);
    }
    expect(rows.some((r) => r.scope_type === 'CAMPUS')).toBe(true);
    expect(rows.some((r) => r.scope_type === 'DEPARTMENT')).toBe(true);

    const names = await constraintNames(db);
    expect(names).toContain('ra_scope_integrity_ck');
    expect(names).not.toContain('ra_scope_id_check');
    // the strict constraint now rejects a CAMPUS row without its typed column
    await expect(addLegacyRow(db, { type: 'CAMPUS', scopeId: CAMPUS_1 })).rejects.toMatchObject({
      code: '23514',
    });
    // FORCE RLS restored on all three tables, and the extended guard is active
    expect(
      await sql(
        db.admin,
        `SELECT relname FROM pg_class WHERE oid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass) AND relrowsecurity AND relforcerowsecurity`,
      ),
    ).toHaveLength(3);
    await expect(
      sql(
        db.admin,
        `UPDATE app.role_assignments SET campus_id = '${CAMPUS_2}' WHERE campus_id = '${CAMPUS_1}'`,
      ),
    ).rejects.toMatchObject({ code: '23001' });
    expect(await ledgerOf(db)).toEqual([
      ...APPLIED_BY_DEFAULT,
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
  });

  const invalid: [string, string, (db: FreshDb) => Promise<void>][] = [
    [
      'an orphaned scope (campus does not exist)',
      'campus not found: 1',
      (db) => addLegacyRow(db, { type: 'CAMPUS', scopeId: UNKNOWN_V7 }),
    ],
    [
      'a department that does not exist',
      'department not found: 1',
      (db) => addLegacyRow(db, { type: 'DEPARTMENT', scopeId: UNKNOWN_V7 }),
    ],
    [
      'a scope in another tenant',
      'campus in another organization: 1',
      (db) => addLegacyRow(db, { type: 'CAMPUS', scopeId: CAMPUS_B1 }),
    ],
    [
      'contradictory typed ids (campus_id differs from scope_id)',
      'campus_id differs from scope_id: 1',
      (db) => addLegacyRow(db, { type: 'CAMPUS', scopeId: CAMPUS_1, campusId: CAMPUS_2 }),
    ],
    [
      'a typed id on the wrong kind of scope',
      'campus_id set: 1',
      (db) => addLegacyRow(db, { type: 'DEPARTMENT', scopeId: DEPT_1, campusId: CAMPUS_1 }),
    ],
    [
      'an unknown scope type (legacy CHECK bypassed)',
      'unknown scope_type: 1',
      async (db) => {
        await sql(
          db.admin,
          'ALTER TABLE app.role_assignments DROP CONSTRAINT role_assignments_scope_type_check',
        );
        await addLegacyRow(db, { type: 'GLOBAL', scopeId: CAMPUS_1 });
      },
    ],
  ];
  it.each(invalid)(
    'fails closed on %s and rolls everything back',
    async (_name, diagnostic, inject) => {
      const { db } = await legacyDatabase();
      await inject(db);
      const before = await schemaState(db);

      await expect(
        migrate({ connectionString: db.migrator, allowContract: ['0009'] }),
      ).rejects.toThrow(new RegExp(`Migration 0009 preflight failed.*${diagnostic}`));

      expect(await schemaState(db)).toBe(before); // rows, constraints, guard, FORCE RLS and ledger identical
      expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------
// 0009: bounded lock wait, and rollback AFTER partial progress
// ---------------------------------------------------------------------------------------------------------
const FILE_0009 = '0009_role_scope_integrity_contract.sql';
const real0009 = (): string => readFileSync(join(DEFAULT_MIGRATIONS_DIR, FILE_0009), 'utf8');
const hasOldConstraint = async (db: FreshDb): Promise<boolean> =>
  (await constraintNames(db)).includes('ra_scope_id_check');

describe('migration 0009: lock_timeout', () => {
  it('sets a transaction-local lock_timeout BEFORE the first table lock', () => {
    const text = real0009().replace(/--.*$/gm, '');
    const set = text.search(/SET LOCAL lock_timeout = '\d+s';/);
    const lock = text.search(/LOCK TABLE/);
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(lock);
    expect(text).not.toMatch(/SET\s+(SESSION\s+)?lock_timeout/i); // never session-wide
  });

  it('a blocked lock fails the migration after the bound (55P03), changes nothing, and a retry then succeeds', async () => {
    const { db } = await legacyDatabase();
    const before = await schemaState(db);

    // Another session holds a lock on the SECOND table of the LOCK TABLE list, as a straggler writer would.
    const holder = new pg.Client({ connectionString: db.admin });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE app.campuses IN ACCESS SHARE MODE');
    const started = Date.now();
    let error: { code?: string; message?: string } | undefined;
    try {
      await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    } catch (e) {
      error = e as { code?: string; message?: string };
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const waited = Date.now() - started;

    expect(error?.code, error?.message).toBe('55P03'); // lock_not_available
    expect(error?.message).toMatch(/lock timeout/i);
    expect(waited).toBeGreaterThanOrEqual(4000); // it really waited for the bound...
    expect(waited).toBeLessThan(20000); // ...and did not wait forever
    expect(await schemaState(db)).toBe(before); // the lock it did get (role_assignments) was rolled back too
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);

    const retry = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(retry.applied).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]); // nothing was left behind by the timed-out attempt
  });
});

describe('migration 0009: rollback after partial progress (error injected into the REAL sql, in memory)', () => {
  // The injected statement runs INSIDE the migration's own transaction, at a chosen point of the real file, and
  // fails with a message that REPORTS what the transaction had already done at that moment. Rolling back is then
  // done by the runner's ordinary BEGIN/ROLLBACK; the test restores nothing by hand.
  const EVIDENCE = `DO $inj$
DECLARE
  n_total bigint; n_typed bigint; v_force boolean; v_guard boolean; v_new boolean; v_old boolean;
BEGIN
  SELECT count(*) INTO n_total FROM app.role_assignments;
  SELECT count(*) INTO n_typed FROM app.role_assignments WHERE campus_id IS NOT NULL OR department_id IS NOT NULL;
  SELECT c.relforcerowsecurity INTO v_force FROM pg_class c WHERE c.oid = 'app.role_assignments'::regclass;
  SELECT pg_get_functiondef('app.role_assignments_guard'::regproc) LIKE '%NEW.campus_id IS DISTINCT FROM OLD.campus_id%' INTO v_guard;
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app.role_assignments'::regclass AND conname = 'ra_scope_integrity_ck') INTO v_new;
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app.role_assignments'::regclass AND conname = 'ra_scope_id_check') INTO v_old;
  RAISE EXCEPTION 'INJECTED total=% typed=% force=% guard=% new_ck=% old_ck=% lock_timeout=%',
    n_total, n_typed, v_force, v_guard, v_new, v_old, current_setting('lock_timeout')
    USING ERRCODE = 'P0001';
END
$inj$;
`;
  // RAISE prints a boolean in PostgreSQL's text form: 't' / 'f'.
  const tf = (b: boolean): string => (b ? 't' : 'f');
  /** What the migration had already done when the injected error fired. */
  const points: [string, string, { guard: boolean; newCk: boolean; oldCk: boolean }][] = [
    // marker = the start of the NEXT section of the real file; the error is injected just before it
    [
      'after the backfill and its verification',
      '-- 5. Extend the immutability guard',
      { guard: false, newCk: false, oldCk: true },
    ],
    [
      'after the guard function was replaced',
      '-- 6. Replace ra_scope_id_check',
      { guard: true, newCk: false, oldCk: true },
    ],
    [
      'after the old constraint was dropped and the strict one added',
      '-- 7. Restore FORCE ROW LEVEL SECURITY',
      { guard: true, newCk: true, oldCk: false },
    ],
  ];

  it.each(points)('rolls everything back when it fails %s', async (_name, marker, expected) => {
    const { db } = await legacyDatabase();
    await addLegacyRow(db, { type: 'CAMPUS', scopeId: CAMPUS_2, status: 'REVOKED' });
    await addLegacyRow(db, { type: 'DEPARTMENT', scopeId: DEPT_1, status: 'EXPIRED' });

    // BEFORE: the legacy state, captured from the database (not assumed)
    const before = await schemaState(db);
    const rowsBefore = await sql<{ campus_id: string | null; department_id: string | null }>(
      db.admin,
      'SELECT campus_id, department_id FROM app.role_assignments',
    );
    expect(rowsBefore.length).toBeGreaterThan(0);
    expect(rowsBefore.every((r) => r.campus_id === null && r.department_id === null)).toBe(true);
    expect(await hasOldConstraint(db)).toBe(true);

    // The REAL 0009 text with one statement inserted; the file on disk is never written.
    const original = real0009();
    const at = original.indexOf(marker);
    expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
    expect(original.indexOf(marker, at + 1), 'marker must be unique').toBe(-1);
    const dir = mkdtempSync(join(tmpdir(), 'campusos-inject-'));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, FILE_0009), original.slice(0, at) + EVIDENCE + original.slice(at));
    expect(readFileSync(join(DEFAULT_MIGRATIONS_DIR, FILE_0009), 'utf8')).toBe(original);

    let message = '';
    try {
      await migrate({ connectionString: db.migrator, dir, allowContract: ['0009'] });
    } catch (e) {
      message = (e as Error).message;
    }

    // The error is the injected one, NOT a preflight failure, and it reports partial progress at that moment.
    expect(message).not.toMatch(/preflight failed/);
    const m =
      /INJECTED total=(\d+) typed=(\d+) force=(\w+) guard=(\w+) new_ck=(\w+) old_ck=(\w+) lock_timeout=(\S+)/.exec(
        message,
      );
    expect(m, message).not.toBeNull();
    const [, total, typed, force, guard, newCk, oldCk, lockTimeout] = m as RegExpExecArray;
    expect(Number(total)).toBe(rowsBefore.length); // the owner saw every row (NO FORCE was in effect)
    expect(Number(typed)).toBeGreaterThanOrEqual(3); // CAMPUS and DEPARTMENT rows (all statuses) were backfilled
    expect(force).toBe('f'); // FORCE RLS was OFF inside the transaction at that moment
    expect(guard).toBe(tf(expected.guard));
    expect(newCk).toBe(tf(expected.newCk));
    expect(oldCk).toBe(tf(expected.oldCk));
    expect(lockTimeout).toBe('5s'); // the transaction-local bound was active

    // AFTER: byte-identical to BEFORE, by the runner's ordinary rollback
    expect(await schemaState(db)).toBe(before);
    const rowsAfter = await sql<{ campus_id: string | null; department_id: string | null }>(
      db.admin,
      'SELECT campus_id, department_id FROM app.role_assignments',
    );
    expect(rowsAfter.every((r) => r.campus_id === null && r.department_id === null)).toBe(true);
    expect(await hasOldConstraint(db)).toBe(true);
    expect(await constraintNames(db)).not.toContain('ra_scope_integrity_ck');
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);
    expect(
      await sql(
        db.admin,
        `SELECT relname FROM pg_class WHERE oid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass) AND relrowsecurity AND relforcerowsecurity`,
      ),
    ).toHaveLength(3); // FORCE RLS restored on all three tables
    expect(
      await sql(
        db.admin,
        `SELECT pg_get_functiondef('app.role_assignments_guard'::regproc) LIKE '%campus_id%' AS extended`,
      ),
    ).toEqual([{ extended: false }]); // the 0006 guard is back
    // lock_timeout was transaction-local: a new session of the same role has none
    expect(await sql(db.migrator, 'SHOW lock_timeout')).toEqual([{ lock_timeout: '0' }]);

    // and the migration is still fully applicable afterwards (the real file, no injection)
    const retry = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(retry.applied).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Phase boundary (R1/R2) and the empty-ledger exemption. DISPOSABLE databases only.
// ---------------------------------------------------------------------------------------------------------
describe('phase boundary: a refusal happens before any migration SQL and before any ledger change', () => {
  // nextval() is NOT transactional. If ANY statement of a pending migration had been sent (even one the runner then
  // rolled back), the sequence would report is_called = true. A refusal that leaves it false proves no migration SQL ran.
  const BASE = { '0001_base.sql': 'CREATE SEQUENCE app.phase_probe;' };
  const ALL = {
    ...BASE,
    '0002_expand.sql': "SELECT nextval('app.phase_probe');",
    '0003_tighten_contract.sql': "SELECT nextval('app.phase_probe');",
  };
  const probe = async (db: FreshDb) =>
    (
      await sql<{ is_called: boolean; last_value: string }>(
        db.admin,
        'SELECT is_called, last_value FROM app.phase_probe',
      )
    )[0];

  it('R1: the contract opt-in while an earlier migration is pending sends no migration SQL and changes no ledger row; the two steps then work', async () => {
    const db = await freshDatabase();
    const base = dirWith(BASE);
    const all = dirWith(ALL);
    expect((await migrate({ connectionString: db.migrator, dir: base })).applied).toEqual(['0001']);
    const before = await ledgerRows(db);

    await expect(
      migrate({ connectionString: db.migrator, dir: all, allowContract: ['0003'] }),
    ).rejects.toThrow(/cannot run in the same invocation as pending 0002/);
    expect(await probe(db)).toMatchObject({ is_called: false }); // neither 0002 nor 0003 was executed
    expect(await ledgerRows(db)).toEqual(before);

    // control: the probe does detect execution, and the documented order still works
    const ordinary = await migrate({ connectionString: db.migrator, dir: all });
    expect(ordinary.applied).toEqual(['0002']);
    expect(ordinary.deferred).toEqual(['0003']);
    expect(await probe(db)).toMatchObject({ is_called: true, last_value: '1' });
    const contract = await migrate({
      connectionString: db.migrator,
      dir: all,
      allowContract: ['0003'],
    });
    expect(contract.applied).toEqual(['0003']);
    expect(await probe(db)).toMatchObject({ is_called: true, last_value: '2' });
  });

  it('R2: a ledger with a gap is refused, with or without the opt-in, before any migration SQL', async () => {
    const db = await freshDatabase();
    const all = dirWith(ALL);
    await migrate({ connectionString: db.migrator, dir: dirWith(BASE) });
    // 0003 recorded but 0002 not: a state the runner cannot produce. The REAL checksum is used so that, without the
    // prefix rule, nothing else would refuse: 0002 would be planned and executed (and the probe would show it).
    await sql(
      db.admin,
      `INSERT INTO platform.schema_migrations (version, name, checksum) VALUES ('0003', 'tighten_contract', $1)`,
      [createHash('sha256').update(ALL['0003_tighten_contract.sql']).digest('hex')],
    );
    const before = await ledgerRows(db);
    for (const allowContract of [[], ['0003']]) {
      await expect(
        migrate({ connectionString: db.migrator, dir: all, allowContract }),
      ).rejects.toThrow(/not a contiguous prefix.*0003 is recorded but 0002 is not/s);
    }
    expect(await probe(db)).toMatchObject({ is_called: false });
    expect(await ledgerRows(db)).toEqual(before);
  });
});

describe('empty-ledger exemption: only a genuinely fresh database can be built in one pass', () => {
  // The exemption is `done.size === 0` in planMigrations. These tests try to satisfy it on databases that are NOT
  // fresh. The first two tests must leave every relation, constraint, function, policy and RLS flag as it was, with
  // the strict 0009 constraint in place. In the hand-made-table cases the pass stops at the first conflicting CREATE
  // TABLE: earlier migrations of the same pass legitimately stay committed, the legacy data is kept, 0009 is not reached.
  it('a populated database with a truncated, missing or partial ledger is refused or rolled back, 0009 is not applied', async () => {
    const db = await freshDatabase();
    // the legitimate use of the exemption: a brand-new database in one pass
    const built = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(built.applied).toEqual([
      ...APPLIED_BY_DEFAULT,
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
    ]);
    const rows = await ledgerRows(db);
    const baseline = await objects(db);
    const restoreLedger = async (upTo: number): Promise<void> => {
      await sql(db.admin, 'TRUNCATE platform.schema_migrations');
      for (const r of rows.filter((x) => Number(x.version) <= upTo)) {
        await sql(
          db.admin,
          'INSERT INTO platform.schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
          [r.version, r.name, r.checksum, r.applied_at],
        );
      }
    };
    const refused = async (message: RegExp, ledger: string[]): Promise<void> => {
      await expect(
        migrate({ connectionString: db.migrator, allowContract: ['0009'] }),
      ).rejects.toThrow(message);
      expect(await objects(db)).toBe(baseline);
      expect(await ledgerOf(db)).toEqual(ledger);
    };

    await sql(db.admin, 'TRUNCATE platform.schema_migrations'); // truncated ledger
    await refused(/already exists/, []);
    await sql(db.admin, 'DROP TABLE platform.schema_migrations'); // missing ledger (the runner re-creates it, empty)
    await refused(/already exists/, []);
    await restoreLedger(3); // partial ledger: not empty, so the phase rule applies
    await refused(/cannot run in the same invocation as pending 0004, 0005, 0006, 0007, 0008/, [
      '0001',
      '0002',
      '0003',
    ]);
    await restoreLedger(8); // only the 0009 row missing on an already-contracted schema
    await refused(/ra_scope_id_check.*does not exist/, APPLIED_BY_DEFAULT);
    expect(await constraintNames(db)).toContain('ra_scope_integrity_ck');
  });

  it('a schema built by only SOME early migrations whose ledger was lost is refused at the first conflicting object', async () => {
    const db = await freshDatabase();
    expect((await migrate({ connectionString: db.migrator, dir: realUpTo(4) })).applied).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
    await sql(db.admin, 'DROP TABLE platform.schema_migrations');
    const baseline = await objects(db);
    await expect(
      migrate({ connectionString: db.migrator, allowContract: ['0009'] }),
    ).rejects.toThrow(/already exists/);
    expect(await objects(db)).toBe(baseline);
    expect(await ledgerOf(db)).toEqual([]);
    expect(await sql(db.admin, `SELECT to_regclass('app.role_assignments') AS t`)).toEqual([
      { t: null },
    ]); // 0005 was never reached, let alone 0009
  });

  // The sole barrier when ONE legacy table exists alone is the plain `CREATE TABLE` of that table (pinned by a
  // static test in academic-structure-static.test.ts). The pass stops there, never reaches 0009, keeps the data.
  it.each([
    ['role_assignments', ['0001', '0002', '0003', '0004']],
    ['campuses', ['0001', '0002', '0003', '0004', '0005', '0006', '0007']],
    ['departments', ['0001', '0002', '0003', '0004', '0005', '0006', '0007']],
  ])(
    'a hand-made app.%s (the only object that pre-exists) stops the one-pass build at its CREATE TABLE and keeps its data',
    async (table, ledger) => {
      const db = await freshDatabase();
      await sql(db.admin, `CREATE TABLE app.${table} (legacy int)`);
      await sql(db.admin, `INSERT INTO app.${table} VALUES (42)`);
      await expect(
        migrate({ connectionString: db.migrator, allowContract: ['0009'] }),
      ).rejects.toThrow(new RegExp(`relation "${table}" already exists`));
      expect(await ledgerOf(db)).toEqual(ledger); // earlier migrations stay committed; 0009 was not applied
      expect(await sql(db.admin, `SELECT * FROM app.${table}`)).toEqual([{ legacy: 42 }]);
      expect(
        await sql(db.admin, `SELECT 1 FROM pg_constraint WHERE conname = 'ra_scope_integrity_ck'`),
      ).toHaveLength(0);
      if (table === 'departments') {
        // 0008 failed at its second CREATE TABLE and rolled back as a whole, campuses included
        expect(await sql(db.admin, `SELECT to_regclass('app.campuses') AS t`)).toEqual([
          { t: null },
        ]);
      }
    },
  );
});
