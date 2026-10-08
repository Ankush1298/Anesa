import { afterAll, describe, expect, inject, it } from 'vitest';
import { ContextRejectedError, Database, type TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { UnsafeSqlError } from '../../src/shared/database/sql-guard.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  CTX,
  GUARDIAN_A,
  GUARDIAN_B,
  GUARDIAN_C,
  ORG_A,
  ORG_B,
  STAFF_B,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
  USER_A,
  USER_A2,
} from '../support/fixtures.js';
import { runAs } from '../support/db-harness.js';

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

describe('Tampering — tenant (hostile values supplied by an authenticated Tenant A user)', () => {
  it('request says tenant_id = Tenant B: reads return nothing', async () => {
    for (const t of ['students', 'users', 'student_guardians']) {
      expect(
        (await runAs(CTX.staffA, `SELECT id FROM app.${t} WHERE organization_id = $1`, [ORG_B]))
          .rows,
        t,
      ).toEqual([]);
    }
  });

  it('request inserts tenant_id = Tenant B: refused by RLS', async () => {
    const r = await runAs(
      CTX.staffA,
      "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d401', $1, $2, 'T', '+10000000044', 'AUNT')",
      [ORG_B, STUDENT_C],
    );
    expect(r.error?.code).toBe('42501');
    expect(r.error?.message).toMatch(/row-level security/);
  });

  it("request updates tenant_id (own row -> Tenant B, or B's row): refused", async () => {
    for (const table of ['students', 'users', 'student_guardians']) {
      const own = table === 'users' ? USER_A : table === 'students' ? STUDENT_A : GUARDIAN_A;
      const r = await runAs(
        CTX.staffA,
        `UPDATE app.${table} SET organization_id = $1 WHERE id = $2`,
        [ORG_B, own],
      );
      expect(r.error?.code, `${table} own row`).toBe('42501'); // no column privilege + trigger + WITH CHECK
      const foreign = table === 'users' ? STAFF_B : table === 'students' ? STUDENT_C : GUARDIAN_C;
      const f = await runAs(
        CTX.staffA,
        `UPDATE app.${table} SET organization_id = $1 WHERE id = $2`,
        [ORG_A, foreign],
      );
      expect(f.error?.code === '42501' || f.rowCount === 0, `${table} foreign row`).toBe(true);
    }
  });

  it('request swaps an object id for one that belongs to Tenant B: not found / refused', async () => {
    expect(
      (await runAs(CTX.staffA, 'SELECT id FROM app.student_guardians WHERE id = $1', [GUARDIAN_C]))
        .rows,
    ).toEqual([]);
    expect(
      (
        await runAs(
          CTX.staffA,
          "UPDATE app.student_guardians SET phone = '+1' || phone WHERE id = $1",
          [GUARDIAN_C],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await runAs(CTX.staffA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_C]))
        .rowCount,
    ).toBe(0);
  });

  it('request tries to rewrite the immutable primary key', async () => {
    const r = await runAs(
      CTX.staffA,
      "UPDATE app.students SET id = '01939a00-0000-7000-8000-00000000d499' WHERE id = $1",
      [STUDENT_A],
    );
    expect(r.error).toBeDefined();
  });
});

describe('Tampering — student (hostile values supplied by authenticated Student A)', () => {
  it('request says student_id = Student B on read/update/delete/insert: all refused or empty', async () => {
    expect(
      (
        await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians WHERE student_id = $1', [
          STUDENT_B,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await runAs(
          CTX.studentA,
          "UPDATE app.student_guardians SET full_name = 'x' WHERE student_id = $1",
          [STUDENT_B],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(CTX.studentA, 'DELETE FROM app.student_guardians WHERE student_id = $1', [
          STUDENT_B,
        ])
      ).rowCount,
    ).toBe(0);
    const ins = await runAs(
      CTX.studentA,
      "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d501', $1, $2, 'T', '+10000000033', 'AUNT')",
      [ORG_A, STUDENT_B],
    );
    expect(ins.error?.code).toBe('42501');
  });

  it('request updates student_id on its own record to Student B / C: refused', async () => {
    for (const target of [STUDENT_B, STUDENT_C]) {
      const r = await runAs(
        CTX.studentA,
        'UPDATE app.student_guardians SET student_id = $1 WHERE id = $2',
        [target, GUARDIAN_A],
      );
      expect(r.error, target).toBeDefined();
    }
  });

  it("request swaps an object id for Student B's object id: not found", async () => {
    expect(
      (
        await runAs(CTX.studentA, 'SELECT id FROM app.student_guardians WHERE id = $1', [
          GUARDIAN_B,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await runAs(CTX.studentA, "UPDATE app.student_guardians SET phone = '+1' WHERE id = $1", [
          GUARDIAN_B,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("request claims to be Student B by naming B's user id only works if the SERVER says so — the database does not accept the claim from data", async () => {
    // There is no SQL surface that takes a "student_id" as authority: a student's own query for B's student row is empty.
    expect(
      (await runAs(CTX.studentA, 'SELECT id FROM app.students WHERE user_id = $1', [USER_A2])).rows,
    ).toEqual([]);
  });
});

describe('Tampering — the application boundary (Database.withTenant)', () => {
  const ctxA = issueTrustedContext({
    tenantId: CTX.staffA.tenant,
    userId: CTX.staffA.user,
    actorKind: 'STAFF',
  });

  it('a hand-built context object is rejected even if it looks identical to a real one', async () => {
    const forged = { tenantId: CTX.staffA.tenant, userId: CTX.staffA.user, actorKind: 'STAFF' };
    await expect(db.withTenant(forged as never, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'UNTRUSTED_CONTEXT',
    });
    await expect(db.withTenant({ ...ctxA }, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'UNTRUSTED_CONTEXT',
    });
  });

  it('a client-chosen tenant paired with a real user from another tenant is refused by the database, work never runs', async () => {
    const mismatched = issueTrustedContext({
      tenantId: ORG_B,
      userId: CTX.staffA.user,
      actorKind: 'STAFF',
    });
    let ran = false;
    await expect(
      db.withTenant(mismatched, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(ContextRejectedError);
    expect(ran).toBe(false);
  });

  it('an unknown user or an inactive user is refused', async () => {
    const unknown = issueTrustedContext({
      tenantId: ORG_A,
      userId: '01939a00-0000-7000-8000-00000000ffff',
      actorKind: 'STAFF',
    });
    await expect(db.withTenant(unknown, () => Promise.resolve())).rejects.toBeInstanceOf(
      ContextRejectedError,
    );
  });

  it('the transaction handle cannot change the context, escape the transaction, or be used afterwards', async () => {
    const attacks = [
      "SELECT set_config('app.tenant_id', $1, true)",
      "SELECT pg_catalog.set_config('app.user_id', $1, false)",
      "SET LOCAL app.tenant_id = 'x'",
      'RESET ALL',
      'COMMIT',
      'SELECT 1; SELECT 2',
    ];
    for (const sql of attacks) {
      await expect(
        db.withTenant(ctxA, (tx) => tx.query(sql, sql.includes('$1') ? [ORG_B] : [])),
        sql,
      ).rejects.toBeInstanceOf(UnsafeSqlError);
    }
    const holder: { tx?: TenantTx } = {};
    await db.withTenant(ctxA, (tx) => {
      holder.tx = tx;
      return Promise.resolve();
    });
    await expect(holder.tx?.query('SELECT 1')).rejects.toThrow(/after its transaction ended/);
  });
});
