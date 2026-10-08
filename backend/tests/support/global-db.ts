import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { startThrowawayPostgres, type RunningPostgres } from './embedded-postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL of a fresh, empty, isolated database for this test run. */
    dbUrl: string;
  }
}

/**
 * Provides each test project with its own empty database.
 *  - TEST_DATABASE_URL set (CI service container / docker compose): a superuser URL to an existing
 *    server; we create and later drop a uniquely named database on it.
 *  - otherwise: start a throw-away embedded PostgreSQL (no Docker needed).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const configured = process.env['TEST_DATABASE_URL'];
  let embedded: RunningPostgres | undefined;
  const adminUrl = configured ?? (embedded = await startThrowawayPostgres()).adminUrl;

  const dbName = `campusos_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  project.provide('dbUrl', url.toString());

  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await cleanup.end();
    await embedded?.stop();
  };
}
