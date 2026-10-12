import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { MAX_PAGE_SIZE } from '../../src/modules/people/employee.schemas.js';
import type {
  CreateEmployeeBody,
  UpdateEmployeeBody,
} from '../../src/modules/people/employee.schemas.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import type { ExpectedVersion } from '../../src/shared/settings/index.js';
import { adminQuery } from '../support/db-harness.js';
import {
  CTX,
  GRANTEE_A,
  NOROLE_A,
  ORG_A,
  STAFF_B,
  TEMP_A,
  UNKNOWN_V7,
  USER_A,
  type Ctx,
} from '../support/fixtures.js';

// Service-level tests. Everything runs in a rolled-back transaction except the one audit test, which cleans up
// after itself. User ids used here (NOROLE_A, TEMP_A, GRANTEE_A) are not used by employee-routes.test.ts.
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

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

const statusOf = (p: Promise<unknown>): Promise<number | undefined> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : undefined),
  );

let seq = 0;
const uniq = (): string => `SV${(seq++).toString(36)}`;
const ANY: ExpectedVersion = { type: 'exists' };

const body = (userId: string, over: Partial<CreateEmployeeBody> = {}): CreateEmployeeBody => ({
  userId,
  employeeCode: uniq(),
  employeeType: 'FACULTY',
  joiningDate: '2024-06-01',
  reason: 'Initial onboarding',
  ...over,
});
const patch = (over: Partial<UpdateEmployeeBody>): UpdateEmployeeBody => ({
  reason: 'Routine correction',
  ...over,
});

