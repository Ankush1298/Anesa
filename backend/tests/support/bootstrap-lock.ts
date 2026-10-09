import pg from 'pg';
import { bootstrapDatabase } from '../../tools/db/bootstrap.js';
import { urlFor } from './role-passwords.js';

/**
 * Key of the cluster-wide bootstrap lock. Advisory locks are scoped to the DATABASE of the session that takes them,
 * so the lock is always taken on the server's maintenance database (the one `serverAdminUrl` names), which every
 * test file, vitest project and process sharing this server reaches the same way. Distinct from the migration
 * runner's key.
 */
export const CLUSTER_BOOTSTRAP_LOCK_KEY = 727_301_002;

/**
 * Runs `work` while holding the cluster-wide bootstrap lock on `serverAdminUrl`'s server.
 *
 * ROOT CAUSE this serialises: `bootstrapDatabase` does `CREATE/ALTER ROLE app_migrator|app_runtime`,
 * `REVOKE <role> FROM <role>` and `ALTER ROLE ... IN DATABASE ... SET`. Roles (pg_authid, pg_auth_members,
 * pg_db_role_setting) are shared by ALL databases of the cluster, so two bootstraps that run at the same moment
 * collide ("tuple concurrently updated", "duplicate key ... pg_authid_rolname_index"). `CREATE DATABASE` (which needs
 * template1 to be idle) is serialised by the same lock. Callers: the global setup of every database project
 * (global-db.ts) and every test-time fresh database (fresh-db.ts).
 *
 * Release: the lock belongs to a dedicated session that is closed in `finally`, on success AND failure; ending a
 * session always drops its session-level advisory locks, even if `work` threw or the connection already broke. Errors
 * from `work` propagate unchanged; if `connect()` fails there is no session to leak. Only role/database setup is
 * serialised; migrations and tests run outside the lock.
 *
 * LIMIT: the lock removes the catalog race between concurrent bootstraps, it does not make two vitest PROCESSES on
 * one server safe: each process rotates the roles' passwords (see role-passwords.ts).
 */
export async function withClusterBootstrapLock<T>(
  serverAdminUrl: string,
  work: (holderPid: number) => Promise<T>,
): Promise<T> {
  const holder = new pg.Client({ connectionString: serverAdminUrl });
  await holder.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [CLUSTER_BOOTSTRAP_LOCK_KEY]);
    const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return await work(rows[0]?.pid ?? 0); // the pid lets tests observe THIS session, not other bootstraps
  } finally {
    await holder.end();
  }
}

/**
 * Creates database `name` on the server and bootstraps its roles/schemas, all under the cluster-wide lock.
 * Returns the superuser URL of the new database. `onCreated` runs right after CREATE DATABASE (for cleanup tracking).
 */
export async function createBootstrappedDatabase(
  serverAdminUrl: string,
  name: string,
  passwords: { runtime: string; migrator: string },
  onCreated: () => void = () => undefined,
): Promise<string> {
  const { username, password } = new URL(serverAdminUrl);
  const admin = urlFor(serverAdminUrl, username, decodeURIComponent(password), name);
  await withClusterBootstrapLock(serverAdminUrl, async () => {
    const c = new pg.Client({ connectionString: serverAdminUrl });
    await c.connect();
    try {
      await c.query(`CREATE DATABASE ${name}`);
    } finally {
      await c.end();
    }
    onCreated();
    await bootstrapDatabase({
      adminUrl: admin,
      runtimePassword: passwords.runtime,
      migratorPassword: passwords.migrator,
    });
  });
  return admin;
}
