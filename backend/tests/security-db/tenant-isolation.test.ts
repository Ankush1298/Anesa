import { describe, expect, it } from 'vitest';
import {
  CTX,
  GUARDIAN_A,
  GUARDIAN_B,
  GUARDIAN_C,
  ORG_A,
  ORG_B,
  STAFF_A,
  STAFF_B,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
  EXTRA_A_USER_IDS,
  USER_A,
  USER_A2,
  USER_B,
} from '../support/fixtures.js';
import { adminQuery, ids, runAs, snapshot } from '../support/db-harness.js';

// Every query below is deliberately written WITHOUT any tenant filter unless the point of the test is a
// hostile filter. If RLS did not enforce the boundary, these assertions would fail.
const sorted = (...v: string[]): string[] => [...v].sort();

describe('precondition: both tenants really have data (so "0 rows" can only mean RLS)', () => {
  it('superuser sees data for both tenants', async () => {
    const rows = await adminQuery<{ organization_id: string; n: number }>(
      'SELECT organization_id, count(*)::int AS n FROM app.students WHERE organization_id IN ($1, $2) GROUP BY 1 ORDER BY 1',
      [ORG_A, ORG_B],
    );
    expect(rows).toEqual([
      { organization_id: ORG_A, n: 2 },
      { organization_id: ORG_B, n: 1 },
    ]);
  });
});

describe('Tenant isolation — reads', () => {
  it('[1] Tenant A can read its own tenant data', async () => {
    expect(ids(await runAs(CTX.staffA, 'SELECT id FROM app.students'))).toEqual(
      sorted(STUDENT_A, STUDENT_B),
    );
    expect(ids(await runAs(CTX.staffA, 'SELECT id FROM app.users'))).toEqual(
      sorted(USER_A, USER_A2, STAFF_A, ...EXTRA_A_USER_IDS),
    );
    expect(ids(await runAs(CTX.staffA, 'SELECT id FROM app.student_guardians'))).toEqual(
      sorted(GUARDIAN_A, GUARDIAN_B),
    );
    expect(ids(await runAs(CTX.staffA, 'SELECT id FROM app.organizations'))).toEqual([ORG_A]);
  });

  it('[2] Tenant B can read its own tenant data', async () => {
    expect(ids(await runAs(CTX.staffB, 'SELECT id FROM app.students'))).toEqual([STUDENT_C]);
    expect(ids(await runAs(CTX.staffB, 'SELECT id FROM app.users'))).toEqual(
      sorted(USER_B, STAFF_B),
    );
    expect(ids(await runAs(CTX.staffB, 'SELECT id FROM app.student_guardians'))).toEqual([
      GUARDIAN_C,
    ]);
    expect(ids(await runAs(CTX.staffB, 'SELECT id FROM app.organizations'))).toEqual([ORG_B]);
  });

  it('[3] Tenant A cannot read Tenant B rows (by id, by tenant column, by join)', async () => {
    const byId = [
      ['students', STUDENT_C],
      ['users', USER_B],
      ['users', STAFF_B],
      ['student_guardians', GUARDIAN_C],
      ['organizations', ORG_B],
    ] as const;
    for (const [table, id] of byId) {
      expect(
        (await runAs(CTX.staffA, `SELECT id FROM app.${table} WHERE id = $1`, [id])).rows,
        `${table}/${id}`,
      ).toEqual([]);
    }
    for (const table of ['students', 'users', 'student_guardians']) {
      const r = await runAs(
        CTX.staffA,
        `SELECT count(*)::int AS n FROM app.${table} WHERE organization_id = $1`,
        [ORG_B],
      );
      expect(r.rows[0], table).toEqual({ n: 0 });
    }
    const joined = await runAs(
      CTX.staffA,
      'SELECT g.id FROM app.student_guardians g JOIN app.students s ON s.id = g.student_id WHERE s.organization_id = $1',
      [ORG_B],
    );
    expect(joined.rows).toEqual([]);
  });

  it('[4] Tenant B cannot read Tenant A rows', async () => {
    const byId = [
      ['students', STUDENT_A],
      ['students', STUDENT_B],
      ['users', USER_A],
      ['users', STAFF_A],
      ['student_guardians', GUARDIAN_A],
      ['student_guardians', GUARDIAN_B],
      ['organizations', ORG_A],
    ] as const;
    for (const [table, id] of byId) {
      expect(
        (await runAs(CTX.staffB, `SELECT id FROM app.${table} WHERE id = $1`, [id])).rows,
        `${table}/${id}`,
      ).toEqual([]);
    }
    const r = await runAs(
      CTX.staffB,
      'SELECT count(*)::int AS n FROM app.students WHERE organization_id = $1',
      [ORG_A],
    );
    expect(r.rows[0]).toEqual({ n: 0 });
  });

  it('[8] a query with NO application-level tenant filter still cannot cross tenants', async () => {
    const queries = [
      'SELECT * FROM app.students',
      'SELECT * FROM app.users',
      'SELECT * FROM app.student_guardians',
      'SELECT * FROM app.organizations',
      'SELECT s.* FROM app.students s CROSS JOIN app.users u',
      'WITH everyone AS (SELECT organization_id FROM app.students) SELECT * FROM everyone',
      'SELECT organization_id FROM app.students UNION ALL SELECT organization_id FROM app.users UNION ALL SELECT id FROM app.organizations',
      'SELECT * FROM app.students WHERE organization_id IN (SELECT id FROM app.organizations)',
      'SELECT * FROM app.students WHERE true OR organization_id = organization_id',
    ];
    for (const q of queries) {
      const r = await runAs(CTX.staffA, q);
      expect(r.error, q).toBeUndefined();
      expect(r.rows.length, q).toBeGreaterThan(0);
      for (const row of r.rows) {
        const org = (row['organization_id'] ?? row['id']) as string;
        expect(
          org === ORG_A ||
            [STUDENT_A, STUDENT_B, USER_A, USER_A2, STAFF_A, GUARDIAN_A, GUARDIAN_B].includes(org),
          `${q} leaked ${org}`,
        ).toBe(true);
      }
    }
    expect(
      (await runAs(CTX.staffA, 'SELECT count(*)::int AS n FROM app.students')).rows[0],
    ).toEqual({ n: 2 });
    expect(
      (await runAs(CTX.staffB, 'SELECT count(*)::int AS n FROM app.students')).rows[0],
    ).toEqual({ n: 1 });
  });
});

