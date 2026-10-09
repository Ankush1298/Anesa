import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { resourceNotFound } from '../../src/shared/errors/http-errors.js';
import { adminQuery } from '../support/db-harness.js';
import { ORG_A, ORG_B, STUDENT_A, STUDENT_B, STUDENT_C, UNKNOWN_V7 } from '../support/fixtures.js';

// Layer 1 (application authorization) and Layer 2 (RLS) through the real HTTP stack.
const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const LOGINS = {
  studentA: 'user.a@college-a.test',
  studentB: 'user.a2@college-a.test',
  admin: 'staff.a@college-a.test',
  norole: 'norole.a@college-a.test',
  adminB: 'staff.b@college-b.test',
} as const;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 3 });
const db = new Database(pool);
const app = buildApp({ config: loadConfig({ DATABASE_URL: url }), db, logger: false });
const tokens = {} as Record<keyof typeof LOGINS, string>;

beforeAll(async () => {
  // Protected by the engine (Layer 1) AND RLS (Layer 2).
  app.get('/t/students/:id', { config: { permission: 'student.profile.read' } }, async (req) => {
    const ctx = req.tenantContext!;
    const { id } = req.params as { id: string };
    return db.withTenant(ctx, async (tx) => {
      const row = (
        await tx.query<{ id: string; organization_id: string }>(
          'SELECT id, organization_id FROM app.students WHERE id = $1',
          [id],
        )
      ).rows[0];
      if (!row) throw resourceNotFound();
      await AuthorizationEngine.assert(tx, ctx, 'student.profile.read', {
        student_id: row.id,
        organization_id: row.organization_id,
      });
      return { id: row.id };
    });
  });
  // A deliberately WEAKENED handler: it never calls the engine. Only RLS stands between it and the data.
  app.get('/t/no-engine/students/:id', { config: { permission: 'session.read' } }, async (req) => {
    const { id } = req.params as { id: string };
    return db.withTenant(req.tenantContext!, async (tx) => {
      const row = (await tx.query('SELECT id FROM app.students WHERE id = $1', [id])).rows[0];
      if (!row) throw resourceNotFound();
      return row;
    });
  });
  app.get('/t/campus', { config: { permission: 'org.campus.manage' } }, () => ({ ok: true }));
  await app.ready();

  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const emails = Object.values(LOGINS);
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, emails],
  );
  for (const [k, email] of Object.entries(LOGINS)) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, email).toBe(200);
    tokens[k as keyof typeof LOGINS] = r.cookies.find((c) => c.name === 'session_token')!.value;
  }
});
afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

const get = (who: keyof typeof LOGINS, path: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: path, cookies: { session_token: tokens[who] }, headers });
const shape = (r: { statusCode: number; json: () => { error?: { requestId?: string } } }) => {
  const body = r.json();
  if (body.error) delete body.error.requestId;
  return { status: r.statusCode, body };
};