describe('EmployeeService.create', () => {
  it('creates an ACTIVE record at version 1 with the supplied facts', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await EmployeeService.create(tx, ctx, body(NOROLE_A, { employeeCode: 'EMP-1' }));
      const rec = await EmployeeService.getById(tx, ctx, id);
      expect(rec).toMatchObject({
        id,
        organizationId: ORG_A,
        userId: NOROLE_A,
        employeeCode: 'EMP-1',
        employeeType: 'FACULTY',
        joiningDate: '2024-06-01',
        leavingDate: null,
        status: 'ACTIVE',
        version: 1,
      });
    });
  });

  it('commits the row and a risk-tier-2 audit event carrying the reason, and update audits the diff', async () => {
    const ctx = ctxOf(CTX.staffA);
    const code = uniq();
    let id = '';
    try {
      id = await db.withTenant(ctx, (tx) =>
        EmployeeService.create(
          tx,
          ctx,
          body(GRANTEE_A, { employeeCode: code, reason: 'Hired by committee' }),
          { ip: '10.0.0.7', userAgent: 'vitest' },
        ),
      );
      await db.withTenant(ctx, (tx) =>
        EmployeeService.update(tx, ctx, id, patch({ status: 'ON_LEAVE', reason: 'Sabbatical' }), {
          expected: { type: 'version', version: 1 },
        }),
      );
      await db.withTenant(ctx, (tx) =>
        EmployeeService.update(
          tx,
          ctx,
          id,
          patch({ leavingDate: '2025-06-30', reason: 'Notice served' }),
          { expected: ANY },
        ),
      );
      await db.withTenant(ctx, (tx) =>
        EmployeeService.update(
          tx,
          ctx,
          id,
          patch({ leavingDate: null, reason: 'Notice withdrawn' }),
          {
            expected: ANY,
          },
        ),
      );
      const audit = await adminQuery<{
        action: string;
        risk_tier: number;
        reason_text: string;
        actor_user_id: string;
        changes: Record<string, { old: unknown; new: unknown }>;
      }>(
        `SELECT action, risk_tier, reason_text, actor_user_id, changes FROM app.audit_events
          WHERE resource_id = $1 ORDER BY occurred_at, id`,
        [id],
      );
      expect(audit.map((a) => a.action)).toEqual([
        'employee.create',
        'employee.update',
        'employee.update',
        'employee.update',
      ]);
      expect(audit.every((a) => a.risk_tier === 2 && a.actor_user_id === CTX.staffA.user)).toBe(
        true,
      );
      expect(audit.map((a) => a.reason_text)).toEqual([
        'Hired by committee',
        'Sabbatical',
        'Notice served',
        'Notice withdrawn',
      ]);
      expect(audit[0]?.changes['employeeCode']).toEqual({ old: null, new: code });
      expect(audit[1]?.changes).toEqual({ status: { old: 'ACTIVE', new: 'ON_LEAVE' } });
      // leavingDate is audited like any other field, including being cleared with null
      expect(audit[2]?.changes).toEqual({ leavingDate: { old: null, new: '2025-06-30' } });
      expect(audit[3]?.changes).toEqual({ leavingDate: { old: '2025-06-30', new: null } });
    } finally {
      await adminQuery('DELETE FROM app.employees WHERE employee_code = $1', [code]);
    }
  });

  it('rolls the employee back when the audit write fails (atomicity)', async () => {
    const ctx = ctxOf(CTX.staffA);
    const code = uniq();
    await expect(
      db.withTenant(ctx, (tx) =>
        EmployeeService.create(tx, ctx, body(NOROLE_A, { employeeCode: code }), {
          ip: 'not-an-ip',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 500, code: 'AUDIT_INVALID' });
    expect(
      await adminQuery('SELECT 1 FROM app.employees WHERE employee_code = $1', [code]),
    ).toEqual([]);
  });

  it('rejects a duplicate employee code (409) and a second record for the same account (409)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await EmployeeService.create(tx, ctx, body(NOROLE_A, { employeeCode: 'DUPCODE' }));
      await expect(
        EmployeeService.create(tx, ctx, body(TEMP_A, { employeeCode: 'DUPCODE' })),
      ).rejects.toMatchObject({ statusCode: 409, message: /code already exists/ });
    });
    await scratch(CTX.staffA, async (tx, ctx) => {
      await EmployeeService.create(tx, ctx, body(NOROLE_A));
      await expect(EmployeeService.create(tx, ctx, body(NOROLE_A))).rejects.toMatchObject({
        statusCode: 409,
        message: /account already has an employee record/,
      });
    });
  });

  it('allows the same employee code in different tenants', async () => {
    await scratch(CTX.staffA, async (txA, ctxA) => {
      await EmployeeService.create(txA, ctxA, body(NOROLE_A, { employeeCode: 'SHARED' }));
      await scratch(CTX.staffB, async (txB, ctxB) => {
        expect(
          await statusOf(
            EmployeeService.create(txB, ctxB, body(STAFF_B, { employeeCode: 'SHARED' })),
          ),
        ).toBe(200);
      });
    });
  });

  describe('relationship checks', () => {
    it('404 for a user that does not exist', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await expect(EmployeeService.create(tx, ctx, body(UNKNOWN_V7))).rejects.toMatchObject({
          statusCode: 404,
        });
      });
    });

    it("404 for another tenant's user (indistinguishable from a missing one)", async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await expect(EmployeeService.create(tx, ctx, body(STAFF_B))).rejects.toMatchObject({
          statusCode: 404,
          code: 'RESOURCE_NOT_FOUND',
        });
      });
    });

    it('409 for an account that already has a student record', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await expect(EmployeeService.create(tx, ctx, body(USER_A))).rejects.toMatchObject({
          statusCode: 409,
          message: /student record/,
        });
      });
    });

    it('409 for a deactivated account', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await tx.query("UPDATE app.users SET status = 'DEACTIVATED' WHERE id = $1", [TEMP_A]);
        await expect(EmployeeService.create(tx, ctx, body(TEMP_A))).rejects.toMatchObject({
          statusCode: 409,
          message: /deactivated/,
        });
      });
    });
  });

  describe('validation (400, before any database access)', () => {
    it.each([
      ['non-UUIDv7 userId', { userId: '3b241101-e2bb-4255-8caf-4136c566a962' }],
      ['empty code', { employeeCode: '' }],
      ['code with a space', { employeeCode: 'E 1' }],
      ['code starting with a hyphen', { employeeCode: '-E1' }],
      ['code of 51 characters', { employeeCode: 'a'.repeat(51) }],
      ['unknown type', { employeeType: 'DEAN' as never }],
      ['non-date', { joiningDate: 'tomorrow' }],
      ['impossible date', { joiningDate: '2024-02-30' }],
      ['month 13', { joiningDate: '2024-13-01' }],
      ['year before 1900', { joiningDate: '1899-12-31' }],
      ['reason too short', { reason: 'abcd' }],
      ['blank reason', { reason: '      ' }],
    ])('rejects %s', async (_n, over) => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await expect(
          EmployeeService.create(tx, ctx, body(NOROLE_A, over as Partial<CreateEmployeeBody>)),
        ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      });
    });
  });

  describe('authorization', () => {
    it('COLLEGE_ADMIN (organization scope) may create', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        expect(await statusOf(EmployeeService.create(tx, ctx, body(NOROLE_A)))).toBe(200);
      });
    });

    it.each([
      ['CAMPUS_ADMIN (holds the permission but only at campus scope)', CTX.campusAdminA],
      ['HOD (no create permission)', CTX.hodA],
      ['FACULTY', CTX.facultyA],
      ['STUDENT', CTX.studentA],
      ['user without roles', CTX.noroleA],
    ])('403 for %s', async (_n, actor) => {
      await scratch(CTX.staffA, async (tx) => {
        // The authorization decision is made for `actor`; it is refused before anything is written.
        expect(await statusOf(EmployeeService.create(tx, ctxOf(actor), body(TEMP_A)))).toBe(403);
      });
    });

    it('500 for an untrusted context', async () => {
      await scratch(CTX.staffA, async (tx) => {
        await expect(
          EmployeeService.create(tx, {} as unknown as TrustedContext, body(NOROLE_A)),
        ).rejects.toMatchObject({ statusCode: 500, code: 'UNTRUSTED_CONTEXT' });
      });
    });
  });
});

