import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { RoleAssignmentService } from '../../src/shared/authorization/assignments.js';
import { Database, type TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, ORG_A, ORG_C, STAFF_C } from '../support/fixtures.js';

// ORG_C is the tenant reserved for tests that COMMIT writes. Audit rows are append-only, so the rows
// these tests create stay in the disposable test database (they are never read by other tests).
const REASON = 'Joined the physics department as a lecturer';
const TARGET = '01939a00-0000-7000-8000-00000000cc14';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 3 });
const db = new Database(pool);
const ctxC = issueTrustedContext({ tenantId: ORG_C, userId: STAFF_C, actorKind: 'STAFF' });

const roleId = (tx: TenantTx, code: string): Promise<string> =>
  tx
    .query<{ id: string }>('SELECT id FROM app.roles WHERE code = $1', [code])
    .then((r) => r.rows[0]!.id);

/** A transaction handle that records every statement and can fail the audit insert (fault injection). */
function instrumented(tx: TenantTx, failAudit: boolean) {
  const statements: string[] = [];
  const wrapped = {
    query: (sql: string, params?: readonly unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      statements.push(s);
      if (failAudit && /INSERT INTO app\.audit_events/.test(s))
        return Promise.reject(new Error('injected audit failure'));
      return tx.query(sql, params);
    },
  } as unknown as TenantTx;
  return { tx: wrapped, statements };
}

const assignmentRows = (user = TARGET) =>
  adminQuery<{ id: string; status: string }>(
    'SELECT id, status FROM app.role_assignments WHERE user_id = $1',
    [user],
  );
const auditRows = (resourceId: string) =>
  adminQuery<Record<string, unknown>>(
    `SELECT organization_id, actor_type, actor_user_id, on_behalf_of_user_id, session_id, request_id, host(ip) AS ip, user_agent,
            action, resource_type, resource_id, subject_student_id, campus_id, department_id, risk_tier, changes, reason_code,
            reason_text, metadata, occurred_at, tableoid::regclass::text AS part
       FROM app.audit_events WHERE resource_id = $1 ORDER BY occurred_at`,
    [resourceId],
  );
const errOf = async (p: Promise<unknown>): Promise<AppError> =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as AppError;

beforeAll(async () => {
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'target.c@college-c.test', 'x', 'ACTIVE') ON CONFLICT DO NOTHING`,
    [TARGET],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'target.c@college-c.test', 'Target C', 'ACTIVE', $1) ON CONFLICT DO NOTHING`,
    [TARGET, ORG_C],
  );
});
afterAll(async () => {
  await adminQuery('DELETE FROM app.role_assignments WHERE user_id = $1', [TARGET]);
  await db.close();
});

