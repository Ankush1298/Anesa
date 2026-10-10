import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  CampusService,
  type CampusInput,
  type UpdateCampusInput,
} from '../../src/modules/organization/campus.service.js';
import { DepartmentService } from '../../src/modules/organization/department.service.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import {
  CAMPUS_1,
  CAMPUS_2,
  CAMPUS_B1,
  CTX,
  ORG_A,
  ORG_C,
  SOME_V4,
  UNKNOWN_V7,
  type Ctx,
} from '../support/fixtures.js';

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

describe('CampusService.getById: valid reads, scoping, isolation, and error handling', () => {
  it('reads existing campus by ID within tenant and returns complete record shape', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const res = await CampusService.getById(tx, ctx, CAMPUS_1);
      expect(res).toMatchObject({
        id: CAMPUS_1,
        organizationId: ORG_A,
        name: 'Campus 1',
        code: 'C1',
        timezone: 'Asia/Kolkata',
        status: 'ACTIVE',
        version: 1,
      });
      expect(new Date(res.createdAt).getTime()).not.toBeNaN();
      expect(new Date(res.updatedAt).getTime()).not.toBeNaN();
      expect(typeof res.address).toBe('object');
    });
  });

  it('rejects invalid campus IDs with 400', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      for (const badId of ['not-a-uuid', SOME_V4, '', '12345']) {
        expect(await status(CampusService.getById(tx, ctx, badId)), badId).toBe(400);
      }
    });
  });

  it('returns 404 for unknown campus ID (UUIDv7 that does not exist)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(CampusService.getById(tx, ctx, UNKNOWN_V7))).toBe(404);
    });
  });

  it('COLLEGE_ADMIN (ORG_A) can read any campus in the organization', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const c1 = await CampusService.getById(tx, ctx, CAMPUS_1);
      const c2 = await CampusService.getById(tx, ctx, CAMPUS_2);
      expect(c1.id).toBe(CAMPUS_1);
      expect(c2.id).toBe(CAMPUS_2);
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) can read CAMPUS_1', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const c1 = await CampusService.getById(tx, ctx, CAMPUS_1);
      expect(c1.id).toBe(CAMPUS_1);
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) receives 404 when attempting to read CAMPUS_2 (scope isolation)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      expect(await status(CampusService.getById(tx, ctx, CAMPUS_2))).toBe(404);
    });
  });

  it('tenant isolation: tenant A cannot read tenant B campus, and tenant B cannot read tenant A campus (404)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(CampusService.getById(tx, ctx, CAMPUS_B1))).toBe(404);
    });
    await scratch(CTX.staffB, async (tx, ctx) => {
      expect(await status(CampusService.getById(tx, ctx, CAMPUS_1))).toBe(404);
    });
  });

  it('callers without permission receive 403 FORBIDDEN when attempting to read a campus', async () => {
    await scratch(CTX.noroleA, async (tx, ctx) => {
      expect(await status(CampusService.getById(tx, ctx, CAMPUS_1))).toBe(403);
      expect(await status(CampusService.getById(tx, ctx, UNKNOWN_V7))).toBe(403);
    });
  });

  it('STUDENT and FACULTY (organization-scoped) can read both CAMPUS_1 and CAMPUS_2', async () => {
    for (const actor of [CTX.studentA, CTX.facultyA]) {
      await scratch(actor, async (tx, ctx) => {
        expect((await CampusService.getById(tx, ctx, CAMPUS_1)).id).toBe(CAMPUS_1);
        expect((await CampusService.getById(tx, ctx, CAMPUS_2)).id).toBe(CAMPUS_2);
      });
    }
  });

  it('HOD (department-scoped to DEPT_1 on CAMPUS_1) can read CAMPUS_1 (parent campus) but gets 404 on CAMPUS_2', async () => {
    await scratch(CTX.hodA, async (tx, ctx) => {
      expect((await CampusService.getById(tx, ctx, CAMPUS_1)).id).toBe(CAMPUS_1);
      expect(await status(CampusService.getById(tx, ctx, CAMPUS_2))).toBe(404);
    });
  });

  it('inactive campus returns 404 to non-managers (studentA) but is readable by managers (staffA)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const cid = await CampusService.create(
        tx,
        ctx,
        campus({ code: 'INACT_CAMP', name: 'Inactive Campus' }),
      );
      await CampusService.update(tx, ctx, cid, { status: 'INACTIVE' });

      // Manager reads inactive campus: 200
      expect((await CampusService.getById(tx, ctx, cid)).status).toBe('INACTIVE');

      // Non-manager student gets 404 (indistinguishable from nonexistent)
      const studentCtx = ctxOf(CTX.studentA);
      expect(await status(CampusService.getById(tx, studentCtx, cid))).toBe(404);
    });
  });
});

