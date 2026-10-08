import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { bootstrapDatabase } from '../../tools/db/bootstrap.js';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, migrate } from '../../tools/db/migrate.js';
import { CTX, ORG_A, STUDENT_A } from '../support/fixtures.js';
import { seedFixtures } from '../support/fixtures.js';
import { urlFor } from '../support/role-passwords.js';

// Clean-database migration tests. They reuse the ROLE passwords provided by the global setup (roles are
// cluster-wide and shared with the other test files), and each test gets its own throw-away database.
const serverAdminUrl = inject('serverAdminUrl');
const runtimePw = decodeURIComponent(new URL(inject('dbRuntimeUrl')).password);
const migratorPw = decodeURIComponent(new URL(inject('dbMigratorUrl')).password);
const created: string[] = [];

async function freshDatabase(): Promise<{
  name: string;
  admin: string;
  migrator: string;
  runtime: string;
}> {
  const name = `campusos_mig_${randomBytes(5).toString('hex')}`;
  const c = new pg.Client({ connectionString: serverAdminUrl });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  created.push(name);
  const { username, password } = new URL(serverAdminUrl);
  const admin = urlFor(serverAdminUrl, username, decodeURIComponent(password), name);
  await bootstrapDatabase({
    adminUrl: admin,
    runtimePassword: runtimePw,
    migratorPassword: migratorPw,
  });
  return {
    name,
    admin,
    migrator: urlFor(serverAdminUrl, 'app_migrator', migratorPw, name),
    runtime: urlFor(serverAdminUrl, 'app_runtime', runtimePw, name),
  };
}

async function dropDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: serverAdminUrl });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
}

afterAll(async () => {
  for (const n of created) await dropDatabase(n);
});

async function one<T extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Hash of everything security-relevant in the schema: structure, constraints, policies, functions, grants. */
async function fingerprint(adminUrl: string): Promise<string> {
  const parts = await one<{ x: string }>(
    adminUrl,
    `SELECT x FROM (
       SELECT 'col:' || table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(domain_name,'') || ':' || is_nullable || ':' || coalesce(column_default,'') AS x
         FROM information_schema.columns WHERE table_schema IN ('app','platform')
       UNION ALL SELECT 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace IN ('app'::regnamespace,'platform'::regnamespace)
       UNION ALL SELECT 'idx:' || indexdef FROM pg_indexes WHERE schemaname IN ('app','platform')
       UNION ALL SELECT 'pol:' || schemaname || '.' || tablename || ':' || policyname || ':' || permissive || ':' || roles::text || ':' || cmd || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'') FROM pg_policies WHERE schemaname = 'app'
       UNION ALL SELECT 'fn:' || pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace IN ('app'::regnamespace)
       UNION ALL SELECT 'rls:' || c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relnamespace IN ('app'::regnamespace) AND c.relkind = 'r'
       UNION ALL SELECT 'grant:' || table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'app' AND grantee IN ('app_runtime','PUBLIC')
       UNION ALL SELECT 'colgrant:' || table_name || ':' || column_name || ':' || grantee || ':' || privilege_type FROM information_schema.column_privileges WHERE table_schema = 'app' AND grantee = 'app_runtime'
     ) s ORDER BY x`,
  );
  return createHash('sha256')
    .update(parts.map((p) => p.x).join('\n'))
    .digest('hex');
}