describe('a role grant and its audit row commit together', () => {
  let assignmentId = '';
  const requestId = randomUUID();
  const sessionId = uuidv7();

  it('grant writes the assignment AND one audit row with the documented fields', async () => {
    assignmentId = await db.withTenant(ctxC, async (tx) =>
      RoleAssignmentService.grant(
        tx,
        ctxC,
        {
          targetUserId: TARGET,
          roleId: await roleId(tx, 'FACULTY'),
          scopeType: 'ORGANIZATION',
          reason: `  ${REASON}  `,
        },
        { requestId, sessionId, ip: '203.0.113.7', userAgent: 'Vitest/1.0 (integration)' },
      ),
    );
    expect((await assignmentRows()).map((r) => r.status)).toEqual(['ACTIVE']);
    const rows = await auditRows(assignmentId);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a).toMatchObject({
      organization_id: ORG_C,
      actor_type: 'USER',
      actor_user_id: STAFF_C, // from the trusted context, not from the call
      on_behalf_of_user_id: null,
      session_id: sessionId,
      request_id: requestId,
      ip: '203.0.113.7',
      user_agent: 'Vitest/1.0 (integration)',
      action: 'role.assignment.grant',
      resource_type: 'role_assignment',
      resource_id: assignmentId,
      subject_student_id: null,
      campus_id: null,
      department_id: null,
      risk_tier: 2,
      reason_code: null,
      reason_text: REASON, // trimmed
      metadata: null,
    });
    expect(a['changes']).toEqual({
      status: { old: null, new: 'ACTIVE' },
      user_id: { old: null, new: TARGET },
      role_code: { old: null, new: 'FACULTY' },
      scope_type: { old: null, new: 'ORGANIZATION' },
      scope_id: { old: null, new: null },
    });
    // server clock, routed to the partition of the current UTC month
    expect(Math.abs((a['occurred_at'] as Date).getTime() - Date.now())).toBeLessThan(60_000);
    const [month] = await adminQuery<{ ym: string }>(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS ym",
    );
    expect(a['part']).toBe(`app.audit_events_${month!.ym}`);
    // nothing that looks like a credential, token or raw request data was stored
    expect(JSON.stringify(a)).not.toMatch(/password|token|secret|credential|cookie|authorization/i);
  });

  it('revoke writes the status change AND an audit row (old/new status, snapshot in metadata, reason)', async () => {
    await db.withTenant(ctxC, (tx) =>
      RoleAssignmentService.revoke(
        tx,
        ctxC,
        assignmentId,
        'Role no longer needed after reassignment',
        { ip: '203.0.113.8' },
      ),
    );
    expect((await assignmentRows()).map((r) => r.status)).toEqual(['REVOKED']);
    const rows = await auditRows(assignmentId);
    expect(rows.map((r) => r['action'])).toEqual([
      'role.assignment.grant',
      'role.assignment.revoke',
    ]);
    expect(rows[1]).toMatchObject({
      organization_id: ORG_C,
      actor_user_id: STAFF_C,
      risk_tier: 2,
      reason_text: 'Role no longer needed after reassignment',
      ip: '203.0.113.8',
      changes: { status: { old: 'ACTIVE', new: 'REVOKED' } },
      metadata: {
        user_id: TARGET,
        role_code: 'FACULTY',
        scope_type: 'ORGANIZATION',
        scope_id: null,
      },
    });
  });

  it('the audit rows belong to the acting tenant only', async () => {
    const foreign = await adminQuery(
      'SELECT 1 FROM app.audit_events WHERE resource_id = $1 AND organization_id <> $2',
      [assignmentId, ORG_C],
    );
    expect(foreign).toEqual([]);
  });
});

describe('atomicity: the business change and its audit row commit or roll back together', () => {
  it('GRANT: if the audit insert fails, the assignment that was already inserted is rolled back', async () => {
    const before = (await assignmentRows()).length;
    const seen: string[] = [];
    const e = await errOf(
      db.withTenant(ctxC, async (tx) => {
        const i = instrumented(tx, true);
        try {
          return await RoleAssignmentService.grant(i.tx, ctxC, {
            targetUserId: TARGET,
            roleId: await roleId(tx, 'STAFF'),
            scopeType: 'ORGANIZATION',
            reason: REASON,
          });
        } finally {
          seen.push(...i.statements);
        }
      }),
    );
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('AUDIT_WRITE_FAILED');
    // the role INSERT really executed first, in the same transaction object, then the audit insert failed
    const roleInsert = seen.findIndex((s) => /^INSERT INTO app\.role_assignments/.test(s));
    const auditInsert = seen.findIndex((s) => /^INSERT INTO app\.audit_events/.test(s));
    expect(roleInsert).toBeGreaterThan(-1);
    expect(auditInsert).toBeGreaterThan(roleInsert);
    // ...and yet nothing was committed
    expect(await assignmentRows()).toHaveLength(before);
  });

  it('REVOKE: if the audit insert fails, the assignment stays ACTIVE', async () => {
    const id = await db.withTenant(ctxC, async (tx) =>
      RoleAssignmentService.grant(tx, ctxC, {
        targetUserId: TARGET,
        roleId: await roleId(tx, 'STAFF'),
        scopeType: 'ORGANIZATION',
        reason: REASON,
      }),
    );
    const seen: string[] = [];
    const e = await errOf(
      db.withTenant(ctxC, async (tx) => {
        const i = instrumented(tx, true);
        try {
          await RoleAssignmentService.revoke(i.tx, ctxC, id, REASON);
        } finally {
          seen.push(...i.statements);
        }
      }),
    );
    expect(e.code).toBe('AUDIT_WRITE_FAILED');
    expect(seen.some((s) => /^UPDATE app\.role_assignments SET status = 'REVOKED'/.test(s))).toBe(
      true,
    ); // executed, then undone
    const row = (await assignmentRows()).find((r) => r.id === id);
    expect(row?.status).toBe('ACTIVE');
    expect(await auditRows(id)).toHaveLength(1); // only the original grant event
    await db.withTenant(ctxC, (tx) => RoleAssignmentService.revoke(tx, ctxC, id, REASON)); // cleanup path works
  });

  it('a successful grant leaves exactly one assignment and one audit row (never one without the other)', async () => {
    const id = await db.withTenant(ctxC, async (tx) =>
      RoleAssignmentService.grant(tx, ctxC, {
        targetUserId: TARGET,
        roleId: await roleId(tx, 'FACULTY'),
        scopeType: 'ORGANIZATION',
        reason: REASON,
      }),
    );
    expect((await assignmentRows()).filter((r) => r.id === id)).toHaveLength(1);
    expect(await auditRows(id)).toHaveLength(1);
    await db.withTenant(ctxC, (tx) => RoleAssignmentService.revoke(tx, ctxC, id, REASON));
  });
});