describe('CampusService.list: scoping, filters, and inactive shielding', () => {
  it('STUDENT receives all active campuses in their tenant', async () => {
    await scratch(CTX.studentA, async (tx, ctx) => {
      const list = await CampusService.list(tx, ctx);
      expect(list.some((c) => c.id === CAMPUS_1)).toBe(true);
      expect(list.some((c) => c.id === CAMPUS_2)).toBe(true);
      expect(list.every((c) => c.organizationId === ORG_A)).toBe(true);
    });
  });

  it('CAMPUS_ADMIN receives only their assigned campus', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const list = await CampusService.list(tx, ctx);
      expect(list.map((c) => c.id)).toEqual([CAMPUS_1]);
    });
  });

  it('HOD receives only the parent campus of their assigned department', async () => {
    await scratch(CTX.hodA, async (tx, ctx) => {
      const list = await CampusService.list(tx, ctx);
      expect(list.map((c) => c.id)).toEqual([CAMPUS_1]);
    });
  });

  it('non-managers never see inactive campuses even when explicitly filtering status=INACTIVE', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const cid = await CampusService.create(
        tx,
        ctx,
        campus({ code: 'INACT_L', name: 'Inactive For List' }),
      );
      await CampusService.update(tx, ctx, cid, { status: 'INACTIVE' });

      // Manager can see inactive campus when requesting status=INACTIVE
      const managerList = await CampusService.list(tx, ctx, { status: 'INACTIVE' });
      expect(managerList.some((c) => c.id === cid)).toBe(true);

      // Student receives empty array when filtering status=INACTIVE
      const studentCtx = ctxOf(CTX.studentA);
      const studentInactiveList = await CampusService.list(tx, studentCtx, { status: 'INACTIVE' });
      expect(studentInactiveList).toEqual([]);

      // Student default list excludes inactive campus
      const studentDefaultList = await CampusService.list(tx, studentCtx);
      expect(studentDefaultList.some((c) => c.id === cid)).toBe(false);
    });
  });

  it('caller without permission receives 403 FORBIDDEN on list', async () => {
    await scratch(CTX.noroleA, async (tx, ctx) => {
      expect(await status(CampusService.list(tx, ctx))).toBe(403);
    });
  });
});