describe('EmployeeService.getById / list', () => {
  it('reads by id and 404s for an unknown id; 400 for a malformed id', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await expect(EmployeeService.getById(tx, ctx, UNKNOWN_V7)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(EmployeeService.getById(tx, ctx, 'nope')).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  it('hides an existing record from holders whose scope cannot contain it (404), and denies non-holders (403)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await EmployeeService.create(tx, ctx, body(NOROLE_A));
      // CAMPUS_ADMIN and HOD hold employee.profile.read, but only at CAMPUS / DEPARTMENT scope: an employee has
      // no campus/department until postings exist (M2), so containment can never be proven (fail closed).
      expect(await statusOf(EmployeeService.getById(tx, ctxOf(CTX.campusAdminA), id))).toBe(404);
      expect(await statusOf(EmployeeService.getById(tx, ctxOf(CTX.hodA), id))).toBe(404);
      expect(await statusOf(EmployeeService.getById(tx, ctxOf(CTX.studentA), id))).toBe(403);
      expect(await statusOf(EmployeeService.getById(tx, ctxOf(CTX.noroleA), id))).toBe(403);
      // FACULTY holds the permission in SELF mode only and this record is not theirs.
      expect(await statusOf(EmployeeService.getById(tx, ctxOf(CTX.facultyA), id))).toBe(404);
    });
  });

  it('lists with filters; scoped-only holders get an empty list; non-holders 403', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const a = await EmployeeService.create(tx, ctx, body(NOROLE_A, { employeeType: 'STAFF' }));
      await EmployeeService.create(tx, ctx, body(TEMP_A, { employeeType: 'VISITING' }));
      await EmployeeService.update(tx, ctx, a, patch({ status: 'ON_LEAVE' }), { expected: ANY });

      const staff = await EmployeeService.list(tx, ctx, { employeeType: 'STAFF' });
      expect(staff.map((e) => e.id)).toContain(a);
      expect(staff.every((e) => e.employeeType === 'STAFF')).toBe(true);

      const onLeave = await EmployeeService.list(tx, ctx, { status: 'ON_LEAVE' });
      expect(onLeave.some((e) => e.id === a)).toBe(true);
      expect(onLeave.every((e) => e.status === 'ON_LEAVE')).toBe(true);

      expect(await EmployeeService.list(tx, ctxOf(CTX.campusAdminA))).toEqual([]);
      expect(await EmployeeService.list(tx, ctxOf(CTX.hodA))).toEqual([]);
      expect(await statusOf(EmployeeService.list(tx, ctxOf(CTX.studentA)))).toBe(403);
      expect(await statusOf(EmployeeService.list(tx, ctxOf(CTX.noroleA)))).toBe(403);
    });
  });

  it('enforces the page-size cap in the service as well as the schema (security_artitecture.md: max page size)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await statusOf(EmployeeService.list(tx, ctx, { limit: MAX_PAGE_SIZE }))).toBe(200);
      for (const filter of [
        { limit: MAX_PAGE_SIZE + 1 },
        { limit: 0 },
        { limit: 1.5 },
        { offset: -1 },
      ]) {
        await expect(
          EmployeeService.list(tx, ctx, filter),
          JSON.stringify(filter),
        ).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      expect((await EmployeeService.list(tx, ctx)).length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    });
  });

  it('paginates deterministically by employee code', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await EmployeeService.create(tx, ctx, body(NOROLE_A, { employeeCode: 'PG-1' }));
      await EmployeeService.create(tx, ctx, body(TEMP_A, { employeeCode: 'PG-2' }));
      const all = (await EmployeeService.list(tx, ctx)).map((e) => e.employeeCode);
      expect(all).toEqual([...all].sort());
      const p0 = await EmployeeService.list(tx, ctx, { limit: 1, offset: 0 });
      const p1 = await EmployeeService.list(tx, ctx, { limit: 1, offset: 1 });
      expect(p0).toHaveLength(1);
      expect(p1).toHaveLength(1);
      expect(p0[0]?.id).not.toBe(p1[0]?.id);
    });
  });
});

