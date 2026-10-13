import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { DesignationService } from '../../src/modules/organization/designation.service.js';
import type { CreateDesignationBody } from '../../src/modules/organization/organization.schemas.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, ORG_A, type Ctx } from '../support/fixtures.js';

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

const status = (p: Promise<unknown>): Promise<number | undefined> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : undefined),
  );

const designation = (over: Partial<CreateDesignationBody> = {}): CreateDesignationBody => ({
  code: 'PROF',
  name: 'Professor',
  category: 'TEACHING',
  ...over,
});

describe('DesignationService.create', () => {
  it('creates an active designation and records an atomic audit event', async () => {
    let capturedId: string | undefined;
    await scratch(CTX.staffA, async (tx, ctx) => {
      capturedId = await DesignationService.create(tx, ctx, designation(), {
        ip: '10.0.0.1',
        userAgent: 'test-agent',
      });
      expect(typeof capturedId).toBe('string');

      const rows = await tx.query<{
        id: string;
        organization_id: string;
        code: string;
        name: string;
        category: string;
        status: string;
        version: number;
      }>('SELECT * FROM app.designations WHERE id = $1', [capturedId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        id: capturedId,
        organization_id: ORG_A,
        code: 'PROF',
        name: 'Professor',
        category: 'TEACHING',
        status: 'ACTIVE',
        version: 1,
      });
    });

    // After scratch rolls back, verify neither designation nor audit event committed
    const checkDesig = await adminQuery('SELECT 1 FROM app.designations WHERE id = $1', [
      capturedId,
    ]);
    expect(checkDesig).toHaveLength(0);
    const checkAudit = await adminQuery('SELECT 1 FROM app.audit_events WHERE resource_id = $1', [
      capturedId,
    ]);
    expect(checkAudit).toHaveLength(0);
  });

  it('rolls back the designation insert if the transaction fails', async () => {
    let capturedId: string | undefined;
    const ctx = ctxOf(CTX.staffA);
    await expect(
      db.withTenant(ctx, async (tx) => {
        capturedId = await DesignationService.create(tx, ctx, designation());
        throw new Error('Simulated failure after insert');
      }),
    ).rejects.toThrow('Simulated failure after insert');

    const check = await adminQuery('SELECT 1 FROM app.designations WHERE id = $1', [capturedId]);
    expect(check).toHaveLength(0);
  });

  it('rolls back the designation insert if audit event writing fails during creation', async () => {
    const ctx = ctxOf(CTX.staffA);
    const code = `AUD_FAIL_${Date.now().toString().slice(-6)}`;
    await expect(
      db.withTenant(ctx, async (tx) => {
        // Invalid audit IP causes recordAudit to throw AUDIT_INVALID (500)
        return DesignationService.create(tx, ctx, designation({ code }), {
          ip: 'invalid-ip-string',
        });
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUDIT_INVALID',
    });

    const check = await adminQuery('SELECT 1 FROM app.designations WHERE code = $1', [code]);
    expect(check).toHaveLength(0);
  });

  it('rejects duplicate code within the same tenant with 409 CONFLICT', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await DesignationService.create(tx, ctx, designation({ code: 'ASST_PROF' }));
      await expect(
        DesignationService.create(tx, ctx, designation({ code: 'ASST_PROF' })),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
    });
  });

  it('re-throws unrelated database errors without masking them as 409 CONFLICT', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const mockTx = {
        query: async (sql: string, params?: unknown[]) => {
          if (typeof sql === 'string' && sql.includes('INSERT INTO app.designations')) {
            const error = new Error('Database disk failure') as Error & { code: string };
            error.code = '57P01';
            throw error;
          }
          return tx.query(sql, params);
        },
      };

      await expect(
        DesignationService.create(mockTx as unknown as TenantTx, ctx, designation()),
      ).rejects.toMatchObject({
        code: '57P01',
      });
    });
  });

  it('allows the same code in different tenants', async () => {
    await scratch(CTX.staffA, async (txA, ctxA) => {
      const idA = await DesignationService.create(txA, ctxA, designation({ code: 'SHARED_CODE' }));
      expect(idA).toBeDefined();

      await scratch(CTX.staffB, async (txB, ctxB) => {
        const idB = await DesignationService.create(
          txB,
          ctxB,
          designation({ code: 'SHARED_CODE' }),
        );
        expect(idB).toBeDefined();
        expect(idA).not.toBe(idB);
      });
    });
  });

  describe('validation boundaries', () => {
    it.each([
      ['empty name', designation({ name: '' })],
      ['blank name', designation({ name: '   ' })],
      ['name too long', designation({ name: 'a'.repeat(256) })],
      ['empty code', designation({ code: '' })],
      ['code with spaces', designation({ code: 'PR OF' })],
      ['code with special chars', designation({ code: 'PROF@1' })],
      ['code starts with hyphen', designation({ code: '-PROF' })],
      ['code too long', designation({ code: 'a'.repeat(21) })],
      [
        'invalid category',
        {
          ...designation(),
          category: 'MANAGER' as unknown as CreateDesignationBody['category'],
        },
      ],
      [
        'empty category',
        { ...designation(), category: '' as unknown as CreateDesignationBody['category'] },
      ],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_name, payload) => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        await expect(DesignationService.create(tx, ctx, payload)).rejects.toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      });
    });
  });

  describe('authorization enforcement', () => {
    it('allows COLLEGE_ADMIN at ORGANIZATION scope', async () => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        expect(await status(DesignationService.create(tx, ctx, designation()))).toBe(200);
      });
    });

    it('rejects CAMPUS_ADMIN (scoped to campus) with 403 FORBIDDEN', async () => {
      await scratch(CTX.campusAdminA, async (tx, ctx) => {
        await expect(DesignationService.create(tx, ctx, designation())).rejects.toMatchObject({
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      });
    });

    it('rejects unprivileged FACULTY with 403 FORBIDDEN', async () => {
      await scratch(CTX.facultyA, async (tx, ctx) => {
        await expect(DesignationService.create(tx, ctx, designation())).rejects.toMatchObject({
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      });
    });

    it('rejects STUDENT with 403 FORBIDDEN', async () => {
      await scratch(CTX.studentA, async (tx, ctx) => {
        await expect(DesignationService.create(tx, ctx, designation())).rejects.toMatchObject({
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      });
    });

    it('rejects user without roles with 403 FORBIDDEN', async () => {
      await scratch(CTX.noroleA, async (tx, ctx) => {
        await expect(DesignationService.create(tx, ctx, designation())).rejects.toMatchObject({
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      });
    });

    it('rejects untrusted context with 500 UNTRUSTED_CONTEXT', async () => {
      await scratch(CTX.staffA, async (tx) => {
        await expect(
          DesignationService.create(tx, {} as unknown as TrustedContext, designation()),
        ).rejects.toMatchObject({
          statusCode: 500,
          code: 'UNTRUSTED_CONTEXT',
        });
      });
    });
  });
});

describe('DesignationService.list', () => {
  it('lists active designations for the caller tenant', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await DesignationService.create(
        tx,
        ctx,
        designation({ code: 'D1', name: 'Alpha', category: 'TEACHING' }),
      );
      await DesignationService.create(
        tx,
        ctx,
        designation({ code: 'D2', name: 'Beta', category: 'ADMIN' }),
      );

      const list = await DesignationService.list(tx, ctx);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((d) => d.code === 'D1')).toBe(true);
      expect(list.some((d) => d.code === 'D2')).toBe(true);
    });
  });

  it('filters by category', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await DesignationService.create(tx, ctx, designation({ code: 'T1', category: 'TEACHING' }));
      await DesignationService.create(
        tx,
        ctx,
        designation({ code: 'NT1', category: 'NON_TEACHING' }),
      );

      const teaching = await DesignationService.list(tx, ctx, { category: 'TEACHING' });
      expect(teaching.every((d) => d.category === 'TEACHING')).toBe(true);
      expect(teaching.some((d) => d.code === 'T1')).toBe(true);
      expect(teaching.some((d) => d.code === 'NT1')).toBe(false);

      const nonTeaching = await DesignationService.list(tx, ctx, { category: 'NON_TEACHING' });
      expect(nonTeaching.every((d) => d.category === 'NON_TEACHING')).toBe(true);
      expect(nonTeaching.some((d) => d.code === 'NT1')).toBe(true);
      expect(nonTeaching.some((d) => d.code === 'T1')).toBe(false);
    });
  });

  it('shields non-managers from INACTIVE designations even on explicit filter', async () => {
    await scratch(CTX.staffA, async (txA, ctxA) => {
      const id = await DesignationService.create(txA, ctxA, designation({ code: 'INACT1' }));
      // Set to INACTIVE via direct SQL update
      await txA.query("UPDATE app.designations SET status = 'INACTIVE' WHERE id = $1", [id]);

      // Manager can see inactive when filtering status=INACTIVE
      const managerList = await DesignationService.list(txA, ctxA, { status: 'INACTIVE' });
      expect(managerList.some((d) => d.id === id)).toBe(true);

      // Non-manager student requesting status=INACTIVE receives empty list immediately
      const studentCtx = ctxOf(CTX.studentA);
      const studentInactive = await DesignationService.list(txA, studentCtx, {
        status: 'INACTIVE',
      });
      expect(studentInactive).toEqual([]);

      // Non-manager student listing all active designations does not see INACTIVE designation
      const studentAll = await DesignationService.list(txA, studentCtx);
      expect(studentAll.some((d) => d.id === id)).toBe(false);
    });
  });

  it('enforces tenant isolation: tenant A cannot see tenant B designations', async () => {
    await scratch(CTX.staffA, async (txA, ctxA) => {
      const idA = await DesignationService.create(txA, ctxA, designation({ code: 'T_A_ONLY' }));

      await scratch(CTX.staffB, async (txB, ctxB) => {
        const listB = await DesignationService.list(txB, ctxB);
        expect(listB.some((d) => d.id === idA)).toBe(false);
        expect(listB.some((d) => d.code === 'T_A_ONLY')).toBe(false);
      });
    });
  });

  it('generates zero audit records on list queries', async () => {
    // Deterministic and independent of other test files: a tenant-wide ORG_A audit count is NOT usable here, because
    // other files (employee, organization-settings, ...) commit ORG_A audit events concurrently on this shared database
    // (the count moved 36 -> 39 in a failing run; the extra rows were organization.setting.update and employee.*).
    // A transaction that has written nothing has no transaction id assigned, so a list that recorded an audit event
    // (or wrote anything) would make pg_current_xact_id_if_assigned() non-NULL.
    await scratch(CTX.staffA, async (tx, ctx) => {
      await DesignationService.list(tx, ctx);
      const written = await tx.query<{ xid: string | null }>(
        'SELECT pg_current_xact_id_if_assigned()::text AS xid',
      );
      expect(written.rows).toEqual([{ xid: null }]);
    });
  });
});
