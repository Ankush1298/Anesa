import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  DEFAULT_MIGRATIONS_DIR,
  contractVersions,
  loadMigrations,
  migrate,
} from '../../tools/db/migrate.js';
import { CTX, ORG_A, ORG_C, STAFF_C, STUDENT_A } from '../support/fixtures.js';
import { seedFixtures } from '../support/fixtures.js';
import { dropAll, dropDatabase, freshDatabase } from '../support/fresh-db.js';

// Clean-database migration tests: each test gets its own throw-away database from tests/support/fresh-db.ts, whose
// role/database setup runs under the cluster-wide bootstrap lock (roles are shared by every file on the server).
// Disposable databases only: every contract migration is explicitly authorised, as an operator would.
const ALL = { allowContract: contractVersions() };

afterAll(dropAll);

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
    expect(m.map((x) => x.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
    ]);
    expect(m.every((x) => /^[0-9a-f]{64}$/.test(x.checksum))).toBe(true);
  });

  it('applies everything on an empty database, records checksums and is a no-op the second time', async () => {
    const db = await freshDatabase();
    const first = await migrate({ connectionString: db.migrator, ...ALL });
    expect(first.applied).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
    ]);
    const ledger = await one<{ version: string; checksum: string; applied_by: string }>(
      db.admin,
      'SELECT version, checksum, applied_by FROM platform.schema_migrations ORDER BY version',
    );
    expect(ledger.map((l) => l.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
    ]);
    expect(new Set(ledger.map((l) => l.applied_by))).toEqual(new Set(['app_migrator']));
    expect(ledger.map((l) => l.checksum.trim())).toEqual(loadMigrations().map((m) => m.checksum));
    const second = await migrate({ connectionString: db.migrator, ...ALL });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
    ]);
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
    await migrate({ connectionString: db.migrator, ...ALL });
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const file = join(dir, '0002_core_tables.sql');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- tampered\n`);
    await expect(migrate({ connectionString: db.migrator, dir })).rejects.toThrow(/checksum drift/);
  });

  it('detects a migration that exists in the database but not in source control', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator, ...ALL });
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => !x.startsWith('0013'))) {
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
    await migrate({ connectionString: a.migrator, ...ALL });
    await migrate({ connectionString: b.migrator, ...ALL });
    expect(await fingerprint(a.admin)).toBe(await fingerprint(b.admin));
  });

  it('full cycle: migrate -> seed -> prove isolation -> reset -> migrate again, identical result', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator, ...ALL });
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
    const again = await freshDatabase();
    const result = await migrate({ connectionString: again.migrator, ...ALL });
    expect(result.applied).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
    ]);
    expect(await fingerprint(again.admin)).toBe(schemaBefore);
    await seedFixtures(again.admin); // seeds cleanly into the re-created schema
  });

  it('after migrating, the runtime role works and the owner role is still blind', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator, ...ALL });
    await seedFixtures(db.admin);
    const asOwner = await one<{ n: string }>(
      db.migrator,
      'SELECT count(*)::text AS n FROM app.students',
    );
    expect(asOwner).toEqual([{ n: '0' }]);
  });
});

describe('audit partitions fail closed end-to-end (migration 0007)', () => {
  // Lives in this file on purpose: freshDatabase() bootstraps cluster-wide roles, which must never run
  // concurrently from two test files ("tuple concurrently updated").
  const REASON = 'Joined the physics department as a lecturer';
  const TARGET = '01939a00-0000-7000-8000-00000000cc14';
  const ctxC = issueTrustedContext({ tenantId: ORG_C, userId: STAFF_C, actorKind: 'STAFF' });

  it('with no partition for the current month the audit insert fails, the grant is NOT committed and no row is stored; once the partition exists the same grant succeeds', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator, ...ALL });
    await seedFixtures(db.admin);
    const fresh = new Database(createPool({ connectionString: db.runtime, ssl: false, max: 2 }));
    try {
      await one(
        db.admin,
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'target.c@college-c.test', 'x', 'ACTIVE')`,
        [TARGET],
      );
      await one(
        db.admin,
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'target.c@college-c.test', 'Target C', 'ACTIVE', $1)`,
        [TARGET, ORG_C],
      );
      const [months] = await one<{ ym: string; start: string; next: string }>(
        db.admin,
        `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS ym,
                to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS start,
                to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month', 'YYYY-MM-DD') AS next`,
      );
      const { ym, start, next } = months!;
      await one(db.admin, `DROP TABLE app.audit_events_${ym}`); // simulate "the provisioned months ran out"

      const grant = (): Promise<string> =>
        fresh.withTenant(ctxC, async (tx) => {
          const role = await tx.query<{ id: string }>(
            "SELECT id FROM app.roles WHERE code = 'FACULTY'",
          );
          return RoleAssignmentService.grant(tx, ctxC, {
            targetUserId: TARGET,
            roleId: role.rows[0]!.id,
            scopeType: 'ORGANIZATION',
            reason: REASON,
          });
        });

      const e = (await grant().then(
        () => undefined,
        (x: unknown) => x,
      )) as AppError;
      expect(e).toMatchObject({ statusCode: 500, code: 'AUDIT_WRITE_FAILED' });
      expect(e.message).not.toMatch(/partition/i); // no database detail leaks to callers
      expect(
        await one(db.admin, 'SELECT 1 FROM app.role_assignments WHERE user_id = $1', [TARGET]),
      ).toEqual([]);
      expect(await one(db.admin, 'SELECT 1 FROM app.audit_events')).toEqual([]);

      // an operator provisions the month (a new migration in production); the very same call now commits both rows
      await one(
        db.admin,
        `CREATE TABLE app.audit_events_${ym} PARTITION OF app.audit_events FOR VALUES FROM ('${start} 00:00:00+00') TO ('${next} 00:00:00+00')`,
      );
      const id = await grant();
      expect(
        await one(db.admin, 'SELECT status FROM app.role_assignments WHERE id = $1', [id]),
      ).toHaveLength(1);
      expect(
        await one(db.admin, 'SELECT 1 FROM app.audit_events WHERE resource_id = $1', [id]),
      ).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
});
