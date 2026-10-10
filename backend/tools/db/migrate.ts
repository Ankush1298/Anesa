/**
 * Minimal, dependency-free SQL migration runner.
 *  - runs ONLY as app_migrator (refuses any other role, so objects always have the right owner)
 *  - ordered by file name, each migration in one transaction, serialised by an advisory lock
 *  - records a SHA-256 checksum; an edited, already-applied migration is a hard error (drift)
 *  - EXPAND/CONTRACT GATE: a migration whose name ends in `_contract` (e.g. 0009_role_scope_integrity_contract)
 *    never runs in an ordinary invocation. The run applies everything before it, STOPS at the first such
 *    migration (nothing after it is applied either, because later migrations may depend on it) and reports it
 *    as deferred. It runs only when the operator names its exact version in `allowContract`.
 *  - PHASE BOUNDARY: on an existing database (non-empty ledger) a contract migration must be the first migration
 *    an invocation applies, so the expand migration, the application deploy and the writer drain happen in an
 *    earlier invocation; otherwise the plan is refused before any migration SQL runs (see planMigrations). The ledger
 *    cannot prove the deploy or the drain happened: that stays the operator's responsibility.
 * Never imported by src/ (the running application has no migration capability).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../database/migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 727_301_001;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations = files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Bad migration file name: ${file} (expected 0001_snake_case.sql)`);
    const sql = readFileSync(resolve(dir, file), 'utf8');
    return {
      version: m[1] as string,
      name: m[2] as string,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');
  versions.forEach((v, i) => {
    if (Number(v) !== i + 1) throw new Error(`Migration versions must be contiguous (gap at ${v})`);
  });
  return migrations;
}

/** A contract migration tightens the schema in a way that breaks writers which were not upgraded first. */
export function isContractMigration(m: Pick<Migration, 'name'>): boolean {
  return m.name.endsWith('_contract');
}

/** Versions of every contract migration in `dir`. For disposable test databases ONLY, never for real environments. */
export function contractVersions(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  return loadMigrations(dir)
    .filter(isContractMigration)
    .map((m) => m.version);
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  /** Pending migrations NOT applied because a contract migration needs explicit authorisation (in order). */
  deferred: string[];
  /** The contract migration that stopped the run, if any. */
  blockedBy?: string;
}

export interface MigrationPlan {
  alreadyApplied: string[];
  /** To run now, in order. */
  run: Migration[];
  /** Not run: the blocking contract migration and everything after it. */
  deferred: Migration[];
}

/**
 * Pure planning step (unit-tested without a database). `done` maps applied versions to their checksums.
 * `allowContract` must name EXACT versions of existing contract migrations; anything else is an error,
 * so a typo can never authorise something else and a wildcard does not exist.
 */