describe('a meaningful reason is required for grant and revoke', () => {
  const bad: unknown[] = [undefined, null, '', '   ', '\n', 'abc', '.....', 42, 'x'.repeat(501)];

  it.each(bad.map((b) => [JSON.stringify(b)?.slice(0, 20) ?? 'undefined', b]))(
    'grant with reason %s -> 400 and no database work',
    async (_n, reason) => {
      const before = (await assignmentRows()).length;
      let statements: string[] = [];
      const e = await errOf(
        db.withTenant(ctxC, async (tx) => {
          const i = instrumented(tx, false);
          statements = i.statements;
          return RoleAssignmentService.grant(i.tx, ctxC, {
            targetUserId: TARGET,
            roleId: await roleId(tx, 'STAFF'),
            scopeType: 'ORGANIZATION',
            reason: reason as string,
          });
        }),
      );
      expect(e).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(statements).toEqual([]);
      expect(await assignmentRows()).toHaveLength(before);
    },
  );

  it.each(bad.map((b) => [JSON.stringify(b)?.slice(0, 20) ?? 'undefined', b]))(
    'revoke with reason %s -> 400 and the assignment is untouched',
    async (_n, reason) => {
      const id = await db.withTenant(ctxC, async (tx) =>
        RoleAssignmentService.grant(tx, ctxC, {
          targetUserId: TARGET,
          roleId: await roleId(tx, 'STAFF'),
          scopeType: 'ORGANIZATION',
          reason: REASON,
        }),
      );
      const e = await errOf(
        db.withTenant(ctxC, (tx) => RoleAssignmentService.revoke(tx, ctxC, id, reason as string)),
      );
      expect(e).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect((await assignmentRows()).find((r) => r.id === id)?.status).toBe('ACTIVE');
      expect(await auditRows(id)).toHaveLength(1);
      await db.withTenant(ctxC, (tx) => RoleAssignmentService.revoke(tx, ctxC, id, REASON));
    },
  );
});

describe('audit writes require a valid tenant context', () => {
  it('a context whose user is not a member of the tenant is rejected by the database probe before any work or audit', async () => {
    const stranger = issueTrustedContext({
      tenantId: ORG_C,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });
    let ran = false;
    const e = await errOf(db.withTenant(stranger, () => ((ran = true), Promise.resolve())));
    expect(e).toMatchObject({ code: 'CONTEXT_REJECTED' });
    expect(ran).toBe(false);
    expect(ORG_A).toBeDefined();
  });
});
