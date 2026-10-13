import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../../src/shared/database/index.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

// RoleAssignmentService.grant against a SCRIPTED transaction (no database): the person-identity rules that live in the
// SERVICE (docs/architecture/v3/21-students.md §6), proven independently of the migration 0020 trigger.
//  * a STUDENT role requires an existing student record: a service-only rule, the database does not impose it;
//  * any other role is refused on an account that has a student record.
// The scripted transaction ALWAYS accepts the INSERT (as if no trigger existed), so a rejection seen here can only come
// from the service's own check, and a missing check would make the first test fail by letting the insert happen.

const TENANT = '01939a00-0000-7000-8000-000000000a01';
const GRANTOR = '01939a00-0000-7000-8000-00000000aa03';
const TARGET = '01939a00-0000-7000-8000-00000000aa77';
const ROLE_ID = '01939a00-0000-7000-8000-00000000c001';
const ctx = issueTrustedContext({ tenantId: TENANT, userId: GRANTOR, actorKind: 'STAFF' });

interface Script {
  /** the role code stored for ROLE_ID */
  role: string;
  /** does the target have a row in app.students? */
  studentRecord: boolean;
  /** does the grantor hold role.assignment.grant? (default yes) */
  mayGrant?: boolean;
  /** the grantor's own role assignment, as read by assertMayManage (default COLLEGE_ADMIN, which may grant every role) */
  grantorRole?: string;
  /** make the INSERT fail like the 0020 trigger would */
  insertError?: { code: string; constraint?: string };
}

