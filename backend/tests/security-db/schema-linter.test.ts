import { describe, expect, it } from 'vitest';
import { adminQuery } from '../support/db-harness.js';

// S-2: catalog-level lint. Any new table must satisfy these automatically or CI fails.
const STUDENT_BEARING = ['students', 'student_guardians'];

describe('schema linter (S-2)', () => {
  it('there are no relations in public and no tenant tables outside app', async () => {
    const rows = await adminQuery(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','f','p','S')`,
    );
    expect(rows).toEqual([]);
  });

  it('every app table: RLS enabled + forced, tenant column NOT NULL with FK, owned by app_migrator', async () => {
    const tables = await adminQuery<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { relname } of tables) {
      const [flags] = await adminQuery<{ s: boolean; f: boolean; o: string }>(
        `SELECT relrowsecurity s, relforcerowsecurity f, pg_get_userbyid(relowner) o FROM pg_class
          WHERE oid = ('app.' || quote_ident($1))::regclass`,
        [relname],
      );
      expect(flags, relname).toEqual({ s: true, f: true, o: 'app_migrator' });

      const key = relname === 'organizations' ? 'id' : 'organization_id';
      const [col] = await adminQuery<{ is_nullable: string; data_type: string; udt_name: string }>(
        `SELECT is_nullable, data_type, udt_name FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = $1 AND column_name = $2`,
        [relname, key],
      );
      expect(col?.is_nullable, `${relname}.${key} must be NOT NULL`).toBe('NO');
      if (relname !== 'organizations') {
        const fk = await adminQuery(
          `SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('app.' || quote_ident($1))::regclass AND c.contype = 'f'
              AND (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) = 'organization_id'
              AND c.confrelid = 'app.organizations'::regclass`,
          [relname],
        );
        expect(
          fk.length,
          `${relname} needs a FK from organization_id to organizations`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every primary key and foreign key id column uses the uuid_v7 domain', async () => {
    const rows = await adminQuery<{
      table_name: string;
      column_name: string;
      domain_name: string | null;
    }>(
      `SELECT table_name, column_name, domain_name FROM information_schema.columns
        WHERE table_schema = 'app' AND (column_name = 'id' OR column_name LIKE '%\\_id')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // Documented exemption (0007): the request id is a random v4 UUID that must equal the one in the logs.
    const RANDOM_UUID_COLUMNS = /^audit_events(_\d{4}_\d{2})?\.request_id$/;
    for (const r of rows) {
      const name = `${r.table_name}.${r.column_name}`;
      if (RANDOM_UUID_COLUMNS.test(name)) continue;
      expect(r.domain_name, name).toBe('uuid_v7');
    }
  });

  it('every table has SELECT/INSERT/UPDATE/DELETE tenant policies (organizations: SELECT only), all scoped TO app_runtime', async () => {
    const pol = await adminQuery<{
      tablename: string;
      cmd: string;
      permissive: string;
      roles: string;
    }>(
      `SELECT tablename, cmd, permissive, roles::text FROM pg_policies WHERE schemaname = 'app' ORDER BY 1,2`,
    );
    const permissive = (t: string): string[] =>
      pol
        .filter(
          (p) => p.tablename === t && p.permissive === 'PERMISSIVE' && p.roles === '{app_runtime}',
        )
        .map((p) => p.cmd)
        .sort();
    expect(permissive('organizations')).toEqual(['SELECT']);
    for (const t of ['users', 'students', 'student_guardians']) {
      expect(permissive(t), t).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
    for (const p of pol) {
      if (
        (p.tablename === 'users' || p.tablename === 'organizations') &&
        p.cmd === 'SELECT' &&
        p.roles === '{app_migrator}'
      )
        continue; // the probe policy
      expect(p.roles, `${p.tablename}.${p.cmd}`).toBe('{app_runtime}');
    }
  });

  it('student-bearing tables carry a RESTRICTIVE student policy; users too', async () => {
    const pol = await adminQuery<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'app' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL'`,
    );
    const have = new Set(pol.map((p) => p.tablename));
    for (const t of [...STUDENT_BEARING, 'users']) expect(have.has(t), t).toBe(true);
  });

  it('no policy is unconditionally true', async () => {
    const rows = await adminQuery<{
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname = 'app'`);
    for (const r of rows) {
      expect(r.qual?.trim().toLowerCase(), r.policyname).not.toBe('true');
      expect(r.with_check?.trim().toLowerCase(), r.policyname).not.toBe('true');
    }
  });

  it('every foreign key is supported by an index with the same leading columns', async () => {
    const fks = await adminQuery<{ conname: string; conrelid: string; conkey: number[] }>(
      `SELECT c.conname, c.conrelid::regclass::text AS conrelid, c.conkey::int[] AS conkey
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = 'app'`,
    );
    for (const fk of fks) {
      const idx = await adminQuery<{ indkey: string }>(
        `SELECT i.indkey::text AS indkey FROM pg_index i WHERE i.indrelid = $1::regclass`,
        [fk.conrelid],
      );
      const wanted = fk.conkey.join(' ');
      const covered = idx.some((i) => i.indkey === wanted || i.indkey.startsWith(`${wanted} `));
      expect(covered, `${fk.conname} on ${fk.conrelid}`).toBe(true);
    }
  });

  it('every SECURITY DEFINER function pins search_path and is not executable by PUBLIC', async () => {
    const fns = await adminQuery<{
      proname: string;
      proconfig: string[] | null;
      public_exec: boolean;
    }>(
      `SELECT p.proname, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef`,
    );
    expect(fns.map((f) => f.proname)).toEqual(['context_ok']);
    for (const f of fns) {
      expect(
        f.proconfig?.some((c) => c.startsWith('search_path=')),
        f.proname,
      ).toBe(true);
      expect(f.public_exec, f.proname).toBe(false);
    }
  });

  it('no function in app/platform is executable by PUBLIC', async () => {
    const rows = await adminQuery(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app','platform') AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });

  it('id and organization_id are protected by immutability triggers on every table', async () => {
    const rows = await adminQuery<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND NOT t.tgisinternal AND t.tgname LIKE '%\\_immutable'
          AND NOT c.relispartition`, // partition children inherit the parent's trigger; checked in audit-events.test.ts
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      'audit_events',
      'campuses',
      'departments',
      'organizations',
      'role_assignments',
      'role_permissions',
      'roles',
      'student_guardians',
      'students',
      'users',
    ]);
  });
});
