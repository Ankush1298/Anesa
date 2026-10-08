/**
 * Minimal, dependency-free SQL migration runner.
 *  - runs ONLY as app_migrator (refuses any other role, so objects always have the right owner)
 *  - ordered by file name, each migration in one transaction, serialised by an advisory lock
 *  - records a SHA-256 checksum; an edited, already-applied migration is a hard error (drift)
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

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(opts: {
  connectionString: string;
  dir?: string;
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

      const result: MigrateResult = { applied: [], alreadyApplied: [] };
      for (const m of migrations) {
        const prior = done.get(m.version);
        if (prior !== undefined) {
          if (prior !== m.checksum) {
            throw new Error(
              `Migration ${m.version}_${m.name} was modified after being applied (checksum drift)`,
            );
          }
          result.alreadyApplied.push(m.version);
          continue;
        }
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
      for (const v of done.keys()) {
        if (!migrations.some((m) => m.version === v)) {
          throw new Error(`Database has migration ${v} that is missing from source control`);
        }
      }
      return result;
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await c.end();
  }
}
