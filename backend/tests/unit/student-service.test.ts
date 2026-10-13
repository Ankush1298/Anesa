import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../../src/shared/database/index.js';
import { StudentService } from '../../src/modules/students/student.service.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

// StudentService.create against a scripted transaction (no database): the mapping of the database's own refusals
// (migration 0016 guard, unique constraints) to controlled 409s, and the order of checks.

const ctx = issueTrustedContext({
  tenantId: '01939a00-0000-7000-8000-000000000a01',
  userId: '01939a00-0000-7000-8000-00000000aa03',
  actorKind: 'STAFF',
});
const USER = '01939a00-0000-7000-8000-00000000aa77';
const KEY = '0123456789abcdef0123456789abcdef';
const input = {
  userId: USER,
  admissionNumber: 'ADM-1',
  admissionDate: '2024-07-01',
  reason: 'Admitted after counselling',
};

interface Script {
  grants?: { scope_mode: string; scope_type: string; scope_id: string | null }[];
  userStatus?: string | null;
  activeRole?: boolean;
  employee?: boolean;
  insertError?: { code: string; constraint?: string };
}
function scripted(s: Script = {}): { tx: TenantTx; seen: string[] } {
  const seen: string[] = [];
  const grants = s.grants ?? [
    { scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null },
  ];
  const tx = {
    query: (text: string) => {
      seen.push(text.replace(/\s+/g, ' ').trim().slice(0, 48));
      if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (text.includes('JOIN app.role_permissions'))
        return Promise.resolve({ rows: grants, rowCount: grants.length });
      if (text.includes('INSERT INTO app.idempotency_keys'))
        return Promise.resolve({ rows: [{}], rowCount: 1 });
      if (text.includes('UPDATE app.idempotency_keys'))
        return Promise.resolve({ rows: [], rowCount: 1 });
      if (text.includes('FROM app.users')) {
        const rows = s.userStatus === null ? [] : [{ status: s.userStatus ?? 'ACTIVE' }];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (text.includes('FROM app.role_assignments')) {
        return Promise.resolve({ rows: [], rowCount: s.activeRole ? 1 : 0 });
      }
      if (text.includes('FROM app.employees')) {
        return Promise.resolve({ rows: [], rowCount: s.employee ? 1 : 0 });
      }
      if (text.includes('INSERT INTO app.students')) {
        return s.insertError
          ? Promise.reject(Object.assign(new Error('pg'), s.insertError))
          : Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('INSERT INTO app.audit_events'))
        return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.reject(new Error(`unscripted statement: ${text.slice(0, 60)}`));
    },
  } as unknown as TenantTx;
  return { tx, seen };
}
const run = (s: Script, body = input, ...key: [unknown?]) =>
  StudentService.create(scripted(s).tx, ctx, body, {
    idempotencyKey: key.length > 0 ? key[0] : KEY,
  });

describe('StudentService.create: database refusals become controlled 409s', () => {
  it('the exclusivity guard of migration 0016 (23P01 + person_record_exclusive) ⇒ 409 employee record', async () => {
    await expect(
      run({ insertError: { code: '23P01', constraint: 'person_record_exclusive' } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'This account already has an employee record or a staff role assignment.',
    });
  });

  it('a 23P01 from any OTHER constraint is not mapped (it stays an unexpected error)', async () => {
    await expect(
      run({ insertError: { code: '23P01', constraint: 'something_else' } }),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('unique violations: one account one record, one admission number once', async () => {
    await expect(
      run({ insertError: { code: '23505', constraint: 'students_org_user_uq' } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'This account already has a student record.',
    });
    await expect(
      run({ insertError: { code: '23505', constraint: 'students_org_adm_uq' } }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'A student with this admission number already exists.',
    });
  });

  it('any other insert error propagates unchanged', async () => {
    await expect(run({ insertError: { code: '40001' } })).rejects.toMatchObject({ code: '40001' });
  });
});

describe('StudentService.create: order of checks', () => {
  it('shape is validated before anything touches the database', async () => {
    const { tx, seen } = scripted();
    await expect(
      StudentService.create(
        tx,
        ctx,
        { ...input, admissionNumber: ' ADM-1' },
        { idempotencyKey: KEY },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(seen).toEqual([]);
  });

  it('permission (403) and organization scope (403) are decided before the idempotency key is looked at', async () => {
    await expect(run({ grants: [] }, input, undefined)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      run(
        { grants: [{ scope_mode: 'GRANTED', scope_type: 'CAMPUS', scope_id: USER }] },
        input,
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(run({}, input, undefined)).rejects.toMatchObject({ statusCode: 428 });
    await expect(run({}, input, 'short')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('target checks: missing 404, not ACTIVE 409, active role 409, employee 409; success is 201 and sets nothing else', async () => {
    await expect(run({ userStatus: null })).rejects.toMatchObject({ statusCode: 404 });
    await expect(run({ userStatus: 'INVITED' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(run({ activeRole: true })).rejects.toMatchObject({ statusCode: 409 });
    await expect(run({ employee: true })).rejects.toMatchObject({ statusCode: 409 });
    const ok = await run({});
    expect(ok.status).toBe(201);
    expect(ok.replayed).toBe(false);
    expect(Object.keys(ok.body).sort()).toEqual(['data', 'success']);
  });

  it('the person lock is the FIRST statement; the account is then locked FOR UPDATE before the role-assignment and employee checks', async () => {
    const { tx, seen } = scripted();
    await StudentService.create(tx, ctx, input, { idempotencyKey: KEY });
    const at = (needle: string): number => seen.findIndex((t) => t.includes(needle));
    expect(seen[0]).toContain('pg_advisory_xact_lock');
    expect(seen.filter((t) => t.includes('pg_advisory_xact_lock'))).toHaveLength(1);
    expect(at('SELECT status FROM app.users')).toBeGreaterThan(
      at('INSERT INTO app.idempotency_keys'),
    );
    expect(at('SELECT 1 FROM app.role_assignments')).toBeGreaterThan(
      at('SELECT status FROM app.users'),
    );
    expect(at('SELECT 1 FROM app.employees')).toBeGreaterThan(
      at('SELECT 1 FROM app.role_assignments'),
    );
    expect(at('INSERT INTO app.students')).toBeGreaterThan(at('SELECT 1 FROM app.employees'));
  });
});
