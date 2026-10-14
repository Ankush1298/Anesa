import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for the academic-structure work (migrations 0008 expand / 0009 contract). No database needed.
const backend = resolve(import.meta.dirname, '../..');
const root = resolve(backend, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const noComments = (sql: string): string => sql.replace(/--.*$/gm, '');
const sql0008 = noComments(read('database/migrations/0008_academic_structure.sql'));
const sql0009 = noComments(read('database/migrations/0009_role_scope_integrity_contract.sql'));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const stripTs = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const code = (dir: string): { path: string; text: string }[] =>
  walk(resolve(backend, dir)).map((p) => ({
    path: relative(backend, p),
    text: stripTs(readFileSync(p, 'utf8')),
  }));

describe('migrations 0008 / 0009: hygiene (same bar as 0007)', () => {
  for (const [name, sql] of [
    ['0008', sql0008],
    ['0009', sql0009],
  ] as const) {
    it(`${name}: no extension, no PUBLIC grant, no DELETE/TRUNCATE/ALL grant, no RLS or policy removal, no own transaction`, () => {
      expect(sql).not.toMatch(/CREATE EXTENSION/i);
      expect(sql).not.toMatch(/\bTO\s+PUBLIC\b/i);
      expect(sql).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b/i);
      expect(sql).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
      expect(sql).not.toMatch(/DROP\s+(POLICY|TABLE|SCHEMA|TRIGGER)/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
      expect(sql).not.toMatch(/^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\s*;/im); // the runner owns the transaction
      expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
    });
  }

  it('0008: campuses and departments have RLS enabled and forced, tenant policies, and STAFF-only restrictive write policies', () => {
    for (const t of ['campuses', 'departments']) {
      expect(sql0008).toMatch(new RegExp(`ALTER TABLE app\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql0008).toMatch(new RegExp(`ALTER TABLE app\\.${t} FORCE\\s+ROW LEVEL SECURITY`));
      for (const cmd of ['SELECT', 'INSERT', 'UPDATE']) {
        expect(sql0008).toMatch(
          new RegExp(`CREATE POLICY \\w+ ON app\\.${t} AS PERMISSIVE FOR ${cmd} TO app_runtime`),
        );
      }
      for (const cmd of ['INSERT', 'UPDATE']) {
        const m = new RegExp(
          `CREATE POLICY \\w+ ON app\\.${t} AS RESTRICTIVE FOR ${cmd} TO app_runtime[^;]*current_actor_kind\\(\\) = 'STAFF'`,
        );
        expect(sql0008).toMatch(m);
      }
      expect(sql0008).not.toMatch(new RegExp(`ON app\\.${t} AS \\w+ FOR DELETE`));
    }
    // every tenant policy is tenant-bound and context-checked
    for (const m of sql0008.matchAll(/CREATE POLICY \w+ ON app\.\w+ AS PERMISSIVE[^;]*;/g)) {
      expect(m[0]).toMatch(/app\.current_tenant_id\(\)/);
      expect(m[0]).toMatch(/app\.context_ok\(\)/);
    }
  });

  it('0008: runtime grants are exactly the intended column lists; identity, code, timezone, kind and parent are never updatable', () => {
    const grants = [
      ...sql0008.matchAll(/GRANT\s+([^;]*?)\s+ON\s+app\.(\w+)\s+TO\s+app_runtime/g),
    ].map((m) => `${m[2]}: ${(m[1] ?? '').replace(/\s+/g, ' ')}`);
    expect(grants.sort()).toEqual(
      [
        'campuses: SELECT, INSERT',
        'campuses: UPDATE (name, address, status)',
        'departments: SELECT, INSERT',
        'departments: UPDATE (name, status, deleted_at)',
      ].sort(),
    );
  });

  it('0008: timezone is required with no default; the database does not pretend to validate it', () => {
    const line = /^\s*timezone\s+text[^\n]*$/im.exec(sql0008)?.[0] ?? '';
    expect(line).toMatch(/NOT NULL/);
    expect(line).not.toMatch(/DEFAULT/i);
    const raw = read('database/migrations/0008_academic_structure.sql');
    expect(raw).toMatch(/NOT validated by this migration/);
    expect(sql0008).not.toMatch(/pg_timezone_names|timezone\s*~|timezone\s+SIMILAR/i);
  });

  it('0008: typed scope columns are nullable (expand), with composite same-tenant foreign keys, and no contract step', () => {
    expect(sql0008).toMatch(
      /ADD COLUMN campus_id app\.uuid_v7,\s*ADD COLUMN department_id app\.uuid_v7/,
    );
    expect(sql0008).toMatch(/ra_campus_fk FOREIGN KEY \(organization_id, campus_id\)/);
    expect(sql0008).toMatch(/ra_department_fk FOREIGN KEY \(organization_id, department_id\)/);
    expect(sql0008).not.toMatch(/ra_scope_id_check|ra_scope_integrity_ck|NOT NULL.*campus_id/);
    expect(sql0008).not.toMatch(/role_assignments_guard/);
  });

  it('0009: preflight (RAISE) comes before the first data change; the owner-visible window is closed again; nothing is deleted', () => {
    const firstRaise = sql0009.indexOf('RAISE EXCEPTION');
    const firstUpdate = sql0009.search(/\bUPDATE\s+app\.role_assignments/);
    expect(firstRaise).toBeGreaterThan(-1);
    expect(firstRaise).toBeLessThan(firstUpdate);
    expect(sql0009.search(/LOCK TABLE/)).toBeLessThan(
      sql0009.search(/NO FORCE ROW LEVEL SECURITY/),
    );
    for (const t of ['role_assignments', 'campuses', 'departments']) {
      const no = sql0009.search(
        new RegExp(`ALTER TABLE app\\.${t}\\s+NO FORCE ROW LEVEL SECURITY`),
      );
      const yes = sql0009.search(new RegExp(`ALTER TABLE app\\.${t}\\s+FORCE ROW LEVEL SECURITY`));
      expect(no, `${t} NO FORCE`).toBeGreaterThan(-1);
      expect(yes, `${t} FORCE`).toBeGreaterThan(no);
    }
    expect(sql0009).toMatch(/\)\s+IS NOT TRUE/); // NULL-safe final verification
    expect(sql0009).toMatch(/ra_scope_integrity_ck CHECK/);
    expect(sql0009).toMatch(/NEW\.campus_id IS DISTINCT FROM OLD\.campus_id/);
    expect(sql0009).toMatch(/NEW\.department_id IS DISTINCT FROM OLD\.department_id/);
    expect(sql0009).toMatch(/status is terminal once REVOKED or EXPIRED/); // 0006 protection preserved
    expect(sql0009).toMatch(/SET search_path = pg_catalog/);
  });

  it('only migrations 0009 and 0019 are contract migrations, each named and documented as one', () => {
    const names = readdirSync(resolve(root, 'database/migrations')).filter((f) =>
      f.endsWith('_contract.sql'),
    );
    expect(names).toEqual([
      '0009_role_scope_integrity_contract.sql',
      '0019_students_required_dates_contract.sql',
    ]);
    expect(read(`database/migrations/${names[0]}`)).toMatch(/--allow-contract 0009/);
    expect(read(`database/migrations/${names[1]}`)).toMatch(/--allow-contract 0019/);
  });

  it('0021 (student programs) is NOT a contract migration; it documents that the runner defers it behind 0019, and the permission dependency left for the next step', () => {
    const name = readdirSync(resolve(root, 'database/migrations')).find((f) =>
      f.startsWith('0021'),
    );
    expect(name).toBe('0021_student_programs.sql');
    const text = read(`database/migrations/${name}`);
    expect(text).toMatch(/ROLLOUT:/);
    expect(text).toMatch(/runs only after 0019/);
    // The permission row is deliberately NOT registered here (it must ship with catalog.ts and the role matrix).
    expect(text.replace(/--[^\n]*/g, '')).not.toMatch(/platform\.permissions/);
    expect(text).toMatch(/student\.program\.assign/);
  });

  it('0023 (student.directory.search) is NOT a contract migration; it only upserts the permission row and documents the seeding order and the rollout gate', () => {
    const name = readdirSync(resolve(root, 'database/migrations')).find((f) =>
      f.startsWith('0023'),
    );
    expect(name).toBe('0023_student_directory_search_permission.sql');
    const text = read(`database/migrations/${name}`);
    const code = text.replace(/--[^\n]*/g, '');
    expect(text).toMatch(/ROLLOUT:/);
    expect(text).toMatch(/runs only after 0019/);
    expect(text).toMatch(/seedTenantRoles/);
    expect(code).toMatch(/INSERT INTO platform\.permissions/);
    expect(code).toMatch(/ON CONFLICT \(code\) DO UPDATE SET sensitivity = EXCLUDED\.sensitivity/);
    expect(code).toMatch(/'student\.directory\.search', 'SENSITIVE'/);
    // nothing but the registration: no DDL, no role grants (those are seeded from ROLE_MATRIX per tenant)
    expect(code.replace(/DO UPDATE SET/, '')).not.toMatch(
      /\b(CREATE|ALTER|DROP|GRANT|DELETE|UPDATE)\b/i,
    );
    expect(code).not.toMatch(/role_permissions/);
  });

  it('0022 (student.program.assign) is NOT a contract migration; it only upserts the permission row and documents the seeding order and the rollout gate', () => {
    const name = readdirSync(resolve(root, 'database/migrations')).find((f) =>
      f.startsWith('0022'),
    );
    expect(name).toBe('0022_student_program_assign_permission.sql');
    const text = read(`database/migrations/${name}`);
    const code = text.replace(/--[^\n]*/g, '');
    expect(text).toMatch(/ROLLOUT:/);
    expect(text).toMatch(/runs only after 0019/);
    expect(text).toMatch(/seedTenantRoles/);
    expect(code).toMatch(/INSERT INTO platform\.permissions/);
    expect(code).toMatch(/ON CONFLICT \(code\) DO UPDATE SET sensitivity = EXCLUDED\.sensitivity/);
    expect(code).toMatch(/'student\.program\.assign', 'SENSITIVE'/);
    // nothing but the registration: no DDL, no role grants (those are seeded from ROLE_MATRIX per tenant)
    expect(code.replace(/DO UPDATE SET/, '')).not.toMatch(
      /\b(CREATE|ALTER|DROP|GRANT|DELETE|UPDATE)\b/i,
    );
    expect(code).not.toMatch(/role_permissions/);
  });

  it('0020 (person-identity backstop) is NOT a contract migration; it documents that the runner defers it behind 0019 and that the backstop is inactive until then', () => {
    const name = readdirSync(resolve(root, 'database/migrations')).find((f) =>
      f.startsWith('0020'),
    );
    expect(name).toBe('0020_student_staff_role_exclusivity.sql');
    const text = read(`database/migrations/${name}`);
    expect(text).toMatch(/ROLLOUT DEPENDENCY/);
    expect(text).toMatch(/INACTIVE until/);
    expect(text).toMatch(/--allow-contract 0019/);
    expect(read('docs/runbooks/students-contract-rollout.md')).toMatch(/backstop is INACTIVE/);
  });
});

describe('contract gate: no code path authorises a contract migration implicitly', () => {
  const nonTest = [...code('tools'), ...code('scripts'), ...code('src')];

  it('allowContract appears only in the runner and the CLI (flag only); never in dev:db, scripts or the app', () => {
    const users = nonTest
      .filter((f) => /allowContract/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual(['tools/db/cli.ts', 'tools/db/migrate.ts']);
    const cli = nonTest.find((f) => f.path === 'tools/db/cli.ts')?.text ?? '';
    expect(cli).toMatch(/--allow-contract/);
    expect(/MIGRATE_ALLOW|ALLOW_CONTRACT/i.test(cli)).toBe(false); // no environment-variable bypass
  });

  it('every call of migrate() outside tests goes through the gate with no opt-in (dev:db) or the CLI flag', () => {
    const callers = nonTest.filter(
      (f) => /\bmigrate\(/.test(f.text) && !f.path.startsWith('tools/db/migrate.ts'),
    );
    expect(callers.map((f) => f.path).sort()).toEqual(['scripts/dev-db.ts', 'tools/db/cli.ts']);
    expect(callers.find((f) => f.path === 'scripts/dev-db.ts')?.text).not.toMatch(/allowContract/);
  });

  it('tests authorise contract migrations only on disposable databases (global setup and migration tests)', () => {
    const tests = code('tests').filter((f) => /allowContract|contractVersions/.test(f.text));
    expect(tests.map((f) => f.path).sort()).toEqual([
      'tests/integration/migration-0017.test.ts',
      'tests/integration/migration-0019.test.ts',
      'tests/integration/migration-0020.test.ts',
      'tests/integration/migration-contract.test.ts',
      'tests/integration/migrations.test.ts',
      'tests/integration/person-record-exclusivity.test.ts',
      'tests/integration/student-atomicity.test.ts',
      'tests/security/academic-structure-static.test.ts',
      'tests/support/global-db.ts',
      'tests/unit/migrate-plan.test.ts',
    ]);
  });
});

describe('role_assignments writers satisfy the typed-scope contract', () => {
  it('every INSERT either writes campus_id and department_id next to scope_id, or never sets a scope id', () => {
    const files = [...code('src'), ...code('scripts'), ...code('tests')];
    let seen = 0;
    for (const f of files) {
      for (const m of f.text.matchAll(
        /INSERT INTO app\.role_assignments\s*\(([^)]*)\)([\s\S]*?)`/g,
      )) {
        seen++;
        const cols = m[1] ?? '';
        const rest = m[2] ?? '';
        const typed = /\bcampus_id\b/.test(cols) && /\bdepartment_id\b/.test(cols);
        const noScope = !/\bscope_id\b/.test(cols);
        const orgOnly = /'ORGANIZATION',\s*NULL/.test(rest);
        expect(typed || noScope || orgOnly, `${f.path}: ${cols.replace(/\s+/g, ' ')}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(7);
  });

  it('the services keep the documented lock order: campus before department, never a plan-dependent multi-row lock', () => {
    const svc = stripTs(
      readFileSync(resolve(backend, 'src/shared/authorization/assignments.ts'), 'utf8'),
    );
    expect(svc).not.toMatch(/FOR SHARE OF/); // one locked row per statement
    expect(svc.indexOf('FROM app.campuses')).toBeGreaterThan(-1);
    expect(svc.indexOf('FROM app.campuses')).toBeLessThan(svc.lastIndexOf('FROM app.departments'));

    const deptSvc = stripTs(
      readFileSync(resolve(backend, 'src/modules/organization/department.service.ts'), 'utf8'),
    );
    expect(deptSvc).not.toMatch(/FOR SHARE OF/);
    expect(deptSvc.indexOf('FROM app.campuses')).toBeGreaterThan(-1);
    expect(deptSvc.indexOf('FROM app.campuses')).toBeLessThan(
      deptSvc.indexOf('FROM app.departments'),
    );
  });

  it('the campus and department services are the only writers in src, and never update immutable columns', () => {
    const campusWriters = code('src').filter((f) =>
      /\b(INSERT INTO|UPDATE)\s+app\.campuses\b/.test(f.text),
    );
    expect(campusWriters.map((f) => f.path)).toEqual([
      'src/modules/organization/campus.service.ts',
    ]);
    for (const m of campusWriters[0]?.text.matchAll(
      /UPDATE\s+app\.campuses\s+SET\s+([\s\S]*?)\s+WHERE/g,
    ) ?? []) {
      const setClause = m[1] ?? '';
      for (const col of ['id', 'organization_id', 'code', 'timezone']) {
        expect(setClause).not.toMatch(new RegExp(`\\b${col}\\s*=`, 'i'));
      }
    }

    const deptWriters = code('src').filter((f) =>
      /\b(INSERT INTO|UPDATE)\s+app\.departments\b/.test(f.text),
    );
    expect(deptWriters.map((f) => f.path)).toEqual([
      'src/modules/organization/department.service.ts',
    ]);
    for (const m of deptWriters[0]?.text.matchAll(
      /UPDATE\s+app\.departments\s+SET\s+([\s\S]*?)\s+WHERE/g,
    ) ?? []) {
      const setClause = m[1] ?? '';
      for (const col of [
        'id',
        'organization_id',
        'campus_id',
        'parent_department_id',
        'code',
        'kind',
      ]) {
        expect(setClause).not.toMatch(new RegExp(`\\b${col}\\s*=`, 'i'));
      }
    }
  });
});

// The empty-ledger exemption in tools/db/migrate.ts (planMigrations: the phase rule applies only when `done.size > 0`)
// lets a BRAND-NEW database be built in one pass 0001..0009. That is safe only because the three tables 0009 rewrites
// are created by a plain `CREATE TABLE` in the same pass: if one of them already existed (legacy rows, a lost
// ledger), the pass would stop at that statement and never reach 0009. `IF NOT EXISTS` on any of them, or a second
// creator, would silently open that bypass (integration proof: tests/integration/migration-contract.test.ts).
describe('empty-ledger exemption premise: the contract tables are created by a plain CREATE TABLE', () => {
  const migrations = readdirSync(resolve(root, 'database/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: noComments(read(`database/migrations/${file}`)) }));
  const creations = (table: string): { file: string; statement: string }[] =>
    migrations.flatMap((m) =>
      [
        ...m.sql.matchAll(
          new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?app\\.${table}\\s*\\(`, 'gi'),
        ),
      ].map((hit) => ({ file: m.file, statement: hit[0].replace(/\s+/g, ' ') })),
    );

  it.each([
    ['role_assignments', '0005_authorization.sql'],
    ['campuses', '0008_academic_structure.sql'],
    ['departments', '0008_academic_structure.sql'],
  ])(
    'app.%s is created exactly once, by a plain CREATE TABLE (never IF NOT EXISTS)',
    (table, file) => {
      expect(creations(table)).toEqual([{ file, statement: `CREATE TABLE app.${table} (` }]);
    },
  );
});
