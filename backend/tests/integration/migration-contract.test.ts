import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('contract gate against a real database', () => {
  it('an ordinary run applies 0001-0008, defers 0009 and stays deferred on every later run', async () => {
    const db = await freshDatabase();
    const first = await migrate({ connectionString: db.migrator });
    expect(first.applied).toEqual(APPLIED_BY_DEFAULT);
    expect(first.deferred).toEqual(['0009']);
    expect(first.blockedBy).toBe('0009');
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);
    const names = await constraintNames(db);
    expect(names).toContain('ra_scope_id_check'); // legacy shape: expand phase only
    expect(names).not.toContain('ra_scope_integrity_ck');

    const second = await migrate({ connectionString: db.migrator });
    expect(second.applied).toEqual([]);
    expect(second.deferred).toEqual(['0009']);
    expect(await ledgerOf(db)).toEqual(APPLIED_BY_DEFAULT);

    const third = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(third.applied).toEqual(['0009']);
    expect(third.deferred).toEqual([]);
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
/** Applies 0001-0008, seeds the fixtures, then rewrites every assignment into the LEGACY shape (scope_id only). */
async function legacyDatabase(): Promise<Legacy> {
  const db = await freshDatabase();
  const r = await migrate({ connectionString: db.migrator });
  expect(r.applied).toEqual(APPLIED_BY_DEFAULT);
  await seedFixtures(db.admin);
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
    expect(result.applied).toEqual(['0009']);

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
    expect(await ledgerOf(db)).toEqual([...APPLIED_BY_DEFAULT, '0009']);
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
    expect(retry.applied).toEqual(['0009']); // nothing was left behind by the timed-out attempt
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
    expect(retry.applied).toEqual(['0009']);
  });
});