describe('CampusService.update: mutable fields, locking, conflict, no-op, and audit', () => {
  it('updates name, address, and status for an existing campus', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await CampusService.create(
        tx,
        ctx,
        campus({ code: 'UPD_BASIC', name: 'Initial Name' }),
      );
      const before = await CampusService.getById(tx, ctx, id);

      await CampusService.update(tx, ctx, id, {
        name: 'Updated Name',
        address: { city: 'Bengaluru', postalCode: '560001' },
      });

      const after = await CampusService.getById(tx, ctx, id);
      expect(after.name).toBe('Updated Name');
      expect(after.address).toEqual({ city: 'Bengaluru', postalCode: '560001' });
      expect(after.version).toBe(before.version + 1);
    });
  });

  it('rejects invalid inputs with 400', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await CampusService.create(tx, ctx, campus({ code: 'UPD_VAL' }));

      // Invalid campus IDs
      expect(await status(CampusService.update(tx, ctx, 'not-a-uuid', { name: 'Valid' }))).toBe(
        400,
      );
      expect(await status(CampusService.update(tx, ctx, SOME_V4, { name: 'Valid' }))).toBe(400);

      // Empty or non-object input
      expect(await status(CampusService.update(tx, ctx, id, {}))).toBe(400);
      expect(
        await status(CampusService.update(tx, ctx, id, null as unknown as UpdateCampusInput)),
      ).toBe(400);

      // Invalid name
      expect(await status(CampusService.update(tx, ctx, id, { name: '' }))).toBe(400);
      expect(await status(CampusService.update(tx, ctx, id, { name: '   ' }))).toBe(400);
      expect(await status(CampusService.update(tx, ctx, id, { name: 'x'.repeat(256) }))).toBe(400);

      // Invalid address
      expect(
        await status(
          CampusService.update(tx, ctx, id, { address: [] as unknown as Record<string, unknown> }),
        ),
      ).toBe(400);
      expect(
        await status(CampusService.update(tx, ctx, id, { address: { big: 'x'.repeat(5000) } })),
      ).toBe(400);

      // Invalid status
      expect(
        await status(
          CampusService.update(tx, ctx, id, { status: 'DELETED' as unknown as 'ACTIVE' }),
        ),
      ).toBe(400);
      expect(
        await status(
          CampusService.update(tx, ctx, id, { status: 'UNKNOWN' as unknown as 'ACTIVE' }),
        ),
      ).toBe(400);
    });
  });

  it('returns 404 for unknown campus ID', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(CampusService.update(tx, ctx, UNKNOWN_V7, { name: 'New Name' }))).toBe(
        404,
      );
    });
  });

  it('COLLEGE_ADMIN (ORG_A) can update any campus in the organization', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await CampusService.update(tx, ctx, CAMPUS_1, { name: 'Campus 1 Renamed' });
      await CampusService.update(tx, ctx, CAMPUS_2, { name: 'Campus 2 Renamed' });
      expect((await CampusService.getById(tx, ctx, CAMPUS_1)).name).toBe('Campus 1 Renamed');
      expect((await CampusService.getById(tx, ctx, CAMPUS_2)).name).toBe('Campus 2 Renamed');
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) can update CAMPUS_1', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      await CampusService.update(tx, ctx, CAMPUS_1, { name: 'Campus 1 Admin Update' });
      expect((await CampusService.getById(tx, ctx, CAMPUS_1)).name).toBe('Campus 1 Admin Update');
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) receives 404 when attempting to update CAMPUS_2 (scope isolation)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      expect(await status(CampusService.update(tx, ctx, CAMPUS_2, { name: 'Should Fail' }))).toBe(
        404,
      );
    });
  });

  it('tenant isolation: STAFF_A cannot update tenant B campus (404)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(CampusService.update(tx, ctx, CAMPUS_B1, { name: 'Cross Tenant' }))).toBe(
        404,
      );
    });
  });

  it('unprivileged roles receive 403 FORBIDDEN when attempting to update a campus', async () => {
    for (const actor of [CTX.studentA, CTX.facultyA, CTX.hodA, CTX.noroleA]) {
      await scratch(actor, async (tx, ctx) => {
        expect(
          await status(CampusService.update(tx, ctx, CAMPUS_1, { name: 'Hack' })),
          actor.user,
        ).toBe(403);
      });
    }
  });

  it('rejects deactivating a campus that has active child departments with 409 conflict', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      // CAMPUS_1 already has active DEPT_1 and DEPT_2
      expect(await status(CampusService.update(tx, ctx, CAMPUS_1, { status: 'INACTIVE' }))).toBe(
        409,
      );
    });
  });

  it('deactivation succeeds when all child departments are inactive or soft-deleted', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const cid = await CampusService.create(
        tx,
        ctx,
        campus({ code: 'DEACT_OK', name: 'To Deactivate' }),
      );
      const did = await DepartmentService.create(tx, ctx, {
        campusId: cid,
        name: 'Temporary Department',
        code: 'TEMP_DEPT',
      });

      // While department is active, campus deactivation is rejected
      expect(await status(CampusService.update(tx, ctx, cid, { status: 'INACTIVE' }))).toBe(409);

      // Soft-delete the department
      await DepartmentService.softDelete(tx, ctx, did);

      // Now campus deactivation succeeds
      await CampusService.update(tx, ctx, cid, { status: 'INACTIVE' });
      const rec = await CampusService.getById(tx, ctx, cid);
      expect(rec.status).toBe('INACTIVE');
    });
  });

  it('no-op update with identical name, address, and status does not change version, updated_at, or write audit event', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const cid = await CampusService.create(
        tx,
        ctx,
        campus({
          code: 'NOOP_C',
          name: 'Noop Campus',
          address: { city: 'Mumbai' },
        }),
      );
      const before = await CampusService.getById(tx, ctx, cid);

      // No-op update with identical name
      await CampusService.update(tx, ctx, cid, { name: 'Noop Campus' });
      const afterName = await CampusService.getById(tx, ctx, cid);
      expect(afterName.version).toBe(before.version);
      expect(afterName.updatedAt).toEqual(before.updatedAt);

      // No-op update with identical address
      await CampusService.update(tx, ctx, cid, { address: { city: 'Mumbai' } });
      const afterAddr = await CampusService.getById(tx, ctx, cid);
      expect(afterAddr.version).toBe(before.version);
      expect(afterAddr.updatedAt).toEqual(before.updatedAt);

      // No-op update with identical status
      await CampusService.update(tx, ctx, cid, { status: 'ACTIVE' });
      const afterStatus = await CampusService.getById(tx, ctx, cid);
      expect(afterStatus.version).toBe(before.version);
      expect(afterStatus.updatedAt).toEqual(before.updatedAt);

      // No-op update with all identical fields
      await CampusService.update(tx, ctx, cid, {
        name: 'Noop Campus',
        address: { city: 'Mumbai' },
        status: 'ACTIVE',
      });
      const afterAllFields = await CampusService.getById(tx, ctx, cid);
      expect(afterAllFields.version).toBe(before.version);
      expect(afterAllFields.updatedAt).toEqual(before.updatedAt);
    });
  });

  it('records audit event atomically on update and rolls back on failure', async () => {
    const ctx = ctxOf(CTX.staffC);
    let campusId!: string;

    await db.withTenant(ctx, async (tx) => {
      campusId = await CampusService.create(
        tx,
        ctx,
        campus({ code: 'AUD_C1', name: 'Original Name' }),
      );
    });

    try {
      // Perform committed update with metadata
      await db.withTenant(ctx, async (tx) => {
        await CampusService.update(
          tx,
          ctx,
          campusId,
          { name: 'Audited Renamed Campus', address: { city: 'Delhi' }, status: 'INACTIVE' },
          { ip: '192.168.1.100', userAgent: 'test-agent/1.0', requestId: SOME_V4 },
        );
      });

      const auditRows = await adminQuery<{
        action: string;
        campus_id: string;
        risk_tier: number;
        ip: string;
        user_agent: string;
        request_id: string;
        changes: Record<string, { old: unknown; new: unknown }>;
      }>(
        `SELECT action, campus_id, risk_tier, ip, user_agent, request_id, changes
           FROM app.audit_events
          WHERE resource_id = $1 AND action = 'campus.update'`,
        [campusId],
      );

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: 'campus.update',
        campus_id: campusId,
        risk_tier: 1,
        ip: '192.168.1.100',
        user_agent: 'test-agent/1.0',
        request_id: SOME_V4,
      });
      expect(auditRows[0]?.changes).toEqual({
        name: { old: 'Original Name', new: 'Audited Renamed Campus' },
        address: { old: {}, new: { city: 'Delhi' } },
        status: { old: 'ACTIVE', new: 'INACTIVE' },
      });

      // Rollback atomicity test: update followed by abort
      await db
        .withTenant(ctx, async (tx) => {
          await CampusService.update(tx, ctx, campusId, { name: 'Rolled Back Name' });
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });

      // Verify name was NOT changed in DB and no new audit event was added
      const current = (
        await adminQuery<{ name: string }>('SELECT name FROM app.campuses WHERE id = $1', [
          campusId,
        ])
      )[0];
      expect(current?.name).toBe('Audited Renamed Campus');

      const auditCountAfterRollback = await adminQuery<{ count: string }>(
        `SELECT count(*) FROM app.audit_events WHERE resource_id = $1 AND action = 'campus.update'`,
        [campusId],
      );
      expect(auditCountAfterRollback[0]?.count).toBe('1');
    } finally {
      // Clean up Tenant C campus write (audit events are append-only)
      await adminQuery('DELETE FROM app.campuses WHERE id = $1', [campusId]);
    }
  });
});
