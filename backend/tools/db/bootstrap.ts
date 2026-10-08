/**
 * SUPERUSER bootstrap — dev/CI/test and first-time provisioning only. Never imported by src/.
 *
 * Creates (idempotently) the two login roles and the schemas, and sets least-privilege defaults:
 *   app_migrator  owns schemas/objects, runs migrations, is never used by the running application
 *   app_runtime   the application role: no superuser, no BYPASSRLS, no ownership, no DDL
 * In production the roles/passwords come from your secret manager / IaC; this function is the
 * reference for the exact attributes they must have.
 */
import pg from 'pg';

export interface BootstrapOptions {
  /** Superuser connection to the TARGET database. */
  adminUrl: string;
  runtimePassword: string;
  migratorPassword: string;
}

const ROLE_ATTRS = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT';

export async function bootstrapDatabase(opts: BootstrapOptions): Promise<void> {
  const c = new pg.Client({ connectionString: opts.adminUrl });
  await c.connect();
  try {
    const { rows: who } = await c.query<{ super: boolean; db: string }>(
      'SELECT rolsuper AS super, current_database() AS db FROM pg_roles WHERE rolname = current_user',
    );
    if (!who[0]?.super) throw new Error('bootstrap must run as a PostgreSQL superuser');
    const db = c.escapeIdentifier(who[0].db);

    for (const [role, password] of [
      ['app_migrator', opts.migratorPassword],
      ['app_runtime', opts.runtimePassword],
    ] as const) {
      const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const verb = exists.rowCount === 0 ? 'CREATE' : 'ALTER';
      await c.query(
        `${verb} ROLE ${role} WITH ${ROLE_ATTRS} PASSWORD ${c.escapeLiteral(password)}`,
      );
    }

    // Neither role may reach the other.
    await c.query('REVOKE app_migrator FROM app_runtime').catch(() => undefined);
    await c.query('REVOKE app_runtime FROM app_migrator').catch(() => undefined);

    await c.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${db} TO app_runtime, app_migrator`);
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');

    // Schemas are owned by the migration role; PUBLIC gets nothing.
    await c.query('CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION app_migrator');
    await c.query('CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_migrator');
    await c.query('REVOKE ALL ON SCHEMA platform, app FROM PUBLIC');

    // Functions are executable by PUBLIC by default; make every new function opt-in instead.
    await c.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );

    // Per-database role settings (scoped IN DATABASE so several databases can share one cluster).
    const set = (role: string, name: string, value: string): Promise<unknown> =>
      c.query(`ALTER ROLE ${role} IN DATABASE ${db} SET ${name} = ${c.escapeLiteral(value)}`);
    await set('app_runtime', 'search_path', 'pg_catalog');
    await set('app_runtime', 'statement_timeout', '30s');
    await set('app_runtime', 'lock_timeout', '10s');
    await set('app_runtime', 'idle_in_transaction_session_timeout', '30s');
    await set('app_runtime', 'row_security', 'on');
    await set('app_migrator', 'search_path', 'pg_catalog');
  } finally {
    await c.end();
  }
}
