import { describe, expect, it } from 'vitest';
import {
  CTX,
  ORG_A,
  ORG_B,
  SOME_V4,
  STAFF_A,
  STAFF_B,
  STUDENT_A,
  UNKNOWN_V7,
  USER_A,
  USER_B,
} from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs, type RawCtx } from '../support/db-harness.js';

const READ_ALL = ['organizations', 'users', 'students', 'student_guardians'] as const;

async function expectNoAccess(ctx: RawCtx, label: string): Promise<void> {
  for (const t of READ_ALL) {
    const r = await runAs(ctx, `SELECT id FROM app.${t}`);
    expect(r.error, `${label}: select ${t}`).toBeUndefined();
    expect(r.rows, `${label}: select ${t} must return nothing`).toEqual([]);
  }
  const upd = await runAs(ctx, "UPDATE app.students SET status = 'SUSPENDED'");
  expect(upd.rowCount, `${label}: update`).toBe(0);
  const del = await runAs(ctx, 'DELETE FROM app.student_guardians');
  expect(del.rowCount, `${label}: delete`).toBe(0);
  const ins = await runAs(
    ctx,
    "INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation) VALUES ('01939a00-0000-7000-8000-00000000d301', $1, $2, 'X', '+10000000055', 'AUNT')",
    [ORG_A, STUDENT_A],
  );
  expect(ins.error?.code, `${label}: insert must be refused`).toBe('42501');
}

describe('precondition: "no access" cannot be explained by empty tables', () => {
  it('the data exists and a valid context sees it', async () => {
    expect((await adminQuery('SELECT 1 FROM app.students')).length).toBe(3);
    expect((await runAs(CTX.staffA, 'SELECT id FROM app.students')).rows.length).toBe(2);
  });
});

describe('Missing / invalid context fails closed — Invariant C', () => {
  it('[16] no tenant context => access denied (and NULL never means "all rows")', async () => {
    await expectNoAccess({}, 'no context at all');
    await expectNoAccess({ user: STAFF_A, kind: 'STAFF' }, 'user+kind but no tenant');
    await expectNoAccess({ tenant: null, user: STAFF_A, kind: 'STAFF' }, 'null tenant');
    await expectNoAccess({ tenant: '', user: STAFF_A, kind: 'STAFF' }, 'empty tenant');
  });

  it('[17] no authenticated user context => access denied', async () => {
    await expectNoAccess({ tenant: ORG_A }, 'tenant only');
    await expectNoAccess({ tenant: ORG_A, kind: 'STAFF' }, 'tenant+kind but no user');
    await expectNoAccess({ tenant: ORG_A, user: STAFF_A }, 'tenant+user but no actor kind');
    await expectNoAccess({ tenant: ORG_A, user: '', kind: 'STAFF' }, 'empty user');
  });

  const invalidTenants: [string, string][] = [
    ['random UUIDv4', SOME_V4],
    ['well-formed UUIDv7 that does not exist', UNKNOWN_V7],
    ['garbage', 'garbage'],
    ['SQL-ish', "' OR '1'='1"],
    ['all zeros', '00000000-0000-0000-0000-000000000000'],
    ['leading space', ` ${ORG_A}`],
    ['trailing space', `${ORG_A} `],
    ['two ids', `${ORG_A},${ORG_B}`],
    ['wildcard', '*'],
    ['the literal word null', 'null'],
    ['uuid without dashes', ORG_A.replace(/-/g, '')],
    ['braced uuid', `{${ORG_A}}`],
  ];
  it.each(invalidTenants)(
    '[18] invalid tenant context (%s) => access denied',
    async (_n, tenant) => {
      await expectNoAccess({ tenant, user: STAFF_A, kind: 'STAFF' }, `tenant=${tenant}`);
    },
  );

  const invalidUsers: [string, string][] = [
    ['random UUIDv4', SOME_V4],
    ['well-formed UUIDv7 that does not exist', UNKNOWN_V7],
    ['garbage', 'garbage'],
    ['a user from ANOTHER tenant', USER_B],
    ["another tenant's staff", STAFF_B],
    ['two ids', `${STAFF_A},${USER_A}`],
  ];
  it.each(invalidUsers)('[19] invalid user context (%s) => access denied', async (_n, user) => {
    await expectNoAccess({ tenant: ORG_A, user, kind: 'STAFF' }, `user=${user}`);
    await expectNoAccess({ tenant: ORG_A, user, kind: 'STUDENT' }, `user=${user} as student`);
  });

  const invalidKinds = [
    'ADMIN',
    'staff',
    'Student',
    'STAFF ',
    ' STAFF',
    'STAFF,STUDENT',
    'SYSTEM',
    'root',
    '',
  ];
  it.each(invalidKinds)('invalid actor kind %j => access denied', async (kind) => {
    await expectNoAccess({ tenant: ORG_A, user: STAFF_A, kind }, `kind=${JSON.stringify(kind)}`);
  });

  it('a user that was suspended loses access immediately, inside the same transaction', async () => {
    const r = await runStepsAs(CTX.staffA, [
      ["UPDATE app.users SET status = 'SUSPENDED' WHERE id = $1", [STAFF_A]],
      ['SELECT id FROM app.students'],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([]);
  });

  it('[20] Tenant A context + Tenant B identifiers => Tenant B data stays inaccessible', async () => {
    // tenant A context, but the caller is a Tenant B user
    await expectNoAccess(
      { tenant: ORG_A, user: USER_B, kind: 'STUDENT' },
      'A tenant + B student user',
    );
    await expectNoAccess(
      { tenant: ORG_A, user: STAFF_B, kind: 'STAFF' },
      'A tenant + B staff user',
    );
    // tenant B context, but the caller is a Tenant A user
    await expectNoAccess(
      { tenant: ORG_B, user: USER_A, kind: 'STUDENT' },
      'B tenant + A student user',
    );
    await expectNoAccess(
      { tenant: ORG_B, user: STAFF_A, kind: 'STAFF' },
      'B tenant + A staff user',
    );
    // valid tenant A context asking for B ids by every route
    const asks: [string, unknown[]][] = [
      ['SELECT id FROM app.students WHERE organization_id = $1', [ORG_B]],
      ['SELECT id FROM app.organizations WHERE id = $1', [ORG_B]],
      ['SELECT id FROM app.users WHERE organization_id = $1', [ORG_B]],
    ];
    for (const [sql, p] of asks) expect((await runAs(CTX.staffA, sql, p)).rows, sql).toEqual([]);
  });

  it('a differently-cased but identical tenant id is the same tenant, not a different one', async () => {
    const r = await runAs(
      { tenant: ORG_A.toUpperCase(), user: STAFF_A.toUpperCase(), kind: 'STAFF' },
      'SELECT organization_id FROM app.students',
    );
    expect(r.rows.length).toBe(2);
    expect(new Set(r.rows.map((x) => x['organization_id']))).toEqual(new Set([ORG_A]));
  });
});