describe('Tenant isolation — writes', () => {
  it('[5] Tenant A cannot update Tenant B rows (and the same update works on its own rows)', async () => {
    const before = await snapshot();
    const updates: [string, unknown[]][] = [
      ["UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1", [STUDENT_C]],
      ["UPDATE app.students SET status = 'SUSPENDED' WHERE organization_id = $1", [ORG_B]],
      ["UPDATE app.users SET display_name = 'pwned' WHERE id = $1", [USER_B]],
      ["UPDATE app.student_guardians SET phone = '+19999999999' WHERE id = $1", [GUARDIAN_C]],
      ["UPDATE app.student_guardians SET phone = '+19999999999'", []],
    ];
    for (const [sql, p] of updates) {
      const r = await runAs(CTX.staffA, sql, p);
      expect(r.error, sql).toBeUndefined();
      const blanket = p.length === 0; // no WHERE at all: must still touch only Tenant A's two rows
      expect(r.rowCount, sql).toBe(blanket ? 2 : 0);
    }
    // positive controls: same statements against own tenant do work
    expect(
      (
        await runAs(CTX.staffA, "UPDATE app.students SET status = 'SUSPENDED' WHERE id = $1", [
          STUDENT_A,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await runAs(CTX.staffA, "UPDATE app.users SET display_name = 'x' WHERE id = $1", [USER_A]))
        .rowCount,
    ).toBe(1);
    expect(await snapshot()).toBe(before); // nothing was ever committed
  });

  it('[6] Tenant A cannot delete Tenant B rows (and can delete its own)', async () => {
    expect(
      (await runAs(CTX.staffA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_C]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(CTX.staffA, 'DELETE FROM app.student_guardians WHERE organization_id = $1', [
          ORG_B,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await runAs(CTX.staffA, 'DELETE FROM app.student_guardians')).rowCount).toBe(2); // only A's two
    expect(
      (await runAs(CTX.staffA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_A]))
        .rowCount,
    ).toBe(1);
    const remaining = await adminQuery(
      'SELECT id FROM app.student_guardians WHERE organization_id = $1',
      [ORG_B],
    );
    expect(remaining.length).toBe(1);
  });

  it('[7] Tenant A cannot insert a row belonging to Tenant B', async () => {
    const forged: [string, unknown[]][] = [
      [
        "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d001', $1, $2, 'Forged', '+10000000099', 'AUNT')",
        [ORG_B, STUDENT_C],
      ],
      [
        "INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date) VALUES ('01939a00-0000-7000-8000-00000000d002', $1, $2, 'FORGED-1', '2024-07-01')",
        [ORG_B, STAFF_B],
      ],
      [
        "INSERT INTO app.users (id, organization_id, email, display_name) VALUES ('01939a00-0000-7000-8000-00000000d003', $1, 'forged@college-b.test', 'Forged')",
        [ORG_B],
      ],
    ];
    for (const [sql, p] of forged) {
      const r = await runAs(CTX.staffA, sql, p);
      expect(r.error?.code, sql).toBe('42501');
      expect(r.error?.message, sql).toMatch(/row-level security/);
    }
    // positive control: the same shape of insert for the caller's own tenant works
    const ok = await runAs(
      CTX.staffA,
      "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d004', $1, $2, 'Legit', '+10000000098', 'UNCLE')",
      [ORG_A, STUDENT_A],
    );
    expect(ok.error).toBeUndefined();
    expect(ok.rowCount).toBe(1);
  });

  it("a forged parent reference across tenants is rejected even inside the caller's own tenant", async () => {
    // organization_id = A (passes RLS) but student_id belongs to tenant B: the composite FK refuses it
    const r = await runAs(
      CTX.staffA,
      "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d005', $1, $2, 'X', '+10000000097', 'AUNT')",
      [ORG_A, STUDENT_C],
    );
    expect(r.error).toBeDefined();
    expect(['23503', '42501']).toContain(r.error?.code);
  });
});
