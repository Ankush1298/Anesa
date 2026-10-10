import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createBootstrappedDatabase } from './bootstrap-lock.js';
import { contractVersions, migrate } from '../../tools/db/migrate.js';
import { startThrowawayPostgres, type RunningPostgres } from './embedded-postgres.js';
import { seedFixtures } from './fixtures.js';
import { rolePasswords, urlFor } from './role-passwords.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of a fresh, fully migrated and seeded database (Slice 0 tests use this). */
    dbUrl: string;
    dbAdminUrl: string;
    /** app_runtime: what the application uses. Subject to RLS. */
    dbRuntimeUrl: string;
    /** app_migrator: schema owner. Used only by migration tests. */
    dbMigratorUrl: string;
    /** Superuser URL to the server's maintenance DB, for tests that need extra databases. */
    serverAdminUrl: string;
    /** Per-run marker stamped (COMMENT ON DATABASE) on the database this harness created; see dev-seed-core. */
    dbDisposableMarker: string;
  }
}

/**
 * Provides each test project with its own database: created empty, bootstrapped (roles + schemas),
 * migrated as app_migrator, and seeded with the deterministic security fixtures.
 *  - TEST_DATABASE_URL set (CI service container, docker compose): superuser URL of an existing
 *    PostgreSQL server; a uniquely named database is created and dropped.
 *  - otherwise: a throw-away embedded PostgreSQL 16 server (real server binaries, no Docker needed).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const configured = process.env['TEST_DATABASE_URL'];
  let embedded: RunningPostgres | undefined;
  const serverAdminUrl = configured ?? (embedded = await startThrowawayPostgres()).adminUrl;

  const dbName = `campusos_test_${randomBytes(6).toString('hex')}`;
  const pw = rolePasswords();
  // CREATE DATABASE + role/schema bootstrap under the cluster-wide lock: another test process (or project) may be
  // bootstrapping the same server at this moment.
  const adminUrl = await createBootstrappedDatabase(serverAdminUrl, dbName, pw);

  try {
    // Unforgeable-by-accident proof that THIS run created this database (dev-seed container path checks it).
    const marker = `campusos-disposable:${randomBytes(16).toString('hex')}`;
    const stamp = new pg.Client({ connectionString: serverAdminUrl });
    await stamp.connect();
    try {
      await stamp.query(`COMMENT ON DATABASE ${dbName} IS '${marker}'`);
    } finally {
      await stamp.end();
    }
    const migratorUrl = urlFor(serverAdminUrl, 'app_migrator', pw.migrator, dbName);
    // Disposable test database: contract migrations are authorised explicitly (every writer in this repo is
    // already upgraded), so the tests exercise the final schema. Production paths never do this implicitly.
    await migrate({ connectionString: migratorUrl, allowContract: contractVersions() });
    await seedFixtures(adminUrl);

    project.provide('dbUrl', adminUrl);
    project.provide('dbAdminUrl', adminUrl);
    project.provide('dbRuntimeUrl', urlFor(serverAdminUrl, 'app_runtime', pw.runtime, dbName));
    project.provide('dbMigratorUrl', migratorUrl);
    project.provide('serverAdminUrl', serverAdminUrl);
    project.provide('dbDisposableMarker', marker);

    return async () => {
      const cleanup = new pg.Client({ connectionString: serverAdminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
      await embedded?.stop();
    };
  } catch (setupErr) {
    try {
      const cleanup = new pg.Client({ connectionString: serverAdminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    } catch (cleanupErr) {
      // Record cleanup failure without exposing credentials
      const cleanMsg = (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr))
        .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_URL]')
        .replace(/:[^:@\s]+@/g, ':[REDACTED_PASSWORD]@');
      console.error(`Failed to clean up test database ${dbName} after setup failure: ${cleanMsg}`);
    }
    await embedded?.stop().catch(() => {});
    throw setupErr;
  }
}
