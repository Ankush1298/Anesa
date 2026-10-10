import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CTX, ORG_A, ORG_B, STAFF_A, STAFF_B, USER_A } from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';

// organization_settings (0012): least privilege, staff-only writes, DATABASE-enforced authorship and tenant isolation,
// proven against the real database. Every runtime statement runs in a transaction that is rolled back; the two seed
// rows below are committed by the superuser (this project has its own database) and removed afterwards.
const AGE = 'identity.age_of_majority';
const DOB = 'identity.dob_required';

beforeAll(async () => {
  await adminQuery(
    `INSERT INTO app.organization_settings (organization_id, key, value, updated_by) VALUES
       ($1, $3, '21'::jsonb, $4),
       ($2, $3, '16'::jsonb, $5)`,
    [ORG_A, ORG_B, AGE, STAFF_A, STAFF_B],
  );
});
afterAll(async () => {
  await adminQuery('DELETE FROM app.organization_settings');
});

const insertAs = (org: string, by: string, key = DOB): string =>
  `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
   VALUES ('${org}', '${key}', 'true'::jsonb, '${by}')`;

describe('organization_settings: runtime privileges', () => {
  it('the runtime role cannot DELETE, TRUNCATE, REFERENCE or TRIGGER', async () => {
    for (const priv of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const [r] = await adminQuery<{ ok: boolean }>(
        'SELECT has_table_privilege($1, $2, $3) AS ok',
        ['app_runtime', 'app.organization_settings', priv],
      );
      expect(r?.ok, priv).toBe(false);
    }
    const del = await runAs(CTX.staffA, 'DELETE FROM app.organization_settings');
    expect(del.error?.code).toBe('42501');
    const trunc = await runAs(CTX.staffA, 'TRUNCATE app.organization_settings');
    expect(trunc.error?.code).toBe('42501');
  });

  it('UPDATE is limited to value and updated_by (no table-wide UPDATE)', async () => {
    const [t] = await adminQuery<{ ok: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'app.organization_settings', 'UPDATE') AS ok`,
    );
    expect(t?.ok).toBe(false);
    const cols = await adminQuery<{ column_name: string; ok: boolean }>(
      `SELECT column_name::text, has_column_privilege('app_runtime', 'app.organization_settings', column_name, 'UPDATE') AS ok
         FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'organization_settings' ORDER BY ordinal_position`,
    );
    expect(cols.filter((c) => c.ok).map((c) => c.column_name)).toEqual(['value', 'updated_by']);
    // identity, the primary key, the version and the timestamps are refused by the privilege layer itself
    for (const col of ['organization_id', 'key', 'version', 'created_at', 'updated_at']) {
      const r = await runAs(CTX.staffA, `UPDATE app.organization_settings SET ${col} = ${col}`);
      expect(r.error?.code, col).toBe('42501');
    }
  });

  it('the touch and immutable-keys triggers are installed', async () => {
    const rows = await adminQuery<{ tgname: string }>(
      `SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'app.organization_settings'::regclass AND NOT tgisinternal ORDER BY 1`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'organization_settings_immutable',
      'organization_settings_touch',
    ]);
  });

  it('org.settings.manage is registered as CRITICAL and org.settings.read as NORMAL (doc 10 rows 18-19)', async () => {
    const rows = await adminQuery<{ code: string; sensitivity: string }>(
      `SELECT code, sensitivity FROM platform.permissions WHERE code LIKE 'org.settings.%' ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'org.settings.manage', sensitivity: 'CRITICAL' },
      { code: 'org.settings.read', sensitivity: 'NORMAL' },
    ]);
  });
});

