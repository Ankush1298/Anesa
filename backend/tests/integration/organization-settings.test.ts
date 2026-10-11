import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { SettingsService } from '../../src/modules/organization/settings.service.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import {
  CAMPUS_1,
  CTX,
  DEPT_1,
  ORG_A,
  ORG_B,
  ORG_C,
  STAFF_C,
  TEMP_A,
  type Ctx,
} from '../support/fixtures.js';

// Organization settings registry (0012). ORG_C is the tenant reserved for tests that COMMIT writes: every
// state-dependent assertion uses it. ORG_A/ORG_B tests here are rolled back (or fail before writing) so they cannot
// disturb other files that run in parallel against the same database. `identity.dob_required` is reserved for this
// file; the route tests use other keys.
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 4 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

const AGE = 'identity.age_of_majority';
const DOB = 'identity.dob_required';
const NOTIFY = 'guardian.notification_policy';
const REASON = 'Aligned with the institution policy';

class Rollback extends Error {}
const ctxOf = (a: Ctx): TrustedContext =>
  issueTrustedContext({ tenantId: a.tenant, userId: a.user, actorKind: a.kind });

async function scratch(
  actor: Ctx,
  fn: (tx: TenantTx, ctx: TrustedContext) => Promise<void>,
): Promise<void> {
  const ctx = ctxOf(actor);
  await db
    .withTenant(ctx, async (tx) => {
      await fn(tx, ctx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const status = (p: Promise<unknown>): Promise<number | undefined> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : undefined),
  );

/** Committed write as the given actor, with fresh audit metadata whose request id identifies the audit row. */
async function commitSet(
  actor: Ctx,
  key: string,
  value: unknown,
  opts: { reason?: unknown; ip?: string } = {},
) {
  const requestId = randomUUID();
  const ctx = ctxOf(actor);
  const record = await db.withTenant(ctx, (tx) =>
    SettingsService.set(
      tx,
      ctx,
      key,
      { value, reason: opts.reason ?? REASON },
      { requestId, ip: opts.ip ?? '10.0.0.7', userAgent: 'settings-test' },
    ),
  );
  return { record, requestId };
}

const auditRows = (requestId: string) =>
  adminQuery<{
    action: string;
    resource_type: string;
    resource_id: string | null;
    risk_tier: number;
    reason_text: string | null;
    actor_user_id: string;
    organization_id: string;
    ip: string;
    user_agent: string;
    changes: { value: { old: unknown; new: unknown } };
    metadata: { settingKey: string; created: boolean };
  }>(
    `SELECT action, resource_type, resource_id, risk_tier, reason_text, actor_user_id, organization_id,
            ip, user_agent, changes, metadata
       FROM app.audit_events WHERE request_id = $1`,
    [requestId],
  );

const storedRow = (org: string, key: string) =>
  adminQuery<{ value: unknown; version: number; updated_by: string; organization_id: string }>(
    `SELECT value, version, updated_by, organization_id FROM app.organization_settings
      WHERE organization_id = $1 AND key = $2`,
    [org, key],
  );

const wipeOrgC = () =>
  adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [ORG_C]);
beforeEach(wipeOrgC);
afterEach(wipeOrgC);

describe('SettingsService.list', () => {
  it('a tenant that has stored nothing sees only the registry defaults (identity.age_of_majority = 18)', async () => {
    const ctx = ctxOf(CTX.staffC);
    const list = await db.withTenant(ctx, (tx) => SettingsService.list(tx, ctx));
    expect(list).toEqual([
      { key: AGE, value: 18, isDefault: true, version: null, updatedAt: null },
    ]);
  });

  it('a stored value replaces the default; results are sorted by key; stored values report version and time', async () => {
    await commitSet(CTX.staffC, NOTIFY, 'MINORS_ONLY');
    await commitSet(CTX.staffC, AGE, 21);
    const ctx = ctxOf(CTX.staffC);
    const list = await db.withTenant(ctx, (tx) => SettingsService.list(tx, ctx));
    // 'guardian.…' sorts before 'identity.…'
    expect(list.map((r) => r.key)).toEqual([NOTIFY, AGE]);
    expect(list[0]).toMatchObject({
      key: NOTIFY,
      value: 'MINORS_ONLY',
      isDefault: false,
      version: 1,
    });
    expect(list[1]).toMatchObject({ key: AGE, value: 21, isDefault: false, version: 1 });
    expect(Date.parse(list[0]?.updatedAt ?? '')).not.toBeNaN();
  });

  it('a stored row whose key is not (or no longer) registered is never returned', async () => {
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'legacy.removed_key', '"x"'::jsonb, $2)`,
      [ORG_C, STAFF_C],
    );
    const ctx = ctxOf(CTX.staffC);
    const list = await db.withTenant(ctx, (tx) => SettingsService.list(tx, ctx));
    expect(list.map((r) => r.key)).toEqual([AGE]);
  });

  it('writes no audit event', async () => {
    const before = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND action = 'organization.setting.update'`,
      [ORG_C],
    );
    const ctx = ctxOf(CTX.staffC);
    await db.withTenant(ctx, (tx) => SettingsService.list(tx, ctx));
    const after = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND action = 'organization.setting.update'`,
      [ORG_C],
    );
    expect(after.length).toBe(before.length);
  });
});

describe('authorization: tenant-wide reads for org.settings.read; org-scoped writes for org.settings.manage', () => {
  it('COLLEGE_ADMIN (org scope) may read and write', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(SettingsService.list(tx, ctx))).toBe(200);
      expect(await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON }))).toBe(
        200,
      );
    });
  });

  it('CAMPUS_ADMIN (campus scope: holds org.settings.read) may read tenant-wide settings, but cannot write (403)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      expect(await status(SettingsService.list(tx, ctx))).toBe(200);
      expect(await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON }))).toBe(
        403,
      );
      const rows = await tx.query(
        'SELECT 1 FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
        [CTX.campusAdminA.tenant, DOB],
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  it.each([
    ['FACULTY', CTX.facultyA],
    ['HOD (department scope)', CTX.hodA],
    ['a staff user with no role', CTX.noroleA],
    ['a staff user with no assignment', CTX.tempA],
    ['a STUDENT', CTX.studentA],
    ['another STUDENT', CTX.studentB],
  ])(
    '%s lacks org.settings.read: refused with 403 for list AND set, and nothing is written',
    async (_name, actor) => {
      await scratch(actor, async (tx, ctx) => {
        expect(await status(SettingsService.list(tx, ctx))).toBe(403);
        expect(
          await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON })),
        ).toBe(403);
        const rows = await tx.query(
          'SELECT 1 FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
          [actor.tenant, DOB],
        );
        expect(rows.rows).toHaveLength(0);
      });
    },
  );

  it('REGISTRAR with an ORGANIZATION-scoped assignment may read (org.settings.read) but not write (no org.settings.manage)', async () => {
    await scratch(CTX.tempA, async (tx, ctx) => {
      await tx.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION', NULL::uuid, NULL::uuid, NULL::uuid
           FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'REGISTRAR'`,
        [uuidv7(), ORG_A, TEMP_A],
      );
      expect(await status(SettingsService.list(tx, ctx))).toBe(200);
      expect(await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON }))).toBe(
        403,
      );
    });
  });

  it('REGISTRAR with a CAMPUS-scoped assignment may read tenant-wide settings but not write (no org.settings.manage)', async () => {
    await scratch(CTX.tempA, async (tx, ctx) => {
      await tx.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'CAMPUS', $4::uuid, $4::uuid, NULL::uuid
           FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'REGISTRAR'`,
        [uuidv7(), ORG_A, TEMP_A, CAMPUS_1],
      );
      expect(await status(SettingsService.list(tx, ctx))).toBe(200);
      expect(await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON }))).toBe(
        403,
      );
    });
  });

  it('role with a DEPARTMENT-scoped assignment holding org.settings.read may read tenant-wide settings but not write', async () => {
    const roleId = uuidv7();
    const assignmentId = uuidv7();
    try {
      await adminQuery(
        `INSERT INTO app.roles (id, organization_id, code, name)
         VALUES ($1, $2, 'DEPT_READER', 'Department Reader')`,
        [roleId, ORG_A],
      );
      await adminQuery(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         VALUES ($1, $2, 'org.settings.read', 'GRANTED')`,
        [ORG_A, roleId],
      );
      await adminQuery(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         VALUES ($1, $2, $3, $4, 'DEPARTMENT', $5, NULL, $5)`,
        [assignmentId, ORG_A, TEMP_A, roleId, DEPT_1],
      );

      await scratch(CTX.tempA, async (tx, ctx) => {
        expect(await status(SettingsService.list(tx, ctx))).toBe(200);
        expect(
          await status(SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON })),
        ).toBe(403);
      });
    } finally {
      await adminQuery('DELETE FROM app.role_assignments WHERE id = $1', [assignmentId]);
      await adminQuery('DELETE FROM app.role_permissions WHERE role_id = $1', [roleId]);
      await adminQuery('DELETE FROM app.roles WHERE id = $1', [roleId]);
    }
  });

  it('a caller holding org.settings.read in tenant A cannot read tenant B settings', async () => {
    const crossTenantCtx = issueTrustedContext({
      tenantId: ORG_B,
      userId: CTX.campusAdminA.user,
      actorKind: 'STAFF',
    });
    await scratch(CTX.staffB, async (tx) => {
      // In ORG_B transaction, campusAdminA has no active role_assignments in ORG_B:
      expect(await status(SettingsService.list(tx, crossTenantCtx))).toBe(403);
    });
  });

  it('a refused caller learns nothing about the registry: unknown key is 403, not 404', async () => {
    await scratch(CTX.facultyA, async (tx, ctx) => {
      expect(
        await status(SettingsService.set(tx, ctx, 'no.such_key', { value: 1, reason: REASON })),
      ).toBe(403);
    });
  });

  it('a forged (non-issued) context is refused before anything else', async () => {
    const forged = {
      tenantId: ORG_A,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    } as unknown as TrustedContext;
    await scratch(CTX.staffA, async (tx) => {
      await expect(SettingsService.list(tx, forged)).rejects.toMatchObject({
        statusCode: 500,
        code: 'UNTRUSTED_CONTEXT',
      });
      await expect(
        SettingsService.set(tx, forged, DOB, { value: true, reason: REASON }),
      ).rejects.toMatchObject({ statusCode: 500, code: 'UNTRUSTED_CONTEXT' });
    });
  });
});

describe('SettingsService.set: validation', () => {
  it('an unregistered or malformed key is 404 for an authorized caller', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      for (const key of [
        'no.such_key',
        'Identity.age_of_majority',
        'identity.age_of_majority ',
        'terminology',
        '__proto__',
        '',
      ]) {
        expect(
          await status(SettingsService.set(tx, ctx, key, { value: 1, reason: REASON })),
          JSON.stringify(key),
        ).toBe(404);
      }
    });
  });

  it('values outside the key schema are 400, the message never echoes the submitted value, and nothing is stored', async () => {
    const marker = 'SUBMITTED-MARKER-9137';
    await scratch(CTX.staffC, async (tx, ctx) => {
      const attempts: [string, unknown][] = [
        [AGE, -1],
        [AGE, 151],
        [AGE, 18.5],
        [AGE, '18'],
        [AGE, null],
        [AGE, marker],
        [DOB, 'true'],
        [DOB, 1],
        [DOB, null],
        [DOB, marker],
        [NOTIFY, 'never'],
        [NOTIFY, marker],
        [NOTIFY, { v: marker }],
        ['guardian.academic_visibility', 'ALWAYS'],
      ];
      for (const [key, value] of attempts) {
        const err = await SettingsService.set(tx, ctx, key, { value, reason: REASON }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err, `${key}=${JSON.stringify(value)}`).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).message).not.toContain(marker);
      }
      const rows = await tx.query(
        'SELECT 1 FROM app.organization_settings WHERE organization_id = $1 AND key = ANY($2::text[])',
        [ORG_C, [AGE, DOB, NOTIFY, 'guardian.academic_visibility']],
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  it('a missing value, or a missing / blank / too short / too long / non-string reason is 400', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const bad: unknown[] = [
        {},
        { value: true },
        { value: true, reason: '' },
        { value: true, reason: '    ' },
        { value: true, reason: 'abc' },
        { value: true, reason: '!!!!!!!!' }, // no letter or digit
        { value: true, reason: 'x'.repeat(501) },
        { value: true, reason: 12345 },
        { value: true, reason: null },
        { reason: REASON },
        null,
        undefined,
        'a string body',
      ];
      for (const input of bad) {
        expect(
          await status(
            SettingsService.set(tx, ctx, DOB, input as { value: unknown; reason: unknown }),
          ),
          JSON.stringify(input),
        ).toBe(400);
      }
    });
  });
});

describe('SettingsService.set: behaviour (committed, ORG_C)', () => {
  it('the first write creates the row; a different value updates it and bumps the version; the same value is a no-op', async () => {
    const first = await commitSet(CTX.staffC, AGE, 21);
    expect(first.record).toMatchObject({ key: AGE, value: 21, isDefault: false, version: 1 });
    expect(await storedRow(ORG_C, AGE)).toEqual([
      { value: 21, version: 1, updated_by: STAFF_C, organization_id: ORG_C },
    ]);

    const second = await commitSet(CTX.staffC, AGE, 16);
    expect(second.record).toMatchObject({ value: 16, version: 2 });

    const noop = await commitSet(CTX.staffC, AGE, 16);
    expect(noop.record).toMatchObject({ value: 16, version: 2 });
    expect((await storedRow(ORG_C, AGE))[0]).toMatchObject({ value: 16, version: 2 });
    expect(await auditRows(noop.requestId)).toEqual([]); // a no-op is not a change
  });

  it('explicitly setting the default value stores a row (the stored state changed)', async () => {
    const r = await commitSet(CTX.staffC, AGE, 18);
    expect(r.record).toMatchObject({ value: 18, isDefault: false, version: 1 });
    expect(await auditRows(r.requestId)).toHaveLength(1);
  });

  it('records exactly one audit row per change: CRITICAL tier 2, reason, actor, request facts and an old/new diff', async () => {
    const created = await commitSet(CTX.staffC, NOTIFY, 'NEVER', { reason: `  ${REASON}  ` });
    const rows = await auditRows(created.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'organization.setting.update',
      resource_type: 'organization_setting',
      resource_id: null,
      risk_tier: 2,
      reason_text: REASON, // trimmed
      actor_user_id: STAFF_C,
      organization_id: ORG_C,
      ip: '10.0.0.7',
      user_agent: 'settings-test',
      changes: { value: { old: null, new: 'NEVER' } },
      metadata: { settingKey: NOTIFY, created: true },
    });

    const updated = await commitSet(CTX.staffC, NOTIFY, 'ALWAYS_WHEN_ENABLED');
    const rows2 = await auditRows(updated.requestId);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]).toMatchObject({
      changes: { value: { old: 'NEVER', new: 'ALWAYS_WHEN_ENABLED' } },
      metadata: { settingKey: NOTIFY, created: false },
    });
  });

  it('if the audit write fails, the creation is rolled back: no row, no audit', async () => {
    const requestId = randomUUID();
    const ctx = ctxOf(CTX.staffC);
    await expect(
      db.withTenant(ctx, (tx) =>
        // an invalid ip makes recordAudit throw AUDIT_INVALID after the INSERT has been issued
        SettingsService.set(
          tx,
          ctx,
          DOB,
          { value: true, reason: REASON },
          { requestId, ip: 'not-an-ip' },
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 500, code: 'AUDIT_INVALID' });
    expect(await storedRow(ORG_C, DOB)).toEqual([]);
    expect(await auditRows(requestId)).toEqual([]);
  });

  it('if the audit write fails, an UPDATE is rolled back too: the old value and version remain', async () => {
    await commitSet(CTX.staffC, AGE, 21);
    const requestId = randomUUID();
    const ctx = ctxOf(CTX.staffC);
    await expect(
      db.withTenant(ctx, (tx) =>
        SettingsService.set(
          tx,
          ctx,
          AGE,
          { value: 16, reason: REASON },
          { requestId, ip: 'not-an-ip' },
        ),
      ),
    ).rejects.toMatchObject({ code: 'AUDIT_INVALID' });
    expect((await storedRow(ORG_C, AGE))[0]).toMatchObject({ value: 21, version: 1 });
    expect(await auditRows(requestId)).toEqual([]);
  });

  it('a later failure in the same transaction rolls back both the setting and its audit row', async () => {
    const requestId = randomUUID();
    const ctx = ctxOf(CTX.staffC);
    await expect(
      db.withTenant(ctx, async (tx) => {
        await SettingsService.set(tx, ctx, DOB, { value: true, reason: REASON }, { requestId });
        throw new Error('simulated failure after the setting and its audit row were written');
      }),
    ).rejects.toThrow('simulated failure');
    expect(await storedRow(ORG_C, DOB)).toEqual([]);
    expect(await auditRows(requestId)).toEqual([]);
  });

  it('two concurrent FIRST writes of one key both succeed: one creates, the other updates (version 2, two audit rows)', async () => {
    const [a, b] = await Promise.all([
      commitSet(CTX.staffC, NOTIFY, 'NEVER'),
      commitSet(CTX.staffC, NOTIFY, 'MINORS_ONLY'),
    ]);
    const stored = await storedRow(ORG_C, NOTIFY);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.version).toBe(2);
    expect(['NEVER', 'MINORS_ONLY']).toContain(stored[0]?.value);
    const audits = [...(await auditRows(a.requestId)), ...(await auditRows(b.requestId))];
    expect(audits).toHaveLength(2);
    expect(audits.filter((r) => r.metadata.created).length).toBe(1);
  });

  it('concurrent updates of an existing key serialize: no lost update, one audit row each', async () => {
    await commitSet(CTX.staffC, AGE, 18 + 1);
    const [a, b] = await Promise.all([
      commitSet(CTX.staffC, AGE, 16),
      commitSet(CTX.staffC, AGE, 17),
    ]);
    const stored = await storedRow(ORG_C, AGE);
    expect(stored[0]?.version).toBe(3);
    expect([16, 17]).toContain(stored[0]?.value);
    const rowsA = await auditRows(a.requestId);
    const rowsB = await auditRows(b.requestId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    // the second writer saw the first writer's committed value as its "old" value
    const olds = [rowsA[0]?.changes.value.old, rowsB[0]?.changes.value.old].sort();
    expect(olds).toEqual([19, stored[0]?.value === 16 ? 17 : 16].sort());
  });

  describe('optimistic concurrency (expectedVersion)', () => {
    beforeEach(async () => {
      await adminQuery(
        'DELETE FROM app.organization_settings WHERE organization_id = $1 AND key = $2',
        [ORG_A, NOTIFY],
      );
    });

    it('initial expectation requires row not to exist; fails with 409 if exists', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        const rec = await SettingsService.set(
          tx,
          ctx,
          NOTIFY,
          { value: 'NEVER', reason: REASON },
          { expectedVersion: { type: 'initial' } },
        );
        expect(rec.version).toBe(1);

        await expect(
          SettingsService.set(
            tx,
            ctx,
            NOTIFY,
            { value: 'MINORS_ONLY', reason: REASON },
            { expectedVersion: { type: 'initial' } },
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
    });

    it('guarded version update requires exact version match; stale version throws 409', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        const rec1 = await SettingsService.set(
          tx,
          ctx,
          NOTIFY,
          { value: 'NEVER', reason: REASON },
          { expectedVersion: { type: 'initial' } },
        );
        expect(rec1.version).toBe(1);

        await expect(
          SettingsService.set(
            tx,
            ctx,
            NOTIFY,
            { value: 'MINORS_ONLY', reason: REASON },
            { expectedVersion: { type: 'version', version: 0 } },
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

        const rec2 = await SettingsService.set(
          tx,
          ctx,
          NOTIFY,
          { value: 'MINORS_ONLY', reason: REASON },
          { expectedVersion: { type: 'version', version: 1 } },
        );
        expect(rec2.version).toBe(2);

        await expect(
          SettingsService.set(
            tx,
            ctx,
            NOTIFY,
            { value: 'ALWAYS_WHEN_ENABLED', reason: REASON },
            { expectedVersion: { type: 'version', version: 1 } },
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
    });

    it('no-op check does not bypass stale version conflict', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await SettingsService.set(
          tx,
          ctx,
          NOTIFY,
          { value: 'NEVER', reason: REASON },
          { expectedVersion: { type: 'initial' } },
        );
        await SettingsService.set(
          tx,
          ctx,
          NOTIFY,
          { value: 'MINORS_ONLY', reason: REASON },
          { expectedVersion: { type: 'version', version: 1 } },
        );

        await expect(
          SettingsService.set(
            tx,
            ctx,
            NOTIFY,
            { value: 'MINORS_ONLY', reason: REASON },
            { expectedVersion: { type: 'version', version: 1 } },
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
    });
  });
});

describe('tenant isolation', () => {
  it('a value stored by one tenant is invisible to the others and never written under another tenant id', async () => {
    await commitSet(CTX.staffC, DOB, true);
    expect(await storedRow(ORG_C, DOB)).toHaveLength(1);
    // exactly one row for the key exists anywhere: nothing was written under ORG_A / ORG_B
    expect(
      await adminQuery('SELECT organization_id FROM app.organization_settings WHERE key = $1', [
        DOB,
      ]),
    ).toEqual([{ organization_id: ORG_C }]);

    for (const actor of [CTX.staffA, CTX.staffB]) {
      await scratch(actor, async (tx, ctx) => {
        const list = await SettingsService.list(tx, ctx);
        expect(list.map((r) => r.key)).not.toContain(DOB);
        const direct = await tx.query('SELECT 1 FROM app.organization_settings WHERE key = $1', [
          DOB,
        ]);
        expect(direct.rows).toHaveLength(0); // RLS, not just the service filter
      });
    }
  });

  it('tenants keep independent values for the same key', async () => {
    await commitSet(CTX.staffC, DOB, true);
    await scratch(CTX.staffB, async (tx, ctx) => {
      await SettingsService.set(tx, ctx, DOB, { value: false, reason: REASON });
      const mine = await tx.query<{ value: unknown }>(
        'SELECT value FROM app.organization_settings WHERE key = $1',
        [DOB],
      );
      expect(mine.rows).toEqual([{ value: false }]);
    });
    expect((await storedRow(ORG_C, DOB))[0]).toMatchObject({ value: true, version: 1 });
  });
});
