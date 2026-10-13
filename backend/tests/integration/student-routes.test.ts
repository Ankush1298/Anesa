import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery } from '../support/db-harness.js';
import { STAFF_B, STUDENT_A, USER_B } from '../support/fixtures.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// HTTP-level tests for POST /api/v1/students and GET /api/v1/students/:id. Targets are users created by THIS file in
// tenant A (unique ids, unique admission numbers via RUN); no assertion counts tenant-wide rows. Everything this file
// commits is removed at the end except audit events, which are append-only by design.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/students';
const RUN = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;
const num = (tag = 'S'): string => `${tag}${RUN}-${++counter}`;

/** Fixture accounts of tenants A and B: used ONLY for cross-tenant checks and read-only requests. */
const FIXTURE_LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  orgAdminB: 'staff.b@college-b.test',
} as const;
type Actor =
  | keyof typeof FIXTURE_LOGINS
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'faculty'
  | 'student'
  | 'registrarOrg'
  | 'registrarCampus';
/** Every committing test works in this private tenant, never in tenant A (see tests/support/isolated-tenant.ts). */
let T!: IsolatedTenant;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 6 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;

const createdUsers: string[] = [];
const createdIdentities: string[] = [];
/** Every Idempotency-Key this file sent, so cleanup never touches another file's rows for the same principal. */
const usedKeys = new Set<string>();

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

/** A new account in tenant A (no student, no employee, no role), straight into the database as the harness. */
async function newUser(status = 'ACTIVE', passwordHash: string | null = null): Promise<string> {
  const id = uuidv7();
  const email = `st-${RUN.toLowerCase()}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, email, passwordHash ?? 'test-hash'],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, $3, $4, $1)`,
    [id, T.orgId, email, status],
  );
  createdUsers.push(id);
  createdIdentities.push(id);
  return id;
}