describe('student self-isolation over HTTP', () => {
  it('Student A reads Student A', async () => {
    const r = await get('studentA', `/t/students/${STUDENT_A}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: STUDENT_A });
  });

  it('Student A -> Student B, a student of another tenant, and a nonexistent id are indistinguishable 404s', async () => {
    const other = shape(await get('studentA', `/t/students/${STUDENT_B}`));
    const crossTenant = shape(await get('studentA', `/t/students/${STUDENT_C}`));
    const missing = shape(await get('studentA', `/t/students/${UNKNOWN_V7}`));
    const notARoute = shape(await get('studentA', '/t/no/such/route'));
    expect(other.status).toBe(404);
    expect(other.body).toEqual({
      error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested resource was not found.' },
    });
    expect(crossTenant).toEqual(other);
    expect(missing).toEqual(other);
    expect(notARoute).toEqual(other);
  });

  it("hiding also holds for staff: another tenant's student vs nonexistent", async () => {
    expect(shape(await get('adminB', `/t/students/${STUDENT_A}`))).toEqual(
      shape(await get('adminB', `/t/students/${UNKNOWN_V7}`)),
    );
    expect((await get('adminB', `/t/students/${STUDENT_A}`)).statusCode).toBe(404);
  });

  it('a college administrator reads every student of their own tenant, none of another', async () => {
    expect((await get('admin', `/t/students/${STUDENT_A}`)).statusCode).toBe(200);
    expect((await get('admin', `/t/students/${STUDENT_B}`)).statusCode).toBe(200);
    expect((await get('admin', `/t/students/${STUDENT_C}`)).statusCode).toBe(404);
  });

  it('client-supplied role, permission, scope, identity, tenant and student ids never elevate access', async () => {
    const forged = `?role=COLLEGE_ADMIN&permission=student.profile.read&scope=ORGANIZATION&student_id=${STUDENT_B}&tenant_id=${ORG_A}&user_id=${STUDENT_B}&department_id=${UNKNOWN_V7}&campus_id=${UNKNOWN_V7}`;
    const headers = {
      'x-tenant-id': ORG_A,
      'x-user-id': STUDENT_B,
      'x-role': 'COLLEGE_ADMIN',
      'x-permissions': 'student.profile.read',
      authorization: 'Bearer forged',
    };
    const clean = shape(await get('studentA', `/t/students/${STUDENT_B}`));
    expect(shape(await get('studentA', `/t/students/${STUDENT_B}${forged}`, headers))).toEqual(
      clean,
    );
    // a tenant-B administrator claiming tenant A still gets nothing from tenant A
    const claimA = shape(
      await get('adminB', `/t/students/${STUDENT_A}?tenant_id=${ORG_A}`, { 'x-tenant-id': ORG_A }),
    );
    expect(claimA.status).toBe(404);
    // and the identity is still the authenticated one
    const me = (await get('studentA', `/auth/me${forged}`, headers)).json<{
      tenant_id: string;
      user_id: string;
      actor_kind: string;
    }>();
    expect(me).toMatchObject({ tenant_id: ORG_A, actor_kind: 'STUDENT' });
    expect(me.user_id).not.toBe(STUDENT_B);
  });
});

describe('permission checks', () => {
  it('unauthenticated -> 401, no role -> 403, student without the permission -> 403, admin -> 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/t/campus' })).statusCode).toBe(401);
    expect((await get('norole', '/t/campus')).statusCode).toBe(403);
    expect((await get('studentA', '/t/campus')).statusCode).toBe(403);
    expect((await get('admin', '/t/campus')).statusCode).toBe(200);
    expect((await get('studentA', '/t/campus')).json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });

  it('permissions, not role names, decide: a user with no effective assignment is denied /auth/me', async () => {
    expect((await get('norole', '/auth/me')).statusCode).toBe(403);
  });
});

describe('Layer 2 holds even when Layer 1 is bypassed', () => {
  it('a handler that skips the engine still cannot cross the tenant or student boundary', async () => {
    const ok = await get('studentA', `/t/no-engine/students/${STUDENT_A}`);
    expect(ok.statusCode).toBe(200);
    expect((await get('studentA', `/t/no-engine/students/${STUDENT_B}`)).statusCode).toBe(404); // student RLS
    expect((await get('studentA', `/t/no-engine/students/${STUDENT_C}`)).statusCode).toBe(404); // tenant RLS
    expect((await get('adminB', `/t/no-engine/students/${STUDENT_A}`)).statusCode).toBe(404); // tenant RLS
    expect(ORG_B).toBeDefined();
  });
});

describe('route coverage is enforced at boot', () => {
  it('a route without a permission, or with an uncatalogued one, cannot be registered', async () => {
    for (const config of [undefined, { permission: 'admin' }, { permission: '' }]) {
      const fresh = buildApp({ config: loadConfig({ DATABASE_URL: url }), db, logger: false });
      expect(
        () => fresh.get('/x', { config: config as never }, () => 'x'),
        JSON.stringify(config),
      ).toThrow(/catalogued permission/);
      await fresh.close().catch(() => undefined);
    }
  });
});