export function planMigrations(
  migrations: readonly Migration[],
  done: ReadonlyMap<string, string>,
  allowContract: readonly string[] = [],
): MigrationPlan {
  for (const v of allowContract) {
    const m = migrations.find((x) => x.version === v);
    if (!/^\d{4}$/.test(v) || !m || !isContractMigration(m)) {
      throw new Error(
        `allow-contract "${v}": no contract migration with that exact version (contract migrations: ${
          migrations
            .filter(isContractMigration)
            .map((x) => x.version)
            .join(', ') || 'none'
        })`,
      );
    }
  }
  for (const v of done.keys()) {
    if (!migrations.some((m) => m.version === v)) {
      throw new Error(`Database has migration ${v} that is missing from source control`);
    }
  }
  // The runner applies migrations in order and records each one atomically with its DDL, so the applied versions
  // are always a prefix 0001..N. A gap (0009 recorded but 0008 not) cannot come from the runner: something else
  // changed the database. Applying the missing earlier migration after a later one would be out of order.
  [...done.keys()].sort().forEach((v, i) => {
    const expected = migrations[i]?.version;
    if (v !== expected) {
      throw new Error(
        `Migration ledger is not a contiguous prefix of the migrations in source control: ${v} is recorded but ${expected} is not. ` +
          'Refusing to apply anything; the runner cannot produce this state, so find out what changed the database first.',
      );
    }
  });
  const plan: MigrationPlan = { alreadyApplied: [], run: [], deferred: [] };
  let blocked = false;
  for (const m of migrations) {
    const prior = done.get(m.version);
    if (prior !== undefined) {
      if (prior !== m.checksum) {
        throw new Error(
          `Migration ${m.version}_${m.name} was modified after being applied (checksum drift)`,
        );
      }
      plan.alreadyApplied.push(m.version);
    } else if (blocked || (isContractMigration(m) && !allowContract.includes(m.version))) {
      blocked = true;
      plan.deferred.push(m);
    } else {
      plan.run.push(m);
    }
  }
  // PHASE BOUNDARY: on an existing database a contract migration must be the FIRST thing an invocation applies.
  // Between the expand migration and the contract one the operator deploys the new application and drains every
  // legacy writer; naming the contract version must never also apply a pending expand (or anything else) in the
  // same breath, because that skips the interval. Refused here, before any migration SQL is sent (the runner has only
  // connected, taken its advisory lock and ensured the ledger table exists). An EMPTY ledger is a
  // brand-new database: nothing was ever deployed against it, there is no writer to drain, and the disposable test
  // databases are built in one pass.
  // WHY THE EXEMPTION IS NARROW: it tests only the ledger, so it rests on one property of the migration files: they
  // create their objects with a plain CREATE (no IF NOT EXISTS). A one-pass run therefore reaches the contract
  // migration only if role_assignments, campuses and departments were created in THIS pass; if any pre-existed
  // (legacy rows, a lost or truncated ledger, a schema built by only some migrations) the pass stops at that
  // statement. Pinned by tests/security/academic-structure-static.test.ts, exercised by
  // tests/integration/migration-contract.test.ts.
  if (done.size > 0) {
    plan.run.forEach((m, i) => {
      if (i > 0 && isContractMigration(m)) {
        throw new Error(
          `Contract migration ${m.version}_${m.name} cannot run in the same invocation as pending ${plan.run
            .slice(0, i)
            .map((x) => x.version)
            .join(
              ', ',
            )}. Run \`pnpm db:migrate\` first (it applies only the ordinary migrations), deploy the ` +
            `application and drain every legacy writer, then run \`pnpm db:migrate --allow-contract ${m.version}\`. Nothing was applied.`,
        );
      }
    });
  }
  return plan;
}

export async function migrate(opts: {
  connectionString: string;
  dir?: string;
  /** Exact versions of contract migrations the operator authorises for THIS run. Default: none. */
  allowContract?: readonly string[];
}): Promise<MigrateResult> {
  const migrations = loadMigrations(opts.dir);
  const c = new pg.Client({ connectionString: opts.connectionString });
  await c.connect();
  try {
    const who = await c.query<{ u: string }>('SELECT current_user AS u');
    if (who.rows[0]?.u !== 'app_migrator') {
      throw new Error(
        `migrations must run as app_migrator (connected as ${who.rows[0]?.u ?? '?'})`,
      );
    }
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        version     text PRIMARY KEY,
        name        text        NOT NULL,
        checksum    char(64)    NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        applied_by  name        NOT NULL DEFAULT current_user
      )`);
      const done = new Map<string, string>();
      const { rows } = await c.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM platform.schema_migrations',
      );
      for (const r of rows) done.set(r.version, r.checksum.trim());

      // Validation, drift detection and the contract gate are decided before any migration SQL is sent.
      const plan = planMigrations(migrations, done, opts.allowContract ?? []);
      const result: MigrateResult = {
        applied: [],
        alreadyApplied: plan.alreadyApplied,
        deferred: plan.deferred.map((m) => m.version),
        ...(plan.deferred[0] ? { blockedBy: plan.deferred[0].version } : {}),
      };
      for (const m of plan.run) {
        await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query(
            'INSERT INTO platform.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [m.version, m.name, m.checksum],
          );
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
        result.applied.push(m.version);
      }
      return result;
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await c.end();
  }
}
