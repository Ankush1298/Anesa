import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for the Students slice, Phase 1 (no database needed).
const backend = resolve(import.meta.dirname, '../..');
const repo = resolve(backend, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const sql0017 = readFileSync(
  join(repo, 'database/migrations/0017_students_record_fields.sql'),
  'utf8',
);
/** Executable SQL only: comments removed so prose cannot satisfy or trip a pattern. */
const code0017 = sql0017.replace(/--[^\n]*/g, '');

describe('Students: exactly one source file writes app.students (the audited service)', () => {
  it('only modules/students/student.service.ts inserts app.students, and nothing updates it yet', () => {
    // Status, update and correction workflows are later phases; when one ships, extend this allowlist deliberately.
    const writers: string[] = [];
    for (const f of walk(join(backend, 'src'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/UPDATE\s+app\.students/i);
      expect(text, f).not.toMatch(/DELETE\s+FROM\s+app\.students/i);
      if (/INSERT\s+INTO\s+app\.students/i.test(text)) writers.push(f.slice(backend.length + 1));
    }
    expect(writers).toEqual(['src/modules/students/student.service.ts']);
  });

  it('the student service reaches role assignments only through the authorization layer and never grants roles', () => {
    const text = readFileSync(join(backend, 'src/modules/students/student.service.ts'), 'utf8');
    expect(text).not.toMatch(/role_assignments/);
    expect(text).toMatch(/AuthorizationEngine\.hasActiveAssignment\(/);
    expect(text).not.toMatch(/RoleAssignmentService|seedTenantRoles/);
  });

  it('the student routes expose exactly POST / and GET /:id (no list, PATCH, DELETE or status route yet)', () => {
    const text = readFileSync(join(backend, 'src/modules/students/student.routes.ts'), 'utf8');
    const verbs = [...text.matchAll(/app\.(get|post|put|patch|delete)</g)].map((m) => m[1]);
    expect(verbs.sort()).toEqual(['get', 'post']);
    expect(text).toMatch(/permission: 'student\.record\.create'/);
    expect(text).toMatch(/permission: 'student\.profile\.read'/);
  });
});

describe('0017 is an expand step: no backfill, no row-security weakening, no NOT NULL', () => {
  it('never touches existing rows or row security', () => {
    expect(code0017).not.toMatch(/\bUPDATE\s+app\./i);
    expect(code0017).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code0017).not.toMatch(/\bNO\s+FORCE\b/i);
    expect(code0017).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(code0017).not.toMatch(/SET\s+NOT\s+NULL/i);
    expect(code0017).not.toMatch(/ADD\s+COLUMN\s+admission_date[^;]*(NOT\s+NULL|DEFAULT)/i);
    expect(code0017).not.toMatch(/ADD\s+COLUMN\s+status_changed_at[^;]*(NOT\s+NULL|DEFAULT)/i);
  });

  it('adds the default of status_changed_at only after the column exists, and the checks are NOT VALID', () => {
    const add = code0017.search(/ADD\s+COLUMN\s+status_changed_at/i);
    const setDefault = code0017.search(/ALTER\s+COLUMN\s+status_changed_at\s+SET\s+DEFAULT/i);
    expect(add).toBeGreaterThan(-1);
    expect(setDefault).toBeGreaterThan(add);
    for (const col of ['admission_date', 'status_changed_at']) {
      expect(code0017).toMatch(
        new RegExp(`CHECK\\s*\\(${col}\\s+IS\\s+NOT\\s+NULL\\)\\s+NOT\\s+VALID`, 'i'),
      );
    }
  });

  it('revokes exactly UPDATE (user_id, admission_number) from the runtime role and adds the STAFF-only restrictive policy', () => {
    expect(code0017).toMatch(
      /REVOKE\s+UPDATE\s*\(\s*user_id\s*,\s*admission_number\s*\)\s+ON\s+app\.students\s+FROM\s+app_runtime/i,
    );
    expect(code0017).not.toMatch(/GRANT\s+UPDATE/i);
    const policy = /CREATE POLICY students_staff_update[^;]*;/i.exec(code0017)?.[0] ?? '';
    expect(policy).toMatch(/AS RESTRICTIVE FOR UPDATE TO app_runtime/i);
    expect(policy).toMatch(/USING\s*\(app\.current_actor_kind\(\) = 'STAFF'\)/);
    expect(policy).toMatch(/WITH CHECK\s*\(app\.current_actor_kind\(\) = 'STAFF'\)/);
  });

  it('the guard function follows the repo conventions (invoker, pinned search_path, no PUBLIC execute)', () => {
    const fn = /CREATE FUNCTION app\.students_guard\(\)[\s\S]*?\$\$;/i.exec(code0017)?.[0] ?? '';
    expect(fn).toMatch(/SET search_path = pg_catalog/);
    expect(fn).not.toMatch(/SECURITY DEFINER/i);
    expect(code0017).toMatch(/REVOKE ALL ON FUNCTION app\.students_guard\(\) FROM PUBLIC/);
  });

  it('keeps a bounded lock wait, like the other schema-changing migrations', () => {
    expect(code0017).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });
});

describe('fixtures match the schema version they are seeded into (no database needed)', () => {
  const fixtures = readFileSync(join(backend, 'tests/support/fixtures.ts'), 'utf8');
  const legacyBlock =
    /if \(options\.legacyStudentShape\) \{([\s\S]*?)\} else \{([\s\S]*?)\n {4}\}\n/.exec(fixtures);
  const columnsOf = (block: string): string[] =>
    (/INSERT INTO app\.students \(([^)]*)\)/.exec(block)?.[1] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

  it('the legacy student shape uses only columns that exist in the original 0002 table; the default shape adds admission_date', () => {
    expect(legacyBlock).not.toBeNull();
    const legacy = columnsOf(legacyBlock?.[1] ?? '');
    const current = columnsOf(legacyBlock?.[2] ?? '');
    expect(legacy.length).toBeGreaterThan(0);
    const table0002 = /CREATE TABLE app\.students \(([\s\S]*?)\n\);/.exec(
      readFileSync(join(repo, 'database/migrations/0002_core_tables.sql'), 'utf8'),
    )?.[1];
    expect(table0002).toBeDefined();
    for (const col of legacy) expect(table0002, col).toMatch(new RegExp(`\\b${col}\\b`));
    expect(legacy).not.toContain('admission_date');
    expect(current).toContain('admission_date');
  });

  it('only the 0008-schema legacy helper opts into the legacy shape, and it stops at the ordinary migration run', () => {
    const offenders: string[] = [];
    for (const dir of ['tests/integration', 'tests/security-db', 'tests/support']) {
      for (const f of walk(join(backend, dir))) {
        if (/legacyStudentShape/.test(readFileSync(f, 'utf8')) && !f.endsWith('fixtures.ts')) {
          offenders.push(f.slice(backend.length + 1));
        }
      }
    }
    expect(offenders).toEqual(['tests/integration/migration-contract.test.ts']);

    const contract = readFileSync(join(backend, offenders[0] ?? ''), 'utf8');
    const helper = /async function legacyDatabase\(\)[\s\S]*?\n\}\n/.exec(contract)?.[0] ?? '';
    expect(helper).toMatch(/migrate\(\{ connectionString: db\.migrator \}\)/); // ordinary run only: 0001-0008
    expect(helper).toMatch(/seedFixtures\(db\.admin, \{ legacyStudentShape: true \}\)/);
  });
});
