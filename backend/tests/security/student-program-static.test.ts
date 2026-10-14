import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for student program enrolment (no database needed). Text-based: dynamically built SQL could evade them,
// like the sibling gate for app.students (students-static.test.ts).
const backend = resolve(import.meta.dirname, '../..');
const src = join(backend, 'src');
const rel = (f: string): string => f.slice(backend.length + 1);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(src).map((f) => ({ path: rel(f), text: readFileSync(f, 'utf8') }));
const SERVICE = 'src/modules/students/student-program.service.ts';
const DIRECTORY = 'src/modules/students/student-directory.service.ts';
const DEPT = 'src/modules/organization/department.service.ts';
const ACADEMIC = 'src/modules/academics/academic.service.ts';
const text = (path: string): string => files.find((f) => f.path === path)!.text;

/** The body of `static async <name>(` up to the next `static async` (or the end of the class). */
function method(source: string, name: string): string {
  const start = source.indexOf(`static async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf('static async ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}
const before = (haystack: string, a: string | RegExp, b: string | RegExp): void => {
  const ia = typeof a === 'string' ? haystack.indexOf(a) : haystack.search(a);
  const ib = typeof b === 'string' ? haystack.indexOf(b) : haystack.search(b);
  expect(ia, String(a)).toBeGreaterThan(-1);
  expect(ib, String(b)).toBeGreaterThan(-1);
  expect(ia, `${String(a)} must precede ${String(b)}`).toBeLessThan(ib);
};

describe('only StudentProgramService writes app.student_programs and app.student_program_events', () => {
  const TABLE = /app\.student_program(s|_events)\b/;
  const WRITE =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+app\.student_program(s|_events)\b/i;

  it('no other source file names the tables except the two deactivation guards and the directory lookup, which only read', () => {
    const naming = files.filter((f) => TABLE.test(f.text)).map((f) => f.path);
    expect(naming.sort()).toEqual([ACADEMIC, DEPT, DIRECTORY, SERVICE].sort());
    const writers = files.filter((f) => WRITE.test(f.text)).map((f) => f.path);
    expect(writers).toEqual([SERVICE]);
    for (const guard of [DEPT, ACADEMIC, DIRECTORY]) {
      expect(text(guard)).not.toMatch(/(INSERT|UPDATE|DELETE|TRUNCATE)[^;`]{0,40}student_program/i);
    }
  });

  it('the service inserts the enrolment and both events, updates only the three close columns, and never deletes', () => {
    const svc = text(SERVICE);
    expect(svc).toMatch(/INSERT INTO app\.student_programs\b/);
    expect(svc.match(/INSERT INTO app\.student_program_events\b/g)).toHaveLength(2);
    expect(svc).not.toMatch(/DELETE\s+FROM|TRUNCATE/i);
    expect(svc).not.toMatch(/UPDATE\s+app\.student_program_events/i);
    const updates = svc.match(/UPDATE\s+app\.student_programs[\s\S]*?WHERE/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(
      /SET\s+status = \$3, end_date = \$4::date, exit_reason = \$5\s+WHERE/,
    );
  });

  it('the service never writes students, users or role assignments, and never takes a user or advisory lock', () => {
    const svc = text(SERVICE)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(svc).not.toMatch(
      /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.(students|users|role_assignments)\b/i,
    );
    expect(svc).not.toMatch(/FROM\s+app\.users\b/i);
    expect(svc).not.toMatch(/pg_advisory|lockPersonIdentity/);
  });

  it('every write goes through the audited path: each write method records an audit event with the documented action', () => {
    const svc = text(SERVICE);
    expect(method(svc, 'open')).toMatch(/action: 'student_program\.open'/);
    expect(method(svc, 'close')).toMatch(/action: 'student_program\.close'/);
    expect(method(svc, 'open')).toMatch(/recordAudit\(/);
    expect(method(svc, 'close')).toMatch(/recordAudit\(/);
    // enrolment write, then event, then audit (the migration 0021 event guard reads the enrolment as this transaction left it)
    const open = method(svc, 'open');
    before(open, 'INSERT INTO app.student_programs', 'INSERT INTO app.student_program_events');
    before(open, 'INSERT INTO app.student_program_events', 'recordAudit(');
    const close = method(svc, 'close');
    before(close, 'UPDATE app.student_programs', 'INSERT INTO app.student_program_events');
    before(close, 'INSERT INTO app.student_program_events', 'recordAudit(');
  });
});

describe('the service keeps its documented order: permission, scope, key, then locks top-down', () => {
  it('open: permission (403) -> program scope -> idempotency key -> claim -> student, campus, department, program, cohort', () => {
    const open = method(text(SERVICE), 'open');
    before(open, 'PROGRAM_ASSIGN_PERMISSION);', 'FROM app.programs p');
    before(open, 'FROM app.programs p', 'parseIdempotencyKey(');
    before(open, 'parseIdempotencyKey(', 'runIdempotent(');
    before(open, 'runIdempotent(', 'FROM app.students');
    before(open, 'FROM app.students', 'FROM app.campuses');
    before(open, 'FROM app.campuses', 'FROM app.departments');
    before(open, 'FROM app.departments', 'FROM app.programs\n');
    before(open, /FROM app\.programs\n/, 'FROM app.cohorts');
    expect(open).toMatch(/FROM app\.students[\s\S]*?FOR NO KEY UPDATE/);
    for (const t of ['campuses', 'departments', 'programs', 'cohorts']) {
      expect(open).toMatch(new RegExp(`FROM app\\.${t}[\\s\\S]*?FOR SHARE`));
    }
  });

  it('close: permission -> enrolment row lock -> frozen-scope check -> version/state -> write', () => {
    const close = method(text(SERVICE), 'close');
    before(close, 'PROGRAM_ASSIGN_PERMISSION);', 'FOR NO KEY UPDATE');
    before(close, 'FOR NO KEY UPDATE', 'campus_id: row.campus_id');
    before(close, 'campus_id: row.campus_id', 'Enrolment version mismatch');
    before(close, 'Enrolment version mismatch', 'UPDATE app.student_programs');
    expect(close).toMatch(/AND version = \$6 AND status = 'ACTIVE'/);
  });

  it('student-specific refusals are generic: no student status or admission date reaches a message', () => {
    const svc = text(SERVICE);
    expect(svc).not.toMatch(/\$\{stu\./);
    expect(svc).not.toMatch(/(conflict|invalid)\([^)]*(admission date|status \$\{)/i);
  });
});

describe('the deactivation guards stay in their service paths (enrolment-guards.test.ts proves the behaviour)', () => {
  it('department update: after the department lock, only when going ACTIVE -> INACTIVE, before the UPDATE', () => {
    const upd = method(text(DEPT), 'update');
    before(
      upd,
      'FOR NO KEY UPDATE',
      "assertNoActiveEnrolments(tx, ctx, departmentId, 'deactivate')",
    );
    before(
      upd,
      "assertNoActiveEnrolments(tx, ctx, departmentId, 'deactivate')",
      'UPDATE app.departments',
    );
    before(
      upd,
      "AuthorizationEngine.assert(tx, ctx, 'org.department.manage'",
      'assertNoActiveEnrolments(',
    );
    expect(upd).toMatch(
      /input\.status === 'INACTIVE' && lockedRow\.status === 'ACTIVE'\) \{\s+await assertNoActiveEnrolments/,
    );
  });

  it('department soft delete: after the department lock and authorization, before the UPDATE', () => {
    const del = method(text(DEPT), 'softDelete');
    before(del, 'FOR NO KEY UPDATE', "assertNoActiveEnrolments(tx, ctx, departmentId, 'delete')");
    before(del, "assertNoActiveEnrolments(tx, ctx, departmentId, 'delete')", 'SET deleted_at');
    before(
      del,
      "AuthorizationEngine.assert(tx, ctx, 'org.department.manage'",
      'assertNoActiveEnrolments(',
    );
  });

  it('the helper is a plain tenant-scoped read of ACTIVE enrolments by department (no lock, 409)', () => {
    const dept = text(DEPT);
    const helper = dept.slice(dept.indexOf('async function assertNoActiveEnrolments'));
    const body = helper.slice(0, helper.indexOf('\n}\n'));
    expect(body).toMatch(
      /FROM app\.student_programs\s+WHERE organization_id = \$1 AND department_id = \$2 AND status = 'ACTIVE'/,
    );
    expect(body).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/);
    expect(body).toMatch(/new AppError\(\s*409,\s*'CONFLICT'/);
  });

  it('cohort update: after the cohort lock and authorization, only when leaving ACTIVE, before the UPDATE', () => {
    const upd = method(text(ACADEMIC), 'update');
    // CohortService.update is the last `update`; take the slice that starts at its own signature
    const cohort = text(ACADEMIC).slice(text(ACADEMIC).indexOf('export class CohortService'));
    const body = method(cohort, 'update');
    expect(upd.length).toBeGreaterThan(0);
    before(body, 'FOR NO KEY UPDATE', 'FROM app.student_programs');
    before(
      body,
      "AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage', {",
      'FROM app.student_programs',
    );
    before(body, 'FROM app.student_programs', 'UPDATE app.cohorts');
    expect(body).toMatch(/row\.status === 'ACTIVE' && finalStatus !== 'ACTIVE'/);
    expect(body).toMatch(
      /FROM app\.student_programs\s+WHERE organization_id = \$1 AND cohort_id = \$2 AND status = 'ACTIVE'/,
    );
    expect(body).toMatch(/new AppError\(\s*409,\s*'CONFLICT'/);
  });
});

describe('the enrolment routes cannot weaken the service contract', () => {
  const routes = (): string =>
    text('src/modules/students/student.routes.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it('If-Match is parsed only by parseIfMatch; the route never names or builds an "unconditional" expected version', () => {
    expect(routes()).toMatch(/parseIfMatch\(typeof header === 'string' \? header : undefined\)/);
    expect(routes()).not.toMatch(/unconditional/);
    expect(routes()).not.toMatch(/type:\s*'(unconditional|exists|initial|version)'/);
  });

  it('parseIfMatch never yields "unconditional" for any header value', async () => {
    const { parseIfMatch } = await import('../../src/shared/settings/index.js');
    const samples = [
      '*',
      '"*"',
      '0',
      'null',
      '"1"',
      '1',
      '12',
      ' "3" ',
      '',
      ' ',
      'W/"1"',
      'abc',
      '-1',
      '1.5',
      '"',
      'unconditional',
    ];
    for (const h of samples) {
      let type: string | undefined;
      try {
        type = parseIfMatch(h).type;
      } catch {
        type = undefined; // 428 / 400
      }
      expect(type, JSON.stringify(h)).not.toBe('unconditional');
    }
    expect(() => parseIfMatch(undefined)).toThrow();
  });

  it('the idempotency key is passed raw to the service, and the user, tenant and scope come only from the request context', () => {
    expect(routes()).toMatch(/const idempotencyKey = req\.headers\['idempotency-key'\];/);
    expect(routes()).not.toMatch(/parseIdempotencyKey/);
    const schemas = text('src/modules/students/student.schemas.ts');
    const body = schemas.slice(schemas.indexOf('export const OpenStudentProgramBodySchema'));
    const open = body.slice(0, body.indexOf('export type OpenStudentProgramBody'));
    const close = body.slice(
      body.indexOf('export const CloseStudentProgramBodySchema'),
      body.indexOf('export type CloseStudentProgramBody'),
    );
    for (const schema of [open, close]) {
      expect(schema).toMatch(/additionalProperties: false/);
      expect(schema).not.toMatch(/campus|department|organization|entryType|previous|status/i);
    }
  });
});

describe('the student directory lookup stays an exact, single-row, read-only, scoped query', () => {
  const dir = (): string =>
    text('src/modules/students/student-directory.service.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  it('reads only, with no name matching, no paging and exactly one SQL statement carrying the scope filter', () => {
    const src = dir();
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(src).not.toMatch(/\bI?LIKE\b|similarity|pg_trgm|to_tsvector|OFFSET|\bcursor\b/i);
    expect(src.match(/tx\.query</g)).toHaveLength(1);
    expect(src).toMatch(/WHERE s\.organization_id = \$1 AND s\.admission_number = \$2/);
    expect(src).toMatch(/LIMIT 1/);
    // scope: placed students only inside the caller's campus/department grants, org-wide holders unrestricted
    expect(src).toMatch(/\$3::boolean/);
    expect(src).toMatch(
      /sp\.campus_id = ANY\(\$4::uuid\[\]\) OR sp\.department_id = ANY\(\$5::uuid\[\]\)/,
    );
    // the scope inputs come from the caller's grants, never from the request
    expect(src).toMatch(/AuthorizationEngine\.loadGrants\(tx, ctx, DIRECTORY_SEARCH_PERMISSION\)/);
  });

  it('the DTO and the route expose only the reviewed fields and the two query-free inputs', () => {
    const schemas = text('src/modules/students/student.schemas.ts');
    const dto = schemas.slice(schemas.indexOf('export const StudentDirectoryEntrySchema'));
    const body = dto.slice(0, dto.indexOf('export type StudentDirectoryEntry'));
    expect(body.match(/^\s{4}\w+:/gm)?.map((l) => l.trim().split(':')[0])).toEqual([
      'id',
      'admissionNumber',
      'displayName',
      'status',
      'hasActiveEnrolment',
    ]);
    expect(body).toMatch(/additionalProperties: false/);
    const q = schemas.slice(
      schemas.indexOf('export const StudentLookupQuerySchema'),
      schemas.indexOf('export type StudentLookupQuery'),
    );
    expect(q).toMatch(/admissionNumber/);
    expect(q).toMatch(/additionalProperties: false/);
    expect(q).not.toMatch(/limit|offset|cursor|name|organization|campus|department/i);
  });
});
