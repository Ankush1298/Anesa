import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { CampusService, type CampusInput } from '../../src/modules/organization/campus.service.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, ORG_C, type Ctx } from '../support/fixtures.js';

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

class Rollback extends Error {}
const ctxOf = (a: Ctx): TrustedContext =>
  issueTrustedContext({ tenantId: a.tenant, userId: a.user, actorKind: a.kind });
/** Runs `fn` in a tenant transaction that is ALWAYS rolled back. */
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
const campus = (over: Partial<CampusInput> = {}): CampusInput => ({
  name: 'North Campus',
  code: 'NORTH',
  timezone: 'Asia/Kolkata',
  ...over,
});

describe('CampusService.create: timezone is validated against the server tz database', () => {
  it('the server lists the zones the policy relies on, and also lists names the policy must still refuse', async () => {
    const names = (
      await adminQuery<{ name: string }>(
        `SELECT name FROM pg_timezone_names WHERE name IN ('UTC', 'Asia/Kolkata', 'EST', 'EST5EDT', 'Etc/UTC', 'Etc/GMT+5')`,
      )
    ).map((r) => r.name);
    // Evidence that membership alone is NOT enough: the database would accept these, the policy does not.
    expect(names.sort()).toEqual(
      ['EST', 'EST5EDT', 'Etc/GMT+5', 'Etc/UTC', 'UTC', 'Asia/Kolkata'].sort(),
    );
  });

  it.each(['UTC', 'Asia/Kolkata', 'Europe/London', 'America/Argentina/Buenos_Aires'])(
    'accepts %s and stores it exactly',
    async (timezone) => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        const id = await CampusService.create(tx, ctx, campus({ timezone }));
        const row = (
          await tx.query<{ timezone: string; organization_id: string; status: string }>(
            'SELECT timezone, organization_id, status FROM app.campuses WHERE id = $1',
            [id],
          )
        ).rows[0];
        expect(row).toEqual({ timezone, organization_id: ctx.tenantId, status: 'ACTIVE' });
      });
    },
  );

  it.each([
    'IST',
    'PST',
    'EST',
    'EST5EDT',
    'GMT',
    'Factory',
    'UTC+5',
    'GMT+5:30',
    'Etc/GMT+5',
    'Etc/UTC',
    'posix/Asia/Kolkata',
    'right/UTC',
    'asia/kolkata',
    'utc',
    'Asia/Nowhere', // right shape, not in the tz database
    'Mars/Olympus_Mons',
    ' Asia/Kolkata',
    '',
    "Asia/Kolkata'; DROP TABLE app.campuses;--",
    'Asia/' + 'A'.repeat(60),
  ])('rejects %j with a 400 and writes nothing', async (timezone) => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(CampusService.create(tx, ctx, campus({ timezone })))).toBe(400);
      const n = await tx.query('SELECT 1 FROM app.campuses WHERE code = $1', ['NORTH']);
      expect(n.rowCount).toBe(0);
    });
  });

  it('there is no default: a missing or non-string timezone is a 400', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      for (const timezone of [undefined, null, 5, {}, ['UTC']]) {
        const input = { ...campus(), timezone } as unknown as CampusInput;
        expect(
          await status(CampusService.create(tx, ctx, input)),
          JSON.stringify(timezone) ?? 'undefined',
        ).toBe(400);
      }
      const noTz = { name: 'X', code: 'X1' } as unknown as CampusInput;
      expect(await status(CampusService.create(tx, ctx, noTz))).toBe(400);
    });
  });
});

describe('CampusService.create: other validation, authorization, audit', () => {
  it('validates name, code and address', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      for (const over of [
        { name: '' },
        { name: 'x'.repeat(256) },
        { code: '' },
        { code: 'x'.repeat(21) },
        { code: 'bad code' },
        { code: "a'b" },
        { address: [] as unknown as Record<string, unknown> },
        { address: { a: 'x'.repeat(5000) } },
      ]) {
        expect(
          await status(CampusService.create(tx, ctx, campus(over))),
          JSON.stringify(over).slice(0, 40),
        ).toBe(400);
      }
    });
  });

  it('a duplicate code in the same organization is a 409', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await CampusService.create(tx, ctx, campus({ code: 'DUPE' }));
      expect(await status(CampusService.create(tx, ctx, campus({ code: 'DUPE' })))).toBe(409);
    });
  });

  it('only an organization-wide holder of org.campus.manage may create; everyone else gets 403', async () => {
    for (const actor of [CTX.campusAdminA, CTX.facultyA, CTX.hodA, CTX.studentA, CTX.noroleA]) {
      await scratch(actor, async (tx, ctx) => {
        expect(await status(CampusService.create(tx, ctx, campus())), actor.user).toBe(403);
      });
    }
  });

  it('commits the campus and its audit event together, in the caller’s tenant only', async () => {
    const ctx = ctxOf(CTX.staffC);
    const id = await db.withTenant(ctx, (tx) =>
      CampusService.create(tx, ctx, campus({ code: 'AUDIT1' })),
    );
    const rows = await adminQuery<{ organization_id: string; timezone: string }>(
      'SELECT organization_id, timezone FROM app.campuses WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ organization_id: ORG_C, timezone: 'Asia/Kolkata' }]);
    const audit = await adminQuery<{ action: string; campus_id: string; risk_tier: number }>(
      `SELECT action, campus_id, risk_tier FROM app.audit_events WHERE resource_id = $1`,
      [id],
    );
    expect(audit).toEqual([{ action: 'campus.create', campus_id: id, risk_tier: 1 }]);
  });

  it.each(['timezone', 'code'])('after creation the runtime role cannot change %s', async (col) => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await CampusService.create(tx, ctx, campus({ code: 'FIXED' }));
      await expect(
        tx.query(`UPDATE app.campuses SET ${col} = ${col} WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
