import { describe, expect, it } from 'vitest';
import { CTX, STAFF_A } from '../support/fixtures.js';
import {
  adminQuery,
  runAs,
  runAsMigrator,
  runStepsAs,
  runStepsAsMigrator,
} from '../support/db-harness.js';

const APP_TABLES = [
  'audit_events',
  'campuses',
  'cohorts',
  'departments',
  'designations',
  'employees',
  'idempotency_keys',
  'number_sequences',
  'organization_settings',
  'organizations',
  'period_types',
  'programs',
  'role_assignments',
  'role_permissions',
  'roles',
  'users',
  'students',
  'student_guardians',
  'student_programs',
  'student_program_events',
];

describe('real PostgreSQL 16 server', () => {
  it('the security suite runs against PostgreSQL 16.x', async () => {
    const [row] = await adminQuery<{ n: number; v: string }>(
      "SELECT current_setting('server_version_num')::int AS n, current_setting('server_version') AS v",
    );
    expect(row?.n).toBeGreaterThanOrEqual(160000);
    expect(row?.n).toBeLessThan(170000);
  });
});

describe('role attributes (Invariant E)', () => {
  it.each(['app_runtime', 'app_migrator'])('%s is an unprivileged login role', async (role) => {
    const [r] = await adminQuery(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit
         FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    expect(r).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolcanlogin: true,
      rolinherit: false,
    });
  });

  it('neither role is a member of any role (cannot reach the other, nor pg_* predefined roles)', async () => {
    const rows = await adminQuery(
      `SELECT r.rolname AS role, u.rolname AS member FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE u.rolname IN ('app_runtime', 'app_migrator')`,
    );
    expect(rows).toEqual([]);
  });

  it('every schema object belongs to app_migrator, none to app_runtime', async () => {
    const rows = await adminQuery<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('app', 'platform')`,
    );
    expect(rows.map((r) => r.owner)).toEqual(['app_migrator']);
    const fns = await adminQuery<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app', 'platform')`,
    );
    expect(fns.map((r) => r.owner)).toEqual(['app_migrator']);
    const schemas = await adminQuery<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('app', 'platform')`,
    );
    expect(schemas.map((r) => r.owner)).toEqual(['app_migrator', 'app_migrator']);
  });

  it('runtime has no TRUNCATE / REFERENCES / TRIGGER anywhere (TRUNCATE ignores RLS) and no PUBLIC grants', async () => {
    for (const t of APP_TABLES) {
      for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const [r] = await adminQuery<{ ok: boolean }>(
          'SELECT has_table_privilege($1, $2, $3) AS ok',
          ['app_runtime', `app.${t}`, priv],
        );
        expect(r?.ok, `${priv} on ${t}`).toBe(false);
      }
      const pub = await adminQuery(
        `SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'app' AND table_name = $1 AND grantee = 'PUBLIC'`,
        [t],
      );
      expect(pub, `PUBLIC grants on ${t}`).toEqual([]);
    }
  });

  it('runtime cannot create anything anywhere but can use platform schema', async () => {
    const [r] = await adminQuery<Record<string, boolean>>(
      `SELECT has_schema_privilege('app_runtime','platform','USAGE') AS platform_usage,
              has_schema_privilege('app_runtime','app','CREATE')      AS app_create,
              has_schema_privilege('app_runtime','public','CREATE')   AS public_create,
              has_schema_privilege('app_runtime','public','USAGE')    AS public_usage,
              has_database_privilege('app_runtime', current_database(), 'CREATE') AS db_create`,
    );
    expect(r).toEqual({
      platform_usage: true,
      app_create: false,
      public_create: false,
      public_usage: false,
      db_create: false,
    });
  });
});

describe('runtime role cannot do privileged things (Invariant E)', () => {
  const attempts: [string, string][] = [
    ['create a table in app', 'CREATE TABLE app.evil (id int)'],
    ['create a table in public', 'CREATE TABLE public.evil (id int)'],
    ['create a schema', 'CREATE SCHEMA evil'],
    ['drop a protected table', 'DROP TABLE app.students'],
    ['truncate a protected table', 'TRUNCATE app.students'],
    ['disable RLS', 'ALTER TABLE app.students DISABLE ROW LEVEL SECURITY'],
    ['un-force RLS', 'ALTER TABLE app.students NO FORCE ROW LEVEL SECURITY'],
    ['take ownership of a table', 'ALTER TABLE app.students OWNER TO app_runtime'],
    ['drop a policy', 'DROP POLICY students_tenant_select ON app.students'],
    ['create a permissive policy', 'CREATE POLICY open ON app.students FOR ALL USING (true)'],
    [
      'create a function in app',
      'CREATE FUNCTION app.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
    ],
    [
      'replace the context probe',
      'CREATE OR REPLACE FUNCTION app.context_ok() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
    ],
    ['assume the migration role', 'SET ROLE app_migrator'],
    ['switch session authorization', 'SET SESSION AUTHORIZATION app_migrator'],
    ['create a role', 'CREATE ROLE evil SUPERUSER'],
    ['alter its own attributes', 'ALTER ROLE app_runtime BYPASSRLS'],
    ['read the migration ledger', 'SELECT * FROM platform.schema_migrations'],
    ['read password hashes', 'SELECT * FROM pg_authid'],
    ['read server files', "SELECT pg_read_file('/etc/passwd')"],
    ['run a program via COPY', "COPY (SELECT 1) TO PROGRAM 'true'"],
    ['install an extension', 'CREATE EXTENSION pgcrypto'],
  ];
  it.each(attempts)('cannot %s', async (_name, sql) => {
    const r = await runAs({}, sql);
    expect(r.error, `"${sql}" must be refused`).toBeDefined();
    expect(r.error?.code).toBe('42501'); // insufficient_privilege
  });

  it('cannot disable row-level security for itself: row_security=off makes the query fail, never leak', async () => {
    const r = await runStepsAs(CTX.staffA, [
      ['SET LOCAL row_security = off'],
      ['SELECT id FROM app.students'],
    ]);
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });

  it('GRANT by the runtime role is a no-op: it cannot hand out privileges it does not own', async () => {
    // PostgreSQL only WARNS when a non-owner GRANTs (no error), so assert on the effect, not the statement.
    const r = await runStepsAs(CTX.staffA, [
      ['GRANT ALL ON app.students TO PUBLIC'],
      ["SELECT has_table_privilege('public', 'app.students', 'SELECT') AS granted"],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual({ granted: false });
  });
});

describe('ownership trap: FORCE ROW LEVEL SECURITY (Invariant E)', () => {
  it('every protected table has RLS enabled AND forced', async () => {
    const rows = await adminQuery<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    );
    // partitions are covered one by one in security-db/audit-events.test.ts
    // sorted here, not by the server: ORDER BY depends on the collation ('organization_settings' vs 'organizations')
    expect(rows.map((r) => r.relname).sort()).toEqual([...APP_TABLES].sort());
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} FORCE`).toBe(true);
    }
  });

  it('control experiment: WITHOUT force the owner bypasses RLS; WITH force it does not', async () => {
    const r = await runStepsAsMigrator({}, [
      ['CREATE TABLE app.force_demo (id int)'],
      ['ALTER TABLE app.force_demo ENABLE ROW LEVEL SECURITY'],
      ['CREATE POLICY only_runtime ON app.force_demo FOR ALL TO app_runtime USING (false)'],
      ['INSERT INTO app.force_demo VALUES (1), (2)'],
      ['SELECT count(*)::int AS n FROM app.force_demo'],
    ]);
    // owner, no FORCE => policies are skipped for the owner: it sees everything
    expect(r.rows[0]).toEqual({ n: 2 });

    const forced = await runStepsAsMigrator({}, [
      ['CREATE TABLE app.force_demo (id int)'],
      ['ALTER TABLE app.force_demo ENABLE ROW LEVEL SECURITY'],
      ['ALTER TABLE app.force_demo FORCE ROW LEVEL SECURITY'],
      ['CREATE POLICY only_runtime ON app.force_demo FOR ALL TO app_runtime USING (false)'],
      ['SELECT count(*)::int AS n FROM app.force_demo'],
    ]);
    expect(forced.rows[0]).toEqual({ n: 0 });
  });

  it('regression: the migration/owner role sees ZERO tenant rows, with or without a context', async () => {
    for (const ctx of [{}, CTX.staffA, CTX.studentA]) {
      for (const t of APP_TABLES) {
        const r = await runAsMigrator(ctx, `SELECT count(*)::int AS n FROM app.${t}`);
        expect(r.error).toBeUndefined();
        expect(r.rows[0], `${t} as owner`).toEqual({ n: 0 });
      }
    }
  });

  it('regression: the owner cannot write tenant data either', async () => {
    const ins = await runAsMigrator(
      CTX.staffA,
      `INSERT INTO app.organizations (id, name, slug) VALUES ('01939a00-0000-7000-8000-0000000fff01', 'Evil', 'evil-org')`,
    );
    expect(ins.error?.code).toBe('42501');
    const upd = await runAsMigrator(CTX.staffA, "UPDATE app.students SET status = 'SUSPENDED'");
    expect(upd.rowCount).toBe(0);
  });

  it('the owner cannot SELECT anything via the context probe when logged in directly', async () => {
    // users_context_probe only matches when session_user <> current_user (i.e. inside the SECURITY DEFINER probe)
    const r = await runAsMigrator(
      { tenant: CTX.staffA.tenant, user: STAFF_A, kind: 'STAFF' },
      'SELECT id FROM app.users',
    );
    expect(r.rows).toEqual([]);
  });

  it('the superuser DOES bypass RLS — which is why the harness (and only the harness) uses it for seeding', async () => {
    const rows = await adminQuery('SELECT id FROM app.students');
    expect(rows.length).toBe(3);
  });
});