describe('migrations from a clean database', () => {
  it('migration files are ordered, contiguous and checksummed', () => {
    const m = loadMigrations();
    expect(m.map((x) => x.version)).toEqual(['0001', '0002', '0003', '0004', '0005']);
    expect(m.every((x) => /^[0-9a-f]{64}$/.test(x.checksum))).toBe(true);
  });

  it('applies everything on an empty database, records checksums and is a no-op the second time', async () => {
    const db = await freshDatabase();
    const first = await migrate({ connectionString: db.migrator });
    expect(first.applied).toEqual(['0001', '0002', '0003', '0004', '0005']);
    const ledger = await one<{ version: string; checksum: string; applied_by: string }>(
      db.admin,
      'SELECT version, checksum, applied_by FROM platform.schema_migrations ORDER BY version',
    );
    expect(ledger.map((l) => l.version)).toEqual(['0001', '0002', '0003', '0004', '0005']);
    expect(new Set(ledger.map((l) => l.applied_by))).toEqual(new Set(['app_migrator']));
    expect(ledger.map((l) => l.checksum.trim())).toEqual(loadMigrations().map((m) => m.checksum));
    const second = await migrate({ connectionString: db.migrator });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001', '0002', '0003', '0004', '0005']);
  });

  it('refuses to run as anyone but app_migrator (so objects can never be owned by the wrong role)', async () => {
    const db = await freshDatabase();
    await expect(migrate({ connectionString: db.runtime })).rejects.toThrow(
      /must run as app_migrator/,
    );
    await expect(migrate({ connectionString: db.admin })).rejects.toThrow(
      /must run as app_migrator/,
    );
  });

  it('detects an already-applied migration that was edited (checksum drift)', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator });
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const file = join(dir, '0002_core_tables.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- tampered\n`);
    await expect(migrate({ connectionString: db.migrator, dir })).rejects.toThrow(/checksum drift/);
  });

  it('detects a migration that exists in the database but not in source control', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator });
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => !x.startsWith('0005'))) {
      cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
    await expect(migrate({ connectionString: db.migrator, dir })).rejects.toThrow(
      /missing from source control/,
    );
  });

  it('a failing migration rolls back completely and records nothing', async () => {
    const db = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    cpSync(
      join(DEFAULT_MIGRATIONS_DIR, '0001_context_primitives.sql'),
      join(dir, '0001_context_primitives.sql'),
    );
    writeFileSync(
      join(dir, '0002_broken.sql'),
      'CREATE TABLE app.half_done (id int);\nSELECT 1/0;',
    );
    await expect(migrate({ connectionString: db.migrator, dir })).rejects.toThrow();
    const ledger = await one(db.admin, 'SELECT version FROM platform.schema_migrations ORDER BY 1');
    expect(ledger).toEqual([{ version: '0001' }]);
    expect(await one(db.admin, "SELECT 1 FROM pg_class WHERE relname = 'half_done'")).toEqual([]);
  });

  it('reproducible: two independent clean databases end up with an identical security-relevant schema', async () => {
    const a = await freshDatabase();
    const b = await freshDatabase();
    await migrate({ connectionString: a.migrator });
    await migrate({ connectionString: b.migrator });
    expect(await fingerprint(a.admin)).toBe(await fingerprint(b.admin));
  });

  it('full cycle: migrate -> seed -> prove isolation -> reset -> migrate again, identical result', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator });
    const schemaBefore = await fingerprint(db.admin);
    await seedFixtures(db.admin);

    // isolation holds on this freshly migrated database
    const c = new pg.Client({ connectionString: db.runtime });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true)",
        [ORG_A, CTX.studentA.user, 'STUDENT'],
      );
      const own = await c.query('SELECT id FROM app.students');
      expect(own.rows).toEqual([{ id: STUDENT_A }]);
      await c.query('ROLLBACK');
      const none = await c.query('SELECT id FROM app.students');
      expect(none.rows).toEqual([]);
    } finally {
      await c.end();
    }

    // reset (drop everything) and migrate again
    await dropDatabase(db.name);
    created.splice(created.indexOf(db.name), 1);
    const again = await freshDatabase();
    const result = await migrate({ connectionString: again.migrator });
    expect(result.applied).toEqual(['0001', '0002', '0003', '0004', '0005']);
    expect(await fingerprint(again.admin)).toBe(schemaBefore);
    await seedFixtures(again.admin); // seeds cleanly into the re-created schema
  });

  it('after migrating, the runtime role works and the owner role is still blind', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator });
    await seedFixtures(db.admin);
    const asOwner = await one<{ n: string }>(
      db.migrator,
      'SELECT count(*)::text AS n FROM app.students',
    );
    expect(asOwner).toEqual([{ n: '0' }]);
  });
});
