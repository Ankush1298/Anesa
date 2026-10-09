import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import {
  CLUSTER_BOOTSTRAP_LOCK_KEY,
  createBootstrappedDatabase,
  withClusterBootstrapLock as withLock,
} from './bootstrap-lock.js';
import { urlFor } from './role-passwords.js';

/**
 * Throw-away databases for migration tests, created on the DISPOSABLE server the global setup provides
 * (`serverAdminUrl`: an embedded PostgreSQL in a temp directory, or the CI service container). Names are random,
 * every database is dropped by `dropAll`, and nothing here can name `.data/postgres`: the URL comes only from
 * vitest's `inject`.
 */
export interface FreshDb {
  name: string;
  admin: string;
  migrator: string;
  runtime: string;
}

const created: string[] = [];

/** Test-file view of the shared lock helper (tests/support/bootstrap-lock.ts): the server comes from vitest's `inject`. */
export { CLUSTER_BOOTSTRAP_LOCK_KEY };
export const withClusterBootstrapLock = <T>(work: (holderPid: number) => Promise<T>): Promise<T> =>
  withLock(inject('serverAdminUrl'), work);

export async function freshDatabase(): Promise<FreshDb> {
  const serverAdminUrl = inject('serverAdminUrl');
  const runtimePw = decodeURIComponent(new URL(inject('dbRuntimeUrl')).password);
  const migratorPw = decodeURIComponent(new URL(inject('dbMigratorUrl')).password);
  const name = `campusos_mig_${randomBytes(5).toString('hex')}`;
  await createBootstrappedDatabase(
    serverAdminUrl,
    name,
    { runtime: runtimePw, migrator: migratorPw },
    () => created.push(name),
  );
  return {
    name,
    admin: urlFor(
      serverAdminUrl,
      new URL(serverAdminUrl).username,
      decodeURIComponent(new URL(serverAdminUrl).password),
      name,
    ),
    migrator: urlFor(serverAdminUrl, 'app_migrator', migratorPw, name),
    runtime: urlFor(serverAdminUrl, 'app_runtime', runtimePw, name),
  };
}

/** Drops one database created by `freshDatabase` and forgets it. */
export async function dropDatabase(name: string): Promise<void> {
  const c = new pg.Client({ connectionString: inject('serverAdminUrl') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await c.end();
  }
  const at = created.indexOf(name);
  if (at >= 0) created.splice(at, 1);
}

export async function dropAll(): Promise<void> {
  const c = new pg.Client({ connectionString: inject('serverAdminUrl') });
  await c.connect();
  try {
    for (const n of created.splice(0)) await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  url: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
