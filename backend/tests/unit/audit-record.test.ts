import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { TenantTx } from '../../src/shared/database/tenant-tx.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { recordAudit, type AuditEvent } from '../../src/shared/audit/index.js';
import { findAuditMetadataProblem, isSensitiveKey } from '../../src/shared/audit/sensitive-keys.js';
import { normaliseReason } from '../../src/shared/authorization/assignments.js';

const TENANT = '01939a00-0000-7000-8000-000000000a01';
const USER = '01939a00-0000-7000-8000-00000000aa03';
const OTHER = '01939a00-0000-7000-8000-00000000bb03';
const RES = '01939a00-0000-7000-8000-00000000d0a1';
const ctx = issueTrustedContext({ tenantId: TENANT, userId: USER, actorKind: 'STAFF' });

function fakeTx(fail = false) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    query: (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return fail
        ? Promise.reject(new Error('relation has no partition; secret=hunter2'))
        : Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as TenantTx;
  return { tx, calls };
}
const base: AuditEvent = {
  action: 'role.assignment.grant',
  resourceType: 'role_assignment',
  resourceId: RES,
  riskTier: 2,
};
const err = async (p: Promise<unknown>): Promise<AppError> =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as AppError;

describe('sensitive audit keys', () => {
  it.each([
    'password',
    'Password',
    'new_password',
    'newPassword',
    'password_hash',
    'passwordHash',
    'passwd',
    'passphrase',
    'token',
    'accessToken',
    'refresh_token',
    'X-Auth-Token',
    'session_token',
    'csrf_token',
    'csrfToken',
    'id-token',
    'secret',
    'client_secret',
    'clientSecret',
    'SECRET_KEY',
    'credential',
    'credentials',
    'db_credentials',
    'apiKey',
    'api_key',
    'api-key',
    'privateKey',
    'private_key',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'totp',
    'totpCode',
    'recoveryCode',
    'recovery_codes',
    'sessionId',
  ])('rejects the key "%s"', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(findAuditMetadataProblem({ [key]: 'x' })).toMatch(/not allowed/);
  });

  it.each([
    'status',
    'role_code',
    'user_id',
    'scope_type',
    'scope_id',
    'old',
    'new',
    'reason',
    'campus_id',
  ])('accepts the ordinary key "%s"', (key) => {
    expect(findAuditMetadataProblem({ [key]: { old: null, new: 'x' } })).toBeNull();
  });

  it('finds sensitive keys at any depth, inside arrays, and reports the path (never the value)', () => {
    const p = findAuditMetadataProblem({ a: [{ b: { newPassword: 'hunter2-hunter2' } }] });
    expect(p).toBe('a[0].b.newPassword: key is not allowed in audit data');
    expect(p).not.toContain('hunter2');
  });

  it('rejects structures that are not plain JSON (class instances, functions, symbols, NaN, too deep, too large)', () => {
    expect(findAuditMetadataProblem({ d: new Date() })).toMatch(/not a plain object/);
    expect(findAuditMetadataProblem({ f: () => 1 })).toMatch(/unsupported/);
    expect(findAuditMetadataProblem({ n: Number.NaN })).toMatch(/non-finite/);
    let deep: Record<string, unknown> = { x: 1 };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    expect(findAuditMetadataProblem(deep)).toMatch(/too deeply/);
    expect(findAuditMetadataProblem({ list: Array.from({ length: 600 }, (_, i) => i) })).toMatch(
      /too many nodes/,
    );
  });
});

