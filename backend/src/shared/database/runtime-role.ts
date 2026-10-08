import type { Pool } from 'pg';

export class RuntimeRoleError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Database runtime role is unsafe:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'RuntimeRoleError';
  }
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  is_migrator_member: boolean | null;
  can_create_in_app: boolean;
  owned_objects: string;
}

/**
 * Startup self-check (server.ts): refuse to serve traffic if DATABASE_URL points at anything other
 * than the least-privilege runtime role. Prevents the classic mistake of running the app as the
 * migration owner or a superuser, either of which would silently bypass RLS.
 */
export async function verifyRuntimeRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<RoleRow>(`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
           (SELECT pg_has_role(current_user, m.oid, 'USAGE') FROM pg_roles m WHERE m.rolname = 'app_migrator') AS is_migrator_member,
           has_schema_privilege(current_user, 'app', 'CREATE') AS can_create_in_app,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname IN ('app', 'platform') AND c.relowner = r.oid)::text AS owned_objects
    FROM pg_roles r WHERE r.rolname = current_user`);
  const me = rows[0];
  if (!me) throw new RuntimeRoleError(['cannot determine current role']);

  const problems: string[] = [];
  if (me.rolname !== 'app_runtime')
    problems.push(`connected as "${me.rolname}", expected "app_runtime"`);
  if (me.rolsuper) problems.push('role is a superuser');
  if (me.rolbypassrls) problems.push('role has BYPASSRLS');
  if (me.rolcreaterole) problems.push('role has CREATEROLE');
  if (me.rolcreatedb) problems.push('role has CREATEDB');
  if (me.rolreplication) problems.push('role has REPLICATION');
  if (me.is_migrator_member === true) problems.push('role can act as app_migrator');
  if (me.can_create_in_app) problems.push('role can CREATE in schema app');
  if (me.owned_objects !== '0') problems.push('role owns schema objects');
  if (problems.length > 0) throw new RuntimeRoleError(problems);
}