describe('EmployeeService.update', () => {
  const make = async (tx: TenantTx, ctx: TrustedContext, over = {}): Promise<string> =>
    EmployeeService.create(tx, ctx, body(NOROLE_A, over));

  it('changes facts, bumps the version and returns the new record', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx);
      const rec = await EmployeeService.update(
        tx,
        ctx,
        id,
        patch({ employeeType: 'ADMIN', joiningDate: '2023-01-15' }),
        { expected: { type: 'version', version: 1 } },
      );
      expect(rec).toMatchObject({ employeeType: 'ADMIN', joiningDate: '2023-01-15', version: 2 });
    });
  });

  // 01 §3.4 lists leaving_date as OPTIONAL and specifies no coupling with status; transitions are unrestricted.
  it('status and leavingDate are independent: neither implies, requires, nor alters the other', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx);
      // SEPARATED without a date is accepted (no rule says otherwise)
      const gone = await EmployeeService.update(tx, ctx, id, patch({ status: 'SEPARATED' }), {
        expected: ANY,
      });
      expect(gone).toMatchObject({ status: 'SEPARATED', leavingDate: null });
      // a date can be recorded while the status stays as it is
      const dated = await EmployeeService.update(
        tx,
        ctx,
        id,
        patch({ leavingDate: '2025-03-31' }),
        {
          expected: ANY,
        },
      );
      expect(dated).toMatchObject({ status: 'SEPARATED', leavingDate: '2025-03-31' });
      // changing status never touches the date: reinstatement keeps whatever was recorded
      const back = await EmployeeService.update(tx, ctx, id, patch({ status: 'ACTIVE' }), {
        expected: ANY,
      });
      expect(back).toMatchObject({ status: 'ACTIVE', leavingDate: '2025-03-31' });
      // and an ACTIVE employee may carry a leaving date (e.g. a recorded notice period); null clears it
      const cleared = await EmployeeService.update(tx, ctx, id, patch({ leavingDate: null }), {
        expected: ANY,
      });
      expect(cleared).toMatchObject({ status: 'ACTIVE', leavingDate: null });
      // direct ACTIVE -> SEPARATED -> ON_LEAVE: no transition is forbidden
      await EmployeeService.update(tx, ctx, id, patch({ status: 'SEPARATED' }), { expected: ANY });
      const leave = await EmployeeService.update(tx, ctx, id, patch({ status: 'ON_LEAVE' }), {
        expected: ANY,
      });
      expect(leave.status).toBe('ON_LEAVE');
    });
  });

  it('a leavingDate change bumps the version; repeating the same date is a no-op', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx);
      const set = await EmployeeService.update(tx, ctx, id, patch({ leavingDate: '2025-01-01' }), {
        expected: ANY,
      });
      expect(set.version).toBe(2);
      const noop = await EmployeeService.update(tx, ctx, id, patch({ leavingDate: '2025-01-01' }), {
        expected: ANY,
      });
      expect(noop.version).toBe(2); // same date again is a no-op
    });
  });

  it('rejects only what is explicitly justified: malformed dates, leaving before joining, nothing to change (400)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx, { joiningDate: '2024-06-01' });
      await EmployeeService.update(tx, ctx, id, patch({ leavingDate: '2025-01-01' }), {
        expected: ANY,
      });
      const bad: UpdateEmployeeBody[] = [
        patch({ leavingDate: '2024-05-31' }), // before joining
        patch({ joiningDate: '2025-01-02' }), // moves joining after the recorded leaving date
        patch({ joiningDate: '2024-02-30' }), // not a date
        patch({ leavingDate: '2025-13-01' }), // not a date
        patch({}), // nothing to change
      ];
      for (const b of bad) {
        await expect(
          EmployeeService.update(tx, ctx, id, b, { expected: ANY }),
          JSON.stringify(b),
        ).rejects.toMatchObject({ statusCode: 400 });
      }
      // same-day join and leave is allowed (>=)
      const same = await EmployeeService.update(tx, ctx, id, patch({ leavingDate: '2024-06-01' }), {
        expected: ANY,
      });
      expect(same.leavingDate).toBe('2024-06-01');
    });
  });

  it('is a no-op (no version bump) when nothing changes', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx, { employeeType: 'STAFF' });
      const rec = await EmployeeService.update(tx, ctx, id, patch({ employeeType: 'STAFF' }), {
        expected: ANY,
      });
      expect(rec.version).toBe(1);
    });
  });

  it('enforces If-Match: a stale or "initial" expectation is a 409 and changes nothing', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx);
      await EmployeeService.update(tx, ctx, id, patch({ status: 'ON_LEAVE' }), { expected: ANY });
      for (const expected of [
        { type: 'version', version: 1 },
        { type: 'initial' },
      ] as ExpectedVersion[]) {
        await expect(
          EmployeeService.update(tx, ctx, id, patch({ status: 'ACTIVE' }), { expected }),
        ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      }
      expect((await EmployeeService.getById(tx, ctx, id)).status).toBe('ON_LEAVE');
    });
  });

  it('authorization: 404 for unknown id and out-of-scope holders, 403 for non-holders', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await make(tx, ctx);
      await expect(
        EmployeeService.update(tx, ctx, UNKNOWN_V7, patch({ status: 'ON_LEAVE' }), {
          expected: ANY,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const attempt = (actor: Ctx): Promise<number | undefined> =>
        statusOf(
          EmployeeService.update(tx, ctxOf(actor), id, patch({ status: 'ON_LEAVE' }), {
            expected: ANY,
          }),
        );
      expect(await attempt(CTX.campusAdminA)).toBe(404);
      expect(await attempt(CTX.hodA)).toBe(403);
      expect(await attempt(CTX.facultyA)).toBe(403);
      expect(await attempt(CTX.studentA)).toBe(403);
      expect((await EmployeeService.getById(tx, ctx, id)).status).toBe('ACTIVE');
    });
  });
});