describe('recordAudit: what is persisted and what is refused', () => {
  it('writes exactly the documented fields; tenant and actor come ONLY from the trusted context', async () => {
    const { tx, calls } = fakeTx();
    // hostile extra properties (e.g. copied from a request body) must have no effect
    const hostile = {
      ...base,
      organizationId: OTHER,
      actorUserId: OTHER,
      actor_user_id: OTHER,
      occurredAt: '2001-01-01',
      body: { password: 'x' },
    } as unknown as AuditEvent;
    const id = await recordAudit(tx, ctx, hostile, {});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c!.sql).toMatch(/INSERT INTO app\.audit_events/);
    expect(c!.sql).not.toMatch(/occurred_at/); // server clock only
    expect(c!.params[1]).toBe(TENANT);
    expect(c!.params[2]).toBe(USER);
    expect(JSON.stringify(c!.params)).not.toContain(OTHER);
    expect(JSON.stringify(c!.params)).not.toContain('2001-01-01');
    expect(JSON.stringify(c!.params)).not.toContain('password');
  });

  it('carries request metadata supplied by the caller (request id, session id, ip, sanitised user agent)', async () => {
    const { tx, calls } = fakeTx();
    await recordAudit(tx, ctx, base, {
      requestId: '3b241101-e2bb-4255-8caf-4136c566a962', // a v4 UUID is fine for correlation
      sessionId: '01939a00-0000-7000-8000-0000000000aa',
      ip: '2001:db8::1',
      userAgent: `Mozilla/5.0\u0000\u001b[31m ${'x'.repeat(400)}`,
    });
    const p = calls[0]!.params;
    expect(p[3]).toBe('01939a00-0000-7000-8000-0000000000aa');
    expect(p[4]).toBe('3b241101-e2bb-4255-8caf-4136c566a962');
    expect(p[5]).toBe('2001:db8::1');
    const ua = p[6] as string;
    expect(ua.length).toBeLessThanOrEqual(256);
    // eslint-disable-next-line no-control-regex
    expect(ua).not.toMatch(/[\u0000-\u001f]/);
  });

  it('rejects sensitive keys in changes and metadata WITHOUT touching the database', async () => {
    for (const bad of [
      { newPassword: { old: 'a', new: 'b' } },
      { nested: { apiToken: 'x' } },
      { credentials: [1] },
    ]) {
      for (const field of ['changes', 'metadata'] as const) {
        const { tx, calls } = fakeTx();
        const e = await err(recordAudit(tx, ctx, { ...base, [field]: bad }));
        expect(e).toBeInstanceOf(AppError);
        expect(e.code).toBe('AUDIT_INVALID');
        expect(calls).toHaveLength(0);
      }
    }
  });

  it.each([
    ['action not module.resource.action', { action: 'Grant' }],
    ['action with one segment', { action: 'grant' }],
    ['resource type with spaces', { resourceType: 'Role Assignment' }],
    ['risk tier 0', { riskTier: 0 as unknown as 1 }],
    ['risk tier 4', { riskTier: 4 as unknown as 1 }],
    ['resource id not a UUIDv7', { resourceId: '3b241101-e2bb-4255-8caf-4136c566a962' }],
    ['lower-case reason code', { reasonCode: 'oops' }],
    ['empty reason text', { reasonText: '   ' }],
    ['over-long reason text', { reasonText: 'r'.repeat(501) }],
    ['oversized changes', { changes: { blob: 'x'.repeat(20000) } }],
  ])('rejects %s before any SQL runs', async (_name, patch) => {
    const { tx, calls } = fakeTx();
    const e = await err(recordAudit(tx, ctx, { ...base, ...patch }));
    expect(e.code).toBe('AUDIT_INVALID');
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed request metadata (request id, session id, ip)', async () => {
    for (const meta of [
      { requestId: 'nope' },
      { sessionId: '3b241101-e2bb-4255-8caf-4136c566a962' },
      { ip: '999.1.1.1' },
      { ip: 'not-an-ip' },
    ]) {
      const { tx, calls } = fakeTx();
      expect((await err(recordAudit(tx, ctx, base, meta))).code).toBe('AUDIT_INVALID');
      expect(calls).toHaveLength(0);
    }
  });

  it('requires a TrustedContext: a structurally identical forged object is refused', async () => {
    const { tx, calls } = fakeTx();
    const forged = { tenantId: TENANT, userId: USER, actorKind: 'STAFF' } as never;
    expect((await err(recordAudit(tx, forged, base))).code).toBe('UNTRUSTED_CONTEXT');
    expect(calls).toHaveLength(0);
  });

  it('a database failure becomes a generic AUDIT_WRITE_FAILED with no driver detail (and propagates)', async () => {
    const { tx } = fakeTx(true);
    const e = await err(recordAudit(tx, ctx, base));
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe('AUDIT_WRITE_FAILED');
    expect(e.message).not.toMatch(/partition|hunter2|secret/);
  });
});

describe('recordAudit: database timeouts', () => {
  const failing = (code: string) =>
    ({
      query: () =>
        Promise.reject(
          Object.assign(
            new Error('canceling statement due to lock timeout: relation "audit_events_2026_10"'),
            { code },
          ),
        ),
    }) as never;

  it.each(['55P03', '57014'])(
    'SQLSTATE %s is a retry-safe 503 DATABASE_BUSY (still thrown, never swallowed, no detail)',
    async (code) => {
      const e = await err(recordAudit(failing(code), ctx, base));
      expect(e.statusCode).toBe(503);
      expect(e.code).toBe('DATABASE_BUSY');
      expect(e.message).toBe('The service is busy. Retry the request.');
      expect(JSON.stringify(e.message)).not.toMatch(/audit_events|relation|lock/);
    },
  );

  it.each(['23505', '40P01', '42501', '23502'])(
    'SQLSTATE %s stays the generic AUDIT_WRITE_FAILED 500',
    async (code) => {
      const e = await err(recordAudit(failing(code), ctx, base));
      expect(e.statusCode).toBe(500);
      expect(e.code).toBe('AUDIT_WRITE_FAILED');
    },
  );
});

describe('role-change reason', () => {
  it.each([
    undefined,
    null,
    '',
    '   ',
    '\n\t',
    'abc',
    '.....',
    '-----',
    12345,
    {},
    'x'.repeat(501),
  ])('rejects %j', (reason) => {
    expect(() => normaliseReason(reason)).toThrow(AppError);
  });
  it('accepts and trims a meaningful reason (letters or digits, 5-500 chars)', () => {
    expect(normaliseReason('  Joined as HOD from 1 Nov  ')).toBe('Joined as HOD from 1 Nov');
    expect(normaliseReason('प्रमाणित 2026')).toBe('प्रमाणित 2026');
  });
});