async function assignRole(
  userId: string,
  role: string,
  scope: { type: 'ORGANIZATION' | 'CAMPUS'; id?: string },
  extra: { status?: string; validFrom?: string; validUntil?: string | null } = {},
): Promise<void> {
  await adminQuery(
    `INSERT INTO app.role_assignments
       (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, status, valid_from, valid_until)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid, $6::uuid, NULL, $7::text,
            COALESCE($8::timestamptz, now() - interval '1 minute'), $9::timestamptz
       FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
    [
      uuidv7(),
      T.orgId,
      userId,
      role,
      scope.type,
      scope.id ?? null,
      extra.status ?? 'ACTIVE',
      extra.validFrom ?? null,
      extra.validUntil ?? null,
    ],
  );
}

function get(user: Actor | null, path: string) {
  return app.inject({
    method: 'GET',
    url: path,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
}

interface SendOpts {
  key?: string | null;
  csrf?: string;
  headers?: Record<string, string>;
}
function post(user: Actor | null, payload: InjectOptions['payload'], opts: SendOpts = {}) {
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  const key = opts.key === undefined ? randomUUID() : opts.key;
  if (key !== null) usedKeys.add(key);
  return app.inject({
    method: 'POST',
    url: BASE,
    ...(payload !== undefined ? { payload } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(key !== null ? { 'idempotency-key': key } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

const body = (userId: string, extra: object = {}) => ({
  userId,
  admissionNumber: num(),
  admissionDate: '2024-07-01',
  reason: 'Admitted after counselling',
  ...extra,
});

const idOf = (r: { json: <T>() => T }): string => r.json<{ data: { id: string } }>().data.id;
const studentRows = (userId: string) =>
  adminQuery('SELECT * FROM app.students WHERE user_id = $1', [userId]);
const keyRows = (key: string) =>
  adminQuery('SELECT 1 FROM app.idempotency_keys WHERE key = $1', [key]);
const auditFor = (studentId: string) =>
  adminQuery<{
    action: string;
    resource_type: string;
    risk_tier: number;
    reason_text: string;
    actor_user_id: string;
    subject_student_id: string;
    changes: Record<string, { old: unknown; new: unknown }>;
  }>(
    `SELECT action, resource_type, risk_tier, reason_text, actor_user_id, subject_student_id, changes
       FROM app.audit_events WHERE resource_id = $1 AND resource_type = 'student'`,
    [studentId],
  );

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, Object.values(FIXTURE_LOGINS)],
  );
  T = await createIsolatedTenant(hash);
  sessions.orgAdminA = await login(FIXTURE_LOGINS.orgAdminA);
  sessions.orgAdminB = await login(FIXTURE_LOGINS.orgAdminB);
  sessions.admin = await login(T.emails.admin);
  sessions.campusAdmin = await login(T.emails.campusAdmin);
  sessions.hod = await login(T.emails.hod);
  sessions.faculty = await login(T.emails.faculty);
  sessions.registrarOrg = await login(T.emails.registrarOrg);
  sessions.registrarCampus = await login(T.emails.registrarCampus);
  sessions.student = await login(T.emails.studentOne);
}, 60_000);

afterAll(async () => {
  await adminQuery('DELETE FROM app.idempotency_keys WHERE key = ANY($1::text[])', [[...usedKeys]]);
  await T.cleanup();
  await adminQuery('DELETE FROM app.students WHERE user_id = ANY($1::uuid[])', [createdUsers]);
  await adminQuery('DELETE FROM app.employees WHERE user_id = ANY($1::uuid[])', [createdUsers]);
  await adminQuery('DELETE FROM app.role_assignments WHERE user_id = ANY($1::uuid[])', [
    createdUsers,
  ]);
  await adminQuery('DELETE FROM platform.auth_sessions WHERE identity_id = ANY($1::uuid[])', [
    createdIdentities,
  ]).catch(() => undefined);
  await adminQuery('DELETE FROM app.users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(
    () => undefined,
  );
  await adminQuery('DELETE FROM platform.identities WHERE id = ANY($1::uuid[])', [
    createdIdentities,
  ]).catch(() => undefined);
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('POST /students: authentication, CSRF and request validation', () => {
  it('401 without a session', async () => {
    expect((await post(null, body(uuidv7()))).statusCode).toBe(401);
    expect((await get(null, `${BASE}/${STUDENT_A}`)).statusCode).toBe(401);
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    expect((await post('admin', body(uuidv7()), { csrf: '' })).statusCode).toBe(403);
  });

  it.each([
    ['client-supplied organizationId', { organizationId: uuidv7() }],
    ['client-supplied status', { status: 'ACTIVE' }],
    ['client-supplied version', { version: 3 }],
    ['unknown field', { gpa: 4 }],
    ['non-UUIDv7 userId', { userId: '3b241101-e2bb-4255-8caf-4136c566a962' }],
    ['admission number with a space', { admissionNumber: 'AB 1' }],
    ['admission number with a leading dash', { admissionNumber: '-AB1' }],
    ['admission number with surrounding whitespace', { admissionNumber: ' AB1' }],
    ['admission number longer than 50', { admissionNumber: 'A'.repeat(51) }],
    ['empty admission number', { admissionNumber: '' }],
    ['impossible date', { admissionDate: '2024-02-30' }],
    ['date outside 1900-2200', { admissionDate: '1800-01-01' }],
    ['date with a time', { admissionDate: '2024-07-01T00:00:00Z' }],
    ['missing admission date', { admissionDate: undefined }],
    ['missing reason', { reason: undefined }],
    ['reason shorter than 5', { reason: 'abcd' }],
    ['reason longer than 500', { reason: 'x'.repeat(501) }],
  ])('400 for %s (and nothing is stored)', async (_n, extra) => {
    const key = randomUUID();
    const r = await post('admin', body(uuidv7() /* never reached */, extra), { key });
    expect(r.statusCode).toBe(400);
    expect(await keyRows(key)).toEqual([]);
  });

  it('accepts the boundary admission numbers (1 and 50 characters, mixed case, "-" and "_")', async () => {
    for (const admissionNumber of [`a${RUN}`, `${RUN}-_${'x'.repeat(40)}`.slice(0, 50)]) {
      const u = await newUser();
      const r = await post('admin', body(u, { admissionNumber }));
      expect(r.statusCode, admissionNumber).toBe(201);
    }
  });
});

describe('POST /students: authorization (permission student.record.create, organization scope)', () => {
  it('403 for holders without the permission, and the 403 comes BEFORE any idempotency-key complaint', async () => {
    const u = await newUser();
    for (const actor of ['faculty', 'hod', 'student'] as const) {
      expect((await post(actor, body(u), { key: null })).statusCode, actor).toBe(403);
      expect((await post(actor, body(u))).statusCode, actor).toBe(403);
    }
    expect(await studentRows(u)).toEqual([]);
  });

  it('a CAMPUS-scoped holder (campus admin, campus registrar) gets 403: a student cannot yet be proven inside a campus', async () => {
    const u = await newUser();
    expect((await post('campusAdmin', body(u))).statusCode).toBe(403);
    expect((await post('registrarCampus', body(u))).statusCode).toBe(403);
    expect(await studentRows(u)).toEqual([]);
  });

  it('organization admin and organization registrar can create', async () => {
    for (const actor of ['admin', 'registrarOrg'] as const) {
      const u = await newUser();
      const r = await post(actor, body(u));
      expect(r.statusCode, actor).toBe(201);
      expect(r.json<{ success: boolean }>().success).toBe(true);
      expect(await studentRows(u)).toHaveLength(1);
    }
  });

  it("another tenant's administrators cannot create for this tenant's user (404, indistinguishable from a missing user)", async () => {
    const u = await newUser();
    expect((await post('orgAdminA', body(u))).statusCode).toBe(404);
    const other = await post('orgAdminB', body(u));
    const missing = await post('orgAdminB', body(uuidv7()));
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({
      error: { ...other.json<{ error: object }>().error },
    });
    expect(other.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: missing.json<{ error: { code: string } }>().error.code,
      message: missing.json<{ error: { message: string } }>().error.message,
    });
    expect(await studentRows(u)).toEqual([]);
  });

  it('a user of another tenant cannot be targeted either (404)', async () => {
    expect((await post('admin', body(USER_B))).statusCode).toBe(404);
    expect((await post('admin', body(STAFF_B))).statusCode).toBe(404);
  });
});

describe('POST /students: Idempotency-Key', () => {
  it('missing ⇒ 428, malformed ⇒ 400, and neither stores anything', async () => {
    const u = await newUser();
    const missing = await post('admin', body(u), { key: null });
    expect(missing.statusCode).toBe(428);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const bad of [
      '',
      'short',
      'has space in it 0123456789',
      'x'.repeat(129),
      'bad/slash/0123456789',
    ]) {
      const r = await post('admin', body(u), { key: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await studentRows(u)).toEqual([]);
  });

  it('201 then a replay: same status, same body, Idempotent-Replayed: true, exactly one student and one audit event', async () => {
    const u = await newUser();
    const key = randomUUID();
    const payload = body(u);
    const first = await post('admin', payload, { key });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const again = await post('admin', payload, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(again.headers['cache-control']).toBe('no-store');

    expect(await studentRows(u)).toHaveLength(1);
    expect(await auditFor(idOf(first))).toHaveLength(1);
    expect(await keyRows(key)).toHaveLength(1);
  });

  it('the canonical request decides equality: key order and reason whitespace do not matter', async () => {
    const u = await newUser();
    const key = randomUUID();
    const payload = body(u);
    const first = await post('admin', payload, { key });
    expect(first.statusCode).toBe(201);
    const reordered = {
      reason: `  ${payload.reason}  `,
      admissionDate: payload.admissionDate,
      admissionNumber: payload.admissionNumber,
      userId: payload.userId.toUpperCase().replace(/^(.{8})-/, '$1-'),
    };
    const again = await post('admin', reordered, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(idOf(again)).toBe(idOf(first));
  });

  it('the same key with a different request ⇒ 422, and the original record is untouched', async () => {
    const u = await newUser();
    const key = randomUUID();
    const payload = body(u);
    const first = await post('admin', payload, { key });
    expect(first.statusCode).toBe(201);
    for (const changed of [
      { ...payload, admissionNumber: num() },
      { ...payload, admissionDate: '2024-07-02' },
      { ...payload, reason: 'A different reason' },
      { ...payload, userId: await newUser() },
    ]) {
      const r = await post('admin', changed, { key });
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    const rows = await studentRows(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admission_number: payload.admissionNumber });
  });

  it('a failed request leaves no cached claim: after the cause is fixed, the SAME key and body succeed', async () => {
    const u = await newUser('SUSPENDED');
    const key = randomUUID();
    const payload = body(u);
    const failed = await post('admin', payload, { key });
    expect(failed.statusCode).toBe(409);
    expect(failed.headers['idempotent-replayed']).toBeUndefined();
    expect(await keyRows(key)).toEqual([]);

    await adminQuery("UPDATE app.users SET status = 'ACTIVE' WHERE id = $1", [u]);
    const retry = await post('admin', payload, { key });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('a validation failure and an authorization failure are not cached either', async () => {
    const u = await newUser();
    const key = randomUUID();
    expect((await post('admin', { ...body(u), reason: 'no' }, { key })).statusCode).toBe(400);
    expect((await post('faculty', body(u), { key })).statusCode).toBe(403);
    expect(await keyRows(key)).toEqual([]);
    expect((await post('admin', body(u), { key })).statusCode).toBe(201);
  });

  it('keys are per principal: another administrator may use the same key string for their own request', async () => {
    const key = randomUUID();
    const u1 = await newUser();
    const u2 = await newUser();
    expect((await post('admin', body(u1), { key })).statusCode).toBe(201);
    const other = await post('registrarOrg', body(u2), { key });
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(await studentRows(u2)).toHaveLength(1);
  });

  it('an expired key is replaced: the same key with a different request creates a new student', async () => {
    const key = randomUUID();
    const u1 = await newUser();
    const u2 = await newUser();
    expect((await post('admin', body(u1), { key })).statusCode).toBe(201);
    await adminQuery(
      `UPDATE app.idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`,
      [key],
    );
    const r = await post('admin', body(u2), { key });
    expect(r.statusCode).toBe(201);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(await studentRows(u2)).toHaveLength(1);
    expect(await keyRows(key)).toHaveLength(1);
  });

  it('two simultaneous requests with the same key and body create exactly one student; both answer 201 with the same id', async () => {
    const u = await newUser();
    const key = randomUUID();
    const payload = body(u);
    const [a, b] = await Promise.all([
      post('admin', payload, { key }),
      post('admin', payload, { key }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(idOf(a)).toBe(idOf(b));
    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']].sort()).toEqual([
      'true',
      undefined,
    ]);
    expect(await studentRows(u)).toHaveLength(1);
    expect(await auditFor(idOf(a))).toHaveLength(1);
  });
});

describe('POST /students: account and relationship safeguards', () => {
  it('404 for an unknown user', async () => {
    expect((await post('admin', body(uuidv7()))).statusCode).toBe(404);
  });

  it.each(['INVITED', 'SUSPENDED', 'DEACTIVATED'])('409 for a %s account', async (status) => {
    const u = await newUser(status);
    const r = await post('admin', body(u));
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/ACTIVE account/);
    expect(await studentRows(u)).toEqual([]);
  });

  it('409 for an account with a staff-capable role assignment, at any scope, and nothing is created', async () => {
    for (const [role, scope] of [
      ['FACULTY', { type: 'ORGANIZATION' as const }],
      ['CAMPUS_ADMIN', { type: 'CAMPUS' as const, id: T.campusId }],
    ] as const) {
      const u = await newUser();
      await assignRole(u, role, scope);
      const r = await post('admin', body(u));
      expect(r.statusCode, role).toBe(409);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(
        /staff role assignment/,
      );
      expect(await studentRows(u)).toEqual([]);
    }
  });

  it('409 when the creator targets their OWN account (self-targeting is not exempt)', async () => {
    const r = await post('admin', body(T.users.admin));
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/staff role assignment/);
    expect(await studentRows(T.users.admin)).toEqual([]);
  });

  it('the conflict predicate: revoked, expired-status and ended-window staff assignments do NOT block', async () => {
    const cases: [string, { status?: string; validFrom?: string; validUntil?: string | null }][] = [
      ['revoked', { status: 'REVOKED' }],
      ['expired status', { status: 'EXPIRED' }],
      [
        'ended',
        {
          validFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          validUntil: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    ];
    for (const [label, extra] of cases) {
      const u = await newUser();
      await assignRole(u, 'FACULTY', { type: 'ORGANIZATION' }, extra);
      const r = await post('admin', body(u));
      expect(r.statusCode, label).toBe(201);
    }
  });

  it('a FUTURE-DATED active staff assignment blocks (valid_from is ignored): it would become effective later without any write', async () => {
    for (const validUntil of [null, new Date(Date.now() + 10 * 86_400_000).toISOString()]) {
      const u = await newUser();
      await assignRole(
        u,
        'FACULTY',
        { type: 'ORGANIZATION' },
        { validFrom: new Date(Date.now() + 86_400_000).toISOString(), validUntil },
      );
      const r = await post('admin', body(u));
      expect(r.statusCode, String(validUntil)).toBe(409);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(
        /staff role assignment/,
      );
      expect(await studentRows(u)).toEqual([]);
    }
  });

  it("a STUDENT-role assignment never blocks, whatever its window (it is the student's own role)", async () => {
    const day = 86_400_000;
    for (const extra of [
      {},
      { validFrom: new Date(Date.now() + day).toISOString() },
      {
        validFrom: new Date(Date.now() - 2 * day).toISOString(),
        validUntil: new Date(Date.now() + day).toISOString(),
      },
    ]) {
      const u = await newUser();
      await assignRole(u, 'STUDENT', { type: 'ORGANIZATION' }, extra);
      expect((await post('admin', body(u))).statusCode, JSON.stringify(extra)).toBe(201);
    }
  });

  it('409 for an account that already has an employee record', async () => {
    const u = await newUser();
    await adminQuery(
      `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
       VALUES ($1, $2, $3, $4, 'STAFF', '2024-01-01')`,
      [uuidv7(), T.orgId, u, `E${RUN}-${counter++}`],
    );
    const r = await post('admin', body(u));
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/employee record/);
    expect(await studentRows(u)).toEqual([]);
  });

  it('409 for an account that already has a student record (even through a different admission number)', async () => {
    const u = await newUser();
    expect((await post('admin', body(u))).statusCode).toBe(201);
    const r = await post('admin', body(u));
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(
      /already has a student record/,
    );
    // a seeded student's login is refused too (it also holds a STUDENT role assignment)
    expect((await post('admin', body(T.users.studentOne))).statusCode).toBe(409);
  });

  it('admission numbers are unique per tenant and CASE-SENSITIVE: a case variant is a different number', async () => {
    const n = `Dup${RUN}-${counter++}`;
    const u1 = await newUser();
    const u2 = await newUser();
    const u3 = await newUser();
    expect((await post('admin', body(u1, { admissionNumber: n }))).statusCode).toBe(201);
    const dup = await post('admin', body(u2, { admissionNumber: n }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { message: string } }>().error.message).toMatch(/admission number/);
    expect(await studentRows(u2)).toEqual([]);
    expect((await post('admin', body(u3, { admissionNumber: n.toLowerCase() }))).statusCode).toBe(
      201,
    );
  });

  it('creates a student with status ADMITTED and grants NO role to the account', async () => {
    const u = await newUser();
    const r = await post('admin', body(u));
    expect(r.statusCode).toBe(201);
    const [row] = await studentRows(u);
    expect(row).toMatchObject({ status: 'ADMITTED', organization_id: T.orgId, version: 1 });
    expect(row?.['status_changed_at']).toBeInstanceOf(Date);
    const roles = await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [u]);
    expect(roles).toEqual([]);
    const [account] = await adminQuery('SELECT status FROM app.users WHERE id = $1', [u]);
    expect(account).toEqual({ status: 'ACTIVE' });
  });
});

describe('POST /students: audit', () => {
  it('writes one tier-2 audit event with the reason, the actor, the subject student and the field diff', async () => {
    const u = await newUser();
    const payload = body(u, { reason: '  Provisional admission after interview  ' });
    const r = await post('admin', payload);
    expect(r.statusCode).toBe(201);
    const events = await auditFor(idOf(r));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'student.record.create',
      resource_type: 'student',
      risk_tier: 2,
      reason_text: 'Provisional admission after interview',
      actor_user_id: T.users.admin,
      subject_student_id: idOf(r),
    });
    expect(events[0]?.changes).toEqual({
      userId: { old: null, new: u },
      admissionNumber: { old: null, new: payload.admissionNumber },
      admissionDate: { old: null, new: '2024-07-01' },
      status: { old: null, new: 'ADMITTED' },
    });
  });

  it('refused attempts write no audit event and no student', async () => {
    const u = await newUser('SUSPENDED');
    const payload = body(u);
    expect((await post('admin', payload)).statusCode).toBe(409);
    expect(
      await adminQuery(
        `SELECT 1 FROM app.audit_events WHERE action = 'student.record.create' AND changes -> 'userId' ->> 'new' = $1`,
        [u],
      ),
    ).toEqual([]);
    expect(await studentRows(u)).toEqual([]);
  });
});

describe('GET /students/:id', () => {
  let studentId = '';
  let studentUser = '';
  beforeAll(async () => {
    studentUser = await newUser();
    const r = await post('admin', body(studentUser, { admissionDate: '2023-08-15' }));
    expect(r.statusCode).toBe(201);
    studentId = idOf(r);
  });

  it('returns the record with a strong ETag and Cache-Control: no-store', async () => {
    const r = await get('admin', `${BASE}/${studentId}`);
    expect(r.statusCode).toBe(200);
    const rec = r.json<{ success: boolean; data: Record<string, unknown> }>();
    expect(rec.success).toBe(true);
    expect(rec.data).toMatchObject({
      id: studentId,
      organizationId: T.orgId,
      userId: studentUser,
      admissionDate: '2023-08-15',
      status: 'ADMITTED',
      version: 1,
    });
    expect(typeof rec.data['statusChangedAt']).toBe('string');
    expect(Object.keys(rec.data).sort()).toEqual(
      [
        'admissionDate',
        'admissionNumber',
        'createdAt',
        'id',
        'organizationId',
        'status',
        'statusChangedAt',
        'updatedAt',
        'userId',
        'version',
      ].sort(),
    );
    expect(r.headers['etag']).toBe('"1"');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('organization registrar reads; a seeded fixture student (with its admission_date) is readable too', async () => {
    expect((await get('registrarOrg', `${BASE}/${studentId}`)).statusCode).toBe(200);
    const seeded = await get('orgAdminA', `${BASE}/${STUDENT_A}`);
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json<{ data: { admissionDate: string } }>().data.admissionDate).toBe(
      '2024-07-01',
    );
  });

  it('a student reads their own record (SELF) and only theirs: another student gets the same 404 as a missing record', async () => {
    expect((await get('student', `${BASE}/${T.students.one}`)).statusCode).toBe(200);
    const other = await get('student', `${BASE}/${T.students.two}`);
    const missing = await get('student', `${BASE}/${uuidv7()}`);
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({
      error: {
        ...missing.json<{ error: object }>().error,
        requestId: other.json<{ error: { requestId: string } }>().error.requestId,
      },
    });
  });

  it('campus-scoped and department-scoped holders get 404 (a student cannot yet be proven inside their scope); no permission ⇒ 403', async () => {
    expect((await get('campusAdmin', `${BASE}/${studentId}`)).statusCode).toBe(404);
    expect((await get('hod', `${BASE}/${studentId}`)).statusCode).toBe(404);
    expect((await get('registrarCampus', `${BASE}/${studentId}`)).statusCode).toBe(404);
    expect((await get('faculty', `${BASE}/${studentId}`)).statusCode).toBe(403);
  });

  it("another tenant's administrator gets 404 for tenant A's student", async () => {
    expect((await get('orgAdminB', `${BASE}/${studentId}`)).statusCode).toBe(404);
  });

  it('400 for a malformed id, 404 for an unknown one', async () => {
    expect((await get('admin', `${BASE}/not-a-uuid`)).statusCode).toBe(400);
    expect((await get('admin', `${BASE}/${uuidv7()}`)).statusCode).toBe(404);
  });

  it('there is no list, PATCH or DELETE route yet', async () => {
    expect((await get('admin', BASE)).statusCode).toBe(404);
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app.inject({
        method,
        url: `${BASE}/${studentId}`,
        cookies: { session_token: sessions.admin.cookie },
        headers: { origin: APP_ORIGIN, 'x-csrf-token': sessions.admin.csrf },
        payload: { reason: 'nope nope' },
      });
      expect(r.statusCode, method).toBe(404);
    }
  });
});