function scripted(s: Script): { tx: TenantTx; seen: string[]; inserts: unknown[][] } {
  const seen: string[] = [];
  const inserts: unknown[][] = [];
  const tx = {
    query: (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      seen.push(sql.slice(0, 60));
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (sql.includes('JOIN app.role_permissions')) {
        // AuthorizationEngine.loadGrants for role.assignment.grant
        const rows =
          s.mayGrant === false
            ? []
            : [{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes('SELECT r.code, ra.scope_type, ra.scope_id')) {
        // assertMayManage: the grantor's own assignments (COLLEGE_ADMIN may grant every role)
        return Promise.resolve({
          rows: [
            { code: s.grantorRole ?? 'COLLEGE_ADMIN', scope_type: 'ORGANIZATION', scope_id: null },
          ],
          rowCount: 1,
        });
      }
      if (sql.startsWith('SELECT 1 FROM app.users'))
        return Promise.resolve({ rows: [{}], rowCount: 1 });
      if (sql.startsWith('SELECT code FROM app.roles')) {
        return Promise.resolve({ rows: [{ code: s.role }], rowCount: 1 });
      }
      if (sql.startsWith('SELECT 1 FROM app.students')) {
        return Promise.resolve({ rows: [], rowCount: s.studentRecord ? 1 : 0 });
      }
      if (sql.startsWith('SELECT 1 FROM app.role_assignments')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // "already has this role": no
      }
      if (sql.startsWith('INSERT INTO app.role_assignments')) {
        inserts.push(params);
        return s.insertError
          ? Promise.reject(Object.assign(new Error('pg'), s.insertError))
          : Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.startsWith('INSERT INTO app.audit_events')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.reject(new Error(`unscripted statement: ${sql.slice(0, 80)}`));
    },
  } as unknown as TenantTx;
  return { tx, seen, inserts };
}

const grant = (tx: TenantTx) =>
  RoleAssignmentService.grant(tx, ctx, {
    targetUserId: TARGET,
    roleId: ROLE_ID,
    scopeType: 'ORGANIZATION',
    reason: 'Granting for the unit test',
  });

describe('RoleAssignmentService.grant: the STUDENT role requires a student record (service rule)', () => {
  it('is REFUSED (409) for an account WITHOUT a student record, and nothing is inserted (the scripted insert would have succeeded)', async () => {
    const { tx, inserts, seen } = scripted({ role: 'STUDENT', studentRecord: false });
    await expect(grant(tx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: expect.stringMatching(
        /STUDENT role can only be granted .* student record/,
      ) as unknown,
    });
    expect(inserts).toEqual([]);
    expect(seen.some((t) => t.startsWith('INSERT INTO app.audit_events'))).toBe(false);
    expect(seen.some((t) => t.startsWith('SELECT 1 FROM app.students'))).toBe(true);
  });

  it('SUCCEEDS for an account WITH a student record: one assignment inserted, one audit event', async () => {
    const { tx, inserts, seen } = scripted({ role: 'STUDENT', studentRecord: true });
    const id = await grant(tx);
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.slice(1, 6)).toEqual([TENANT, TARGET, ROLE_ID, 'ORGANIZATION', null]);
    expect(seen.filter((t) => t.startsWith('INSERT INTO app.audit_events'))).toHaveLength(1);
  });
});

describe('RoleAssignmentService.grant: the opposite direction and the order of checks', () => {
  it('a NON-STUDENT role is REFUSED (409) on an account that HAS a student record, before any insert', async () => {
    const { tx, inserts } = scripted({ role: 'FACULTY', studentRecord: true });
    await expect(grant(tx)).rejects.toMatchObject({
      statusCode: 409,
      message: 'This account has a student record and cannot be given a staff role.',
    });
    expect(inserts).toEqual([]);
  });

  it('a NON-STUDENT role is granted on an account without a student record (no new restriction on staff flows)', async () => {
    const { tx, inserts } = scripted({ role: 'FACULTY', studentRecord: false });
    await grant(tx);
    expect(inserts).toHaveLength(1);
  });

  it('the person lock is the FIRST statement; the student-record check comes after the authorization decision', async () => {
    const { tx, seen } = scripted({ role: 'STUDENT', studentRecord: true });
    await grant(tx);
    expect(seen[0]).toContain('pg_advisory_xact_lock');
    const at = (needle: string): number => seen.findIndex((t) => t.startsWith(needle));
    expect(at('SELECT r.code, ra.scope_type')).toBeGreaterThan(-1); // assertMayManage ran
    expect(at('SELECT 1 FROM app.students')).toBeGreaterThan(at('SELECT r.code, ra.scope_type'));
    expect(at('INSERT INTO app.role_assignments')).toBeGreaterThan(
      at('SELECT 1 FROM app.students'),
    );
  });

  it('a grantor who holds the permission but may NOT grant this role (grant rules) gets 403 and the student-record check never runs', async () => {
    // FACULTY has no entry in GRANT_RULES: assertMayManage refuses, after the permission check passed
    const { tx, seen, inserts } = scripted({
      role: 'STUDENT',
      studentRecord: false,
      grantorRole: 'FACULTY',
    });
    await expect(grant(tx)).rejects.toMatchObject({ statusCode: 403 });
    expect(seen.some((t) => t.startsWith('SELECT r.code, ra.scope_type'))).toBe(true);
    expect(seen.some((t) => t.startsWith('SELECT 1 FROM app.students'))).toBe(false);
    expect(inserts).toEqual([]);
  });

  it('a grantor WITHOUT the permission gets 403 and learns nothing about student records (the check never runs)', async () => {
    const { tx, seen, inserts } = scripted({
      role: 'STUDENT',
      studentRecord: false,
      mayGrant: false,
    });
    await expect(grant(tx)).rejects.toMatchObject({ statusCode: 403 });
    expect(seen.some((t) => t.startsWith('SELECT 1 FROM app.students'))).toBe(false);
    expect(inserts).toEqual([]);
  });

  it('a 23P01 / person_record_exclusive from the insert (the 0020 backstop) is mapped to 409; any other insert error propagates', async () => {
    await expect(
      grant(
        scripted({
          role: 'FACULTY',
          studentRecord: false, // a race: the student record appeared after the check
          insertError: { code: '23P01', constraint: 'person_record_exclusive' },
        }).tx,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      grant(
        scripted({
          role: 'FACULTY',
          studentRecord: false,
          insertError: { code: '23P01', constraint: 'something_else' },
        }).tx,
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});