describe('organization_settings: policies', () => {
  it('tenant policies for SELECT/INSERT/UPDATE, staff and authorship RESTRICTIVE policies, no DELETE policy, all TO app_runtime', async () => {
    const pol = await adminQuery<{
      cmd: string;
      permissive: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT cmd, permissive, roles::text, qual, with_check FROM pg_policies
        WHERE schemaname = 'app' AND tablename = 'organization_settings'`,
    );
    expect(pol.every((p) => p.roles === '{app_runtime}')).toBe(true);
    const by = (permissive: string): string[] =>
      pol
        .filter((p) => p.permissive === permissive)
        .map((p) => p.cmd)
        .sort();
    expect(by('PERMISSIVE')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(by('RESTRICTIVE')).toEqual(['INSERT', 'INSERT', 'UPDATE', 'UPDATE']);
    const text = (p: (typeof pol)[number]): string => `${p.qual ?? ''}${p.with_check ?? ''}`;
    for (const p of pol.filter((x) => x.permissive === 'PERMISSIVE')) {
      expect(text(p), p.cmd).toContain('current_tenant_id');
    }
    const restrictive = pol.filter((x) => x.permissive === 'RESTRICTIVE');
    expect(restrictive.filter((p) => text(p).includes('current_actor_kind'))).toHaveLength(2);
    expect(restrictive.filter((p) => text(p).includes('current_user_id'))).toHaveLength(2);
  });
});

describe('organization_settings: behaviour under RLS', () => {
  it('tenant isolation: each tenant sees only its own rows; no context sees nothing', async () => {
    for (const [ctx, org] of [
      [CTX.staffA, ORG_A],
      [CTX.staffB, ORG_B],
    ] as const) {
      const r = await runAs(ctx, 'SELECT DISTINCT organization_id FROM app.organization_settings');
      expect(r.rows.map((x) => x['organization_id'])).toEqual([org]);
    }
    expect((await runAs({}, 'SELECT 1 FROM app.organization_settings')).rowCount).toBe(0);
    expect(
      (await runAs({ tenant: ORG_A }, 'SELECT 1 FROM app.organization_settings')).rowCount,
    ).toBe(0); // a tenant without a user fails the context check
  });

  it('staff can create in their own tenant, as themselves, and never in another tenant or without a context', async () => {
    expect((await runAs(CTX.staffA, insertAs(ORG_A, STAFF_A))).error).toBeUndefined();
    expect((await runAs(CTX.staffA, insertAs(ORG_B, STAFF_A))).error?.code).toBe('42501');
    expect((await runAs(CTX.staffA, insertAs(ORG_B, STAFF_B))).error?.code).toBe('42501');
    expect((await runAs({}, insertAs(ORG_A, STAFF_A))).error?.code).toBe('42501');
  });

  it('authorship cannot be forged on INSERT: updated_by must be the session user', async () => {
    // another user of the same tenant, a user of another tenant
    expect((await runAs(CTX.staffA, insertAs(ORG_A, USER_A))).error?.code).toBe('42501');
    expect((await runAs(CTX.staffA, insertAs(ORG_A, STAFF_B))).error?.code).toBe('42501');
  });

  it('authorship cannot be forged on UPDATE either, and a legitimate update advances the version', async () => {
    const forged = await runAs(
      CTX.staffA,
      `UPDATE app.organization_settings SET value = '22'::jsonb, updated_by = '${USER_A}' WHERE key = '${AGE}'`,
    );
    expect(forged.error?.code).toBe('42501');

    const ok = await runStepsAs(CTX.staffA, [
      [
        `UPDATE app.organization_settings SET value = '22'::jsonb, updated_by = '${STAFF_A}' WHERE key = '${AGE}'`,
      ],
      [`SELECT value, version, updated_by FROM app.organization_settings WHERE key = '${AGE}'`],
    ]);
    expect(ok.error).toBeUndefined();
    expect(ok.rows[0]).toEqual({ value: 22, version: 2, updated_by: STAFF_A });
  });

  it('a STUDENT session can read settings (server-side policy checks need them) but the database refuses every write', async () => {
    expect(
      (await runAs(CTX.studentA, 'SELECT 1 FROM app.organization_settings')).rowCount,
    ).toBeGreaterThan(0);
    expect((await runAs(CTX.studentA, insertAs(ORG_A, CTX.studentA.user))).error?.code).toBe(
      '42501',
    );
    // the restrictive UPDATE policy hides the rows from a STUDENT session: no error, nothing changes
    const upd = await runStepsAs(CTX.studentA, [
      [
        `UPDATE app.organization_settings SET value = '99'::jsonb, updated_by = '${CTX.studentA.user}' WHERE key = '${AGE}'`,
      ],
    ]);
    expect(upd.error?.code === '42501' || upd.rowCount === 0).toBe(true);
    const still = await adminQuery(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ORG_A, AGE],
    );
    expect(still).toEqual([{ value: 21 }]);
  });

  it("a tenant cannot update or delete another tenant's row", async () => {
    const upd = await runStepsAs(CTX.staffB, [
      [
        `UPDATE app.organization_settings SET value = '99'::jsonb, updated_by = '${STAFF_B}' WHERE organization_id = '${ORG_A}'`,
      ],
    ]);
    expect(upd.error).toBeUndefined();
    expect(upd.rowCount).toBe(0);
    expect(
      (
        await runAs(
          CTX.staffB,
          `DELETE FROM app.organization_settings WHERE organization_id = '${ORG_A}'`,
        )
      ).error?.code,
    ).toBe('42501');
    const still = await adminQuery(
      'SELECT value FROM app.organization_settings WHERE organization_id = $1',
      [ORG_A],
    );
    expect(still).toEqual([{ value: 21 }]);
  });

  it('the primary key and tenant are fixed after creation (privilege layer first)', async () => {
    for (const col of ['organization_id', 'key']) {
      const r = await runAs(CTX.staffA, `UPDATE app.organization_settings SET ${col} = ${col}`);
      expect(r.error?.code, col).toBe('42501');
    }
  });
});

describe('organization_settings: constraints (superuser, so only the constraint can refuse)', () => {
  const insert = (org: string, key: string, value: string, by: string, version = 1) =>
    adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
       VALUES ($1, $2, ${value}, $3, $4)`,
      [org, key, by, version],
    );

  it('an author from another tenant is refused by the composite foreign key (23503)', async () => {
    await expect(insert(ORG_A, DOB, `'true'::jsonb`, STAFF_B)).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('refuses a duplicate (organization, key), an empty or over-long key, a NULL value, an oversized value and a bad version', async () => {
    await expect(insert(ORG_A, AGE, `'1'::jsonb`, STAFF_A)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insert(ORG_A, '', `'1'::jsonb`, STAFF_A)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(ORG_A, 'k'.repeat(101), `'1'::jsonb`, STAFF_A)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(ORG_A, DOB, `NULL`, STAFF_A)).rejects.toMatchObject({ code: '23502' });
    await expect(insert(ORG_A, DOB, `to_jsonb(repeat('x', 17000))`, STAFF_A)).rejects.toMatchObject(
      { code: '23514' },
    );
    await expect(insert(ORG_A, DOB, `'true'::jsonb`, STAFF_A, 0)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('a key of exactly 100 characters is accepted (boundary) and the row can be removed again', async () => {
    const key = 'k'.repeat(100);
    await insert(ORG_A, key, `'true'::jsonb`, STAFF_A);
    await adminQuery('DELETE FROM app.organization_settings WHERE key = $1', [key]);
  });
});
