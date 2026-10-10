import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  DepartmentService,
  type DepartmentInput,
} from '../../src/modules/organization/department.service.js';
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
  DEPT_1,
  DEPT_2,
  DEPT_3,
  DEPT_B1,
  ORG_A,
  ORG_C,
  UNKNOWN_V7,
  type Ctx,
} from '../support/fixtures.js';

const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 6 });
const db = new Database(pool);
afterAll(async () => {
  await db.close();
});

const gateOf = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

/** Polls pg_stat_activity until a backend is waiting on a lock in a statement matching `like`. */
async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}

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

const dept = (over: Partial<DepartmentInput> = {}): DepartmentInput => ({
  campusId: CAMPUS_1,
  name: 'Computer Science',
  code: 'CS_DEPT',
  kind: 'ACADEMIC',
  ...over,
});

describe('DepartmentService.create: input validation and defaults', () => {
  it('creates an academic department with default kind ACADEMIC when omitted', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await DepartmentService.create(tx, ctx, {
        campusId: CAMPUS_1,
        name: 'Mathematics',
        code: 'MATH',
      });
      const row = (
        await tx.query<{
          name: string;
          code: string;
          kind: string;
          status: string;
          organization_id: string;
          campus_id: string;
          parent_department_id: string | null;
        }>(
          'SELECT name, code, kind, status, organization_id, campus_id, parent_department_id FROM app.departments WHERE id = $1',
          [id],
        )
      ).rows[0];
      expect(row).toEqual({
        name: 'Mathematics',
        code: 'MATH',
        kind: 'ACADEMIC',
        status: 'ACTIVE',
        organization_id: ctx.tenantId,
        campus_id: CAMPUS_1,
        parent_department_id: null,
      });
    });
  });

  it.each(['ACADEMIC', 'ADMINISTRATIVE', 'SERVICE'] as const)(
    'accepts and stores kind %s',
    async (kind) => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        const id = await DepartmentService.create(
          tx,
          ctx,
          dept({ code: `KIND_${kind.slice(0, 4)}`, kind }),
        );
        const row = (
          await tx.query<{ kind: string }>('SELECT kind FROM app.departments WHERE id = $1', [id])
        ).rows[0];
        expect(row?.kind).toBe(kind);
      });
    },
  );

  it('rejects invalid names, codes, kinds, and campus IDs with 400', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      for (const over of [
        { name: '' },
        { name: '   ' },
        { name: 'x'.repeat(256) },
        { code: '' },
        { code: 'x'.repeat(21) },
        { code: 'bad code' },
        { code: "bad'code" },
        { kind: 'INVALID' as unknown as DepartmentInput['kind'] },
        { campusId: 'not-a-uuid' },
        { campusId: '3b241101-e2bb-4255-8caf-4136c566a962' }, // v4 UUID
        { parentDepartmentId: 'not-a-uuid' },
      ]) {
        expect(
          await status(DepartmentService.create(tx, ctx, dept(over as Partial<DepartmentInput>))),
          JSON.stringify(over),
        ).toBe(400);
      }
    });
  });
});

describe('DepartmentService.create: hierarchy, locking, and uniqueness', () => {
  it('creates a child department under an active parent in the same campus', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const parentId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'ENG_FAC', name: 'Engineering Faculty' }),
      );
      const childId = await DepartmentService.create(
        tx,
        ctx,
        dept({
          code: 'MECH_ENG',
          name: 'Mechanical Engineering',
          parentDepartmentId: parentId,
        }),
      );
      const child = (
        await tx.query<{ parent_department_id: string; campus_id: string }>(
          'SELECT parent_department_id, campus_id FROM app.departments WHERE id = $1',
          [childId],
        )
      ).rows[0];
      expect(child).toEqual({
        parent_department_id: parentId,
        campus_id: CAMPUS_1,
      });
    });
  });

  it('rejects a non-existent campus with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(DepartmentService.create(tx, ctx, dept({ campusId: UNKNOWN_V7 })))).toBe(
        404,
      );
    });
  });

  it('tenant isolation: rejects a campus belonging to another tenant with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      // CAMPUS_B1 belongs to ORG_B
      expect(await status(DepartmentService.create(tx, ctx, dept({ campusId: CAMPUS_B1 })))).toBe(
        404,
      );
    });
  });

  it('rejects an inactive campus with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await tx.query(`UPDATE app.campuses SET status = 'INACTIVE' WHERE id = $1`, [CAMPUS_1]);
      expect(await status(DepartmentService.create(tx, ctx, dept({ campusId: CAMPUS_1 })))).toBe(
        404,
      );
    });
  });

  it('rejects a non-existent parent department with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(
        await status(DepartmentService.create(tx, ctx, dept({ parentDepartmentId: UNKNOWN_V7 }))),
      ).toBe(404);
    });
  });

  it('rejects a parent department belonging to a DIFFERENT campus with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      // DEPT_1 is in CAMPUS_1. Creating under CAMPUS_2 with DEPT_1 as parent must fail.
      expect(
        await status(
          DepartmentService.create(
            tx,
            ctx,
            dept({ campusId: CAMPUS_2, parentDepartmentId: DEPT_1 }),
          ),
        ),
      ).toBe(404);
    });
  });

  it('tenant isolation: rejects a parent department belonging to another tenant with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      // DEPT_B1 belongs to ORG_B
      expect(
        await status(DepartmentService.create(tx, ctx, dept({ parentDepartmentId: DEPT_B1 }))),
      ).toBe(404);
    });
  });

  it('rejects an inactive or soft-deleted parent department with 404', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const parentId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'PAR_INACT', name: 'Parent' }),
      );
      await tx.query(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [parentId]);
      expect(
        await status(
          DepartmentService.create(
            tx,
            ctx,
            dept({ code: 'CHILD_1', parentDepartmentId: parentId }),
          ),
        ),
      ).toBe(404);

      await tx.query(
        `UPDATE app.departments SET status = 'ACTIVE', deleted_at = now() WHERE id = $1`,
        [parentId],
      );
      expect(
        await status(
          DepartmentService.create(
            tx,
            ctx,
            dept({ code: 'CHILD_2', parentDepartmentId: parentId }),
          ),
        ),
      ).toBe(404);
    });
  });

  it('duplicate code in the same campus is a 409 conflict', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await DepartmentService.create(tx, ctx, dept({ code: 'DUPE_CODE' }));
      expect(await status(DepartmentService.create(tx, ctx, dept({ code: 'DUPE_CODE' })))).toBe(
        409,
      );
    });
  });

  it('same code in a DIFFERENT campus of the same organization is allowed', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id1 = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: CAMPUS_1, code: 'SHARED_CODE' }),
      );
      const id2 = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: CAMPUS_2, code: 'SHARED_CODE' }),
      );
      expect(id1).not.toEqual(id2);
    });
  });

  it('creates multi-level hierarchy (root -> child -> grandchild) with immutable parent invariant', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const rootId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'DIV_SCI', name: 'Division of Sciences' }),
      );
      const deptId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'DEPT_CS', name: 'Computer Science Dept', parentDepartmentId: rootId }),
      );
      const labId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'LAB_AI', name: 'AI Research Lab', parentDepartmentId: deptId }),
      );

      const root = await DepartmentService.getById(tx, ctx, rootId);
      const mid = await DepartmentService.getById(tx, ctx, deptId);
      const leaf = await DepartmentService.getById(tx, ctx, labId);

      expect(root.parentDepartmentId).toBeNull();
      expect(mid.parentDepartmentId).toBe(rootId);
      expect(leaf.parentDepartmentId).toBe(deptId);

      // Cycles are structurally impossible:
      // Re-parenting any existing department (e.g. root pointing to leaf) is rejected because parent_department_id is immutable.
      await expect(
        tx.query('UPDATE app.departments SET parent_department_id = $1 WHERE id = $2', [
          labId,
          rootId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('DepartmentService: scoped authorization', () => {
  it('COLLEGE_ADMIN (organization scope) can manage departments across all campuses', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id1 = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: CAMPUS_1, code: 'ORG_ADMIN_C1' }),
      );
      const id2 = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: CAMPUS_2, code: 'ORG_ADMIN_C2' }),
      );
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) can manage departments in CAMPUS_1', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const id = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: CAMPUS_1, code: 'CAMPUS1_ADMIN' }),
      );
      expect(id).toBeDefined();
    });
  });

  it('CAMPUS_ADMIN (scoped to CAMPUS_1) CANNOT manage departments in CAMPUS_2 (404 out of scope)', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      expect(
        await status(
          DepartmentService.create(tx, ctx, dept({ campusId: CAMPUS_2, code: 'OUT_OF_SCOPE' })),
        ),
      ).toBe(404);
    });
  });

  it('unprivileged roles receive 403 FORBIDDEN when attempting to manage departments', async () => {
    for (const actor of [CTX.facultyA, CTX.hodA, CTX.studentA, CTX.noroleA]) {
      await scratch(actor, async (tx, ctx) => {
        expect(await status(DepartmentService.create(tx, ctx, dept())), actor.user).toBe(403);
      });
    }
  });
});

describe('DepartmentService.getById: self-authorizing (direct calls, no route)', () => {
  const errOf = async (p: Promise<unknown>): Promise<AppError> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof AppError) return e;
      throw e;
    }
    throw new Error('expected an AppError');
  };

  it('organization-scoped admin reads departments in every campus', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect((await DepartmentService.getById(tx, ctx, DEPT_1)).campusId).toBe(CAMPUS_1);
      expect((await DepartmentService.getById(tx, ctx, DEPT_3)).campusId).toBe(CAMPUS_2);
    });
  });

  it('campus admin reads a department in the own campus', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      expect((await DepartmentService.getById(tx, ctx, DEPT_1)).id).toBe(DEPT_1);
    });
  });

  it('callers without read or manage permission receive 403, before any lookup', async () => {
    await scratch(CTX.noroleA, async (tx, ctx) => {
      expect(await status(DepartmentService.getById(tx, ctx, DEPT_1)), CTX.noroleA.user).toBe(403);
      // Same answer for an unknown id: a caller without permission cannot probe for existence.
      expect(await status(DepartmentService.getById(tx, ctx, UNKNOWN_V7)), CTX.noroleA.user).toBe(
        403,
      );
    });
  });

  it('STUDENT and FACULTY (organization-scoped) can read departments across campuses', async () => {
    for (const actor of [CTX.studentA, CTX.facultyA]) {
      await scratch(actor, async (tx, ctx) => {
        expect((await DepartmentService.getById(tx, ctx, DEPT_1)).campusId).toBe(CAMPUS_1);
        expect((await DepartmentService.getById(tx, ctx, DEPT_3)).campusId).toBe(CAMPUS_2);
      });
    }
  });

  it('HOD (department-scoped to DEPT_1) can read DEPT_1, but gets 404 for DEPT_2 and DEPT_3', async () => {
    await scratch(CTX.hodA, async (tx, ctx) => {
      expect((await DepartmentService.getById(tx, ctx, DEPT_1)).id).toBe(DEPT_1);
      const outOfScopeSameCampus = await errOf(DepartmentService.getById(tx, ctx, DEPT_2));
      const outOfScopeDiffCampus = await errOf(DepartmentService.getById(tx, ctx, DEPT_3));
      const unknown = await errOf(DepartmentService.getById(tx, ctx, UNKNOWN_V7));
      expect(outOfScopeSameCampus.statusCode).toBe(404);
      expect(outOfScopeSameCampus.code).toBe(unknown.code);
      expect(outOfScopeSameCampus.message).toBe(unknown.message);
      expect(outOfScopeDiffCampus.statusCode).toBe(404);
      expect(outOfScopeDiffCampus.code).toBe(unknown.code);
      expect(outOfScopeDiffCampus.message).toBe(unknown.message);
    });
  });

  it('inactive or soft-deleted department returns 404 to non-managers but is readable by managers', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const did = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'INACT_DEPT', name: 'Inactive Dept' }),
      );
      await DepartmentService.update(tx, ctx, did, { status: 'INACTIVE' });

      // Manager reads inactive department: 200
      expect((await DepartmentService.getById(tx, ctx, did)).status).toBe('INACTIVE');

      // Non-manager student gets 404
      const studentCtx = ctxOf(CTX.studentA);
      expect(await status(DepartmentService.getById(tx, studentCtx, did))).toBe(404);

      // Now soft-delete
      await DepartmentService.softDelete(tx, ctx, did);

      // Manager reads soft-deleted department: 200
      const managerRead = await DepartmentService.getById(tx, ctx, did);
      expect(managerRead.status).toBe('INACTIVE');
      expect(managerRead.deletedAt).not.toBeNull();

      // Non-manager student still gets 404
      expect(await status(DepartmentService.getById(tx, studentCtx, did))).toBe(404);
    });
  });

  it('campus admin cannot read a department of another campus: 404, identical to an unknown id', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const outOfScope = await errOf(DepartmentService.getById(tx, ctx, DEPT_3));
      const unknown = await errOf(DepartmentService.getById(tx, ctx, UNKNOWN_V7));
      expect(outOfScope.statusCode).toBe(404);
      expect(outOfScope.code).toBe(unknown.code);
      expect(outOfScope.message).toBe(unknown.message);
    });
  });

  it('cross-tenant read is 404 and indistinguishable from an unknown id', async () => {
    await scratch(CTX.staffB, async (tx, ctx) => {
      const foreign = await errOf(DepartmentService.getById(tx, ctx, DEPT_1));
      const unknown = await errOf(DepartmentService.getById(tx, ctx, UNKNOWN_V7));
      expect(foreign.statusCode).toBe(404);
      expect(foreign.code).toBe(unknown.code);
      expect(foreign.message).toBe(unknown.message);
      // and the other tenant's own department is still readable by its own admin
      expect((await DepartmentService.getById(tx, ctx, DEPT_B1)).id).toBe(DEPT_B1);
    });
  });

  it('rejects a malformed id with 400 and an untrusted context with 500', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      expect(await status(DepartmentService.getById(tx, ctx, 'nope'))).toBe(400);
      expect(await status(DepartmentService.getById(tx, { ...ctx }, DEPT_1))).toBe(500);
    });
  });
});

describe('DepartmentService.list: scoping, filters, and inactive shielding', () => {
  it('STUDENT receives all active, non-deleted departments in their tenant', async () => {
    await scratch(CTX.studentA, async (tx, ctx) => {
      const list = await DepartmentService.list(tx, ctx);
      expect(list.some((d) => d.id === DEPT_1)).toBe(true);
      expect(list.some((d) => d.id === DEPT_3)).toBe(true);
      expect(list.every((d) => d.organizationId === ORG_A)).toBe(true);
      expect(list.every((d) => d.status === 'ACTIVE')).toBe(true);
      expect(list.every((d) => d.deletedAt === null)).toBe(true);
    });
  });

  it('CAMPUS_ADMIN receives only departments in their assigned campus', async () => {
    await scratch(CTX.campusAdminA, async (tx, ctx) => {
      const list = await DepartmentService.list(tx, ctx);
      expect(list.every((d) => d.campusId === CAMPUS_1)).toBe(true);
      expect(list.some((d) => d.id === DEPT_1)).toBe(true);
      expect(list.some((d) => d.id === DEPT_3)).toBe(false);
    });
  });

  it('HOD receives only their assigned department', async () => {
    await scratch(CTX.hodA, async (tx, ctx) => {
      const list = await DepartmentService.list(tx, ctx);
      expect(list.map((d) => d.id)).toEqual([DEPT_1]);
    });
  });

  it('filters by kind and campusId correctly', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const academicList = await DepartmentService.list(tx, ctx, { kind: 'ACADEMIC' });
      expect(academicList.every((d) => d.kind === 'ACADEMIC')).toBe(true);

      const campus1List = await DepartmentService.list(tx, ctx, { campusId: CAMPUS_1 });
      expect(campus1List.every((d) => d.campusId === CAMPUS_1)).toBe(true);
    });
  });

  it('non-managers never see inactive or soft-deleted departments even when explicitly filtering status=INACTIVE', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const did = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'INACT_D_L', name: 'Inactive For List' }),
      );
      await DepartmentService.update(tx, ctx, did, { status: 'INACTIVE' });

      // Manager can see inactive department when requesting status=INACTIVE
      const managerList = await DepartmentService.list(tx, ctx, { status: 'INACTIVE' });
      expect(managerList.some((d) => d.id === did)).toBe(true);

      // Student receives empty array when filtering status=INACTIVE
      const studentCtx = ctxOf(CTX.studentA);
      const studentInactiveList = await DepartmentService.list(tx, studentCtx, {
        status: 'INACTIVE',
      });
      expect(studentInactiveList).toEqual([]);

      // Student default list excludes inactive department
      const studentDefaultList = await DepartmentService.list(tx, studentCtx);
      expect(studentDefaultList.some((d) => d.id === did)).toBe(false);
    });
  });

  it('caller without permission receives 403 FORBIDDEN on list', async () => {
    await scratch(CTX.noroleA, async (tx, ctx) => {
      expect(await status(DepartmentService.list(tx, ctx))).toBe(403);
    });
  });
});

describe('DepartmentService.update and softDelete', () => {
  it('updates department name and records audit event', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'UPDATE_NAME', name: 'Old Name' }),
      );
      await DepartmentService.update(tx, ctx, id, { name: 'New Name' });
      const record = await DepartmentService.getById(tx, ctx, id);
      expect(record.name).toBe('New Name');
      expect(record.status).toBe('ACTIVE');
    });
  });

  it('deactivates a department when it has no active children', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'DEACT_OK', name: 'To Deactivate' }),
      );
      await DepartmentService.update(tx, ctx, id, { status: 'INACTIVE' });
      const record = await DepartmentService.getById(tx, ctx, id);
      expect(record.status).toBe('INACTIVE');
    });
  });

  it('rejects deactivating a department that has active child departments with 409 conflict', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const parentId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'PAR_ACTIVE', name: 'Parent Active' }),
      );
      await DepartmentService.create(
        tx,
        ctx,
        dept({
          code: 'CHILD_ACTIVE',
          name: 'Child Active',
          parentDepartmentId: parentId,
        }),
      );
      expect(
        await status(DepartmentService.update(tx, ctx, parentId, { status: 'INACTIVE' })),
      ).toBe(409);
    });
  });

  it('soft-deletes a department and prevents operations on soft-deleted departments', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'SOFT_DEL', name: 'To Delete' }),
      );
      await DepartmentService.softDelete(tx, ctx, id);

      // soft-deleted record is marked deleted_at and INACTIVE
      const record = await DepartmentService.getById(tx, ctx, id);
      expect(record.status).toBe('INACTIVE');
      expect(record.deletedAt).not.toBeNull();

      // update on soft-deleted department returns 404
      expect(await status(DepartmentService.update(tx, ctx, id, { name: 'Renamed' }))).toBe(404);

      // softDelete again returns 404
      expect(await status(DepartmentService.softDelete(tx, ctx, id))).toBe(404);

      // after soft-delete, re-creating the same code in the campus succeeds!
      const newId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'SOFT_DEL', name: 'Recreated' }),
      );
      expect(newId).not.toEqual(id);
    });
  });

  it('rejects soft-deleting a department that has non-deleted child departments with 409 conflict', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const parentId = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'PAR_DEL_TEST', name: 'Parent Del' }),
      );
      const childId = await DepartmentService.create(
        tx,
        ctx,
        dept({
          code: 'CHILD_DEL_TEST',
          name: 'Child Del',
          parentDepartmentId: parentId,
        }),
      );
      expect(await status(DepartmentService.softDelete(tx, ctx, parentId))).toBe(409);

      // Deleting child first allows deleting parent
      await DepartmentService.softDelete(tx, ctx, childId);
      expect(await status(DepartmentService.softDelete(tx, ctx, parentId))).toBe(200);
    });
  });

  it('no-op update with identical name and status does not change version or write audit event', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const id = await DepartmentService.create(
        tx,
        ctx,
        dept({ code: 'NOOP_TEST', name: 'Initial Name' }),
      );
      const before = await DepartmentService.getById(tx, ctx, id);

      // No-op update with exact same name
      await DepartmentService.update(tx, ctx, id, { name: 'Initial Name' });
      const afterName = await DepartmentService.getById(tx, ctx, id);
      expect(afterName.version).toBe(before.version);
      expect(afterName.updatedAt).toEqual(before.updatedAt);

      // No-op update with exact same status
      await DepartmentService.update(tx, ctx, id, { status: 'ACTIVE' });
      const afterStatus = await DepartmentService.getById(tx, ctx, id);
      expect(afterStatus.version).toBe(before.version);
      expect(afterStatus.updatedAt).toEqual(before.updatedAt);

      // No-op update with both identical
      await DepartmentService.update(tx, ctx, id, { name: 'Initial Name', status: 'ACTIVE' });
      const afterBoth = await DepartmentService.getById(tx, ctx, id);
      expect(afterBoth.version).toBe(before.version);
      expect(afterBoth.updatedAt).toEqual(before.updatedAt);
    });
  });
});

describe('DepartmentService: transaction atomicity and immutable columns', () => {
  it('commits department and audit event together in the caller’s tenant', async () => {
    const ctx = ctxOf(CTX.staffC);
    let newCampusId!: string;
    let deptId!: string;

    await db.withTenant(ctx, async (tx) => {
      // Create campus in Tenant C first
      const cid = '01939a00-0000-7000-8000-00000000cc01';
      await tx.query(
        `INSERT INTO app.campuses (id, organization_id, name, code, timezone)
         VALUES ($1, $2, 'Tenant C Campus', 'C_CAMPUS', 'UTC')`,
        [cid, ORG_C],
      );
      newCampusId = cid;
      deptId = await DepartmentService.create(
        tx,
        ctx,
        dept({ campusId: cid, code: 'AUDIT_DEPT', name: 'Audit Dept' }),
      );
    });

    try {
      const rows = await adminQuery<{
        organization_id: string;
        campus_id: string;
        name: string;
      }>('SELECT organization_id, campus_id, name FROM app.departments WHERE id = $1', [deptId]);
      expect(rows).toEqual([
        {
          organization_id: ORG_C,
          campus_id: newCampusId,
          name: 'Audit Dept',
        },
      ]);

      const audit = await adminQuery<{
        action: string;
        campus_id: string;
        department_id: string;
        risk_tier: number;
      }>(
        'SELECT action, campus_id, department_id, risk_tier FROM app.audit_events WHERE resource_id = $1',
        [deptId],
      );
      expect(audit).toEqual([
        {
          action: 'department.create',
          campus_id: newCampusId,
          department_id: deptId,
          risk_tier: 1,
        },
      ]);
    } finally {
      await adminQuery('DELETE FROM app.departments WHERE id = $1', [deptId]);
      await adminQuery('DELETE FROM app.campuses WHERE id = $1', [newCampusId]);
    }
  });

  it.each(['id', 'organization_id', 'campus_id', 'parent_department_id', 'code', 'kind'])(
    'runtime role cannot update immutable column %s',
    async (col) => {
      await scratch(CTX.staffA, async (tx, ctx) => {
        const id = await DepartmentService.create(
          tx,
          ctx,
          dept({ code: `FIX_${col.slice(0, 4).toUpperCase()}` }),
        );
        await expect(
          tx.query(`UPDATE app.departments SET ${col} = ${col} WHERE id = $1`, [id]),
        ).rejects.toMatchObject({ code: '42501' });
      });
    },
  );
});

describe('DepartmentService concurrency: deterministic parent-child race conditions', () => {
  const PARENT_CONC = '01939a00-0000-7000-8000-00000000cc10';
  const CHILD_CONC = '01939a00-0000-7000-8000-00000000cc11';

  afterAll(async () => {
    await adminQuery('DELETE FROM app.departments WHERE id = ANY($1::uuid[])', [
      [CHILD_CONC, PARENT_CONC],
    ]);
  });

  it('child creation locks parent FOR SHARE first; concurrent parent deactivation waits, then fails with 409', async () => {
    // Setup dedicated parent department
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code, status)
       VALUES ($1, $2, $3, 'Conc Parent A', 'CP_A', 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', deleted_at = NULL`,
      [PARENT_CONC, ORG_A, CAMPUS_1],
    );
    // Cleanup any lingering child
    await adminQuery('DELETE FROM app.departments WHERE id = $1', [CHILD_CONC]);

    const ctx = ctxOf(CTX.staffA);
    const childCreated = gateOf();
    const releaseChild = gateOf();

    // Transaction 1: Creates child department under parent, holds lock before commit
    const childTx = db.withTenant(ctx, async (tx) => {
      await DepartmentService.create(tx, ctx, {
        campusId: CAMPUS_1,
        name: 'Conc Child A',
        code: 'CC_A',
        parentDepartmentId: PARENT_CONC,
      });
      childCreated.open();
      await releaseChild.wait;
    });

    await childCreated.wait;

    // Transaction 2: Concurrently attempts to deactivate parent
    const deactTx = db.withTenant(ctx, async (tx) => {
      await DepartmentService.update(tx, ctx, PARENT_CONC, { status: 'INACTIVE' });
    });

    // Transaction 2 blocks on parent lock (FOR NO KEY UPDATE conflicts with Tx 1's FOR SHARE)
    await waitUntilBlocked('%FOR NO KEY UPDATE%');

    // Release Tx 1 to commit the child creation
    releaseChild.open();
    await childTx;

    // Tx 2 unblocks, re-evaluates active children under READ COMMITTED, and is rejected with 409 CONFLICT
    expect(await status(deactTx)).toBe(409);

    // Cleanup
    await adminQuery('DELETE FROM app.departments WHERE organization_id = $1 AND code = $2', [
      ORG_A,
      'CC_A',
    ]);
    await adminQuery('DELETE FROM app.departments WHERE id = $1', [PARENT_CONC]);
  });

  it('parent deactivation locks parent first; concurrent child creation waits, then fails with 404', async () => {
    // Setup dedicated parent department
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code, status)
       VALUES ($1, $2, $3, 'Conc Parent B', 'CP_B', 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', deleted_at = NULL`,
      [PARENT_CONC, ORG_A, CAMPUS_1],
    );

    const ctx = ctxOf(CTX.staffA);
    const parentDeactivated = gateOf();
    const releaseParent = gateOf();

    // Transaction 1: Locks campus and parent, deactivates parent, holds lock before commit
    const deactTx = db.withTenant(ctx, async (tx) => {
      await tx.query(`SELECT 1 FROM app.campuses WHERE id = $1 FOR SHARE`, [CAMPUS_1]);
      await tx.query(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [PARENT_CONC]);
      parentDeactivated.open();
      await releaseParent.wait;
    });

    await parentDeactivated.wait;

    // Transaction 2: Concurrently attempts to create child under parent
    const childTx = db.withTenant(ctx, async (tx) => {
      await DepartmentService.create(tx, ctx, {
        campusId: CAMPUS_1,
        name: 'Conc Child B',
        code: 'CC_B',
        parentDepartmentId: PARENT_CONC,
      });
    });

    // Transaction 2 blocks on parent lock (FOR SHARE conflicts with Tx 1's UPDATE lock)
    await waitUntilBlocked('%FOR SHARE%');

    // Release Tx 1 to commit the deactivation
    releaseParent.open();
    await deactTx;

    // Tx 2 unblocks, re-evaluates parent WHERE status = 'ACTIVE', finds 0 rows, and is rejected with 404
    expect(await status(childTx)).toBe(404);

    // Cleanup
    await adminQuery('DELETE FROM app.departments WHERE id = $1', [PARENT_CONC]);
  });

  it('parent soft-delete locks parent first; concurrent child creation waits, then fails with 404', async () => {
    // Setup dedicated parent department
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code, status)
       VALUES ($1, $2, $3, 'Conc Parent C', 'CP_C', 'ACTIVE')
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', deleted_at = NULL`,
      [PARENT_CONC, ORG_A, CAMPUS_1],
    );

    const ctx = ctxOf(CTX.staffA);
    const parentDeleted = gateOf();
    const releaseParent = gateOf();

    // Transaction 1: Soft-deletes parent, holds lock before commit
    const deleteTx = db.withTenant(ctx, async (tx) => {
      await DepartmentService.softDelete(tx, ctx, PARENT_CONC);
      parentDeleted.open();
      await releaseParent.wait;
    });

    await parentDeleted.wait;

    // Transaction 2: Concurrently attempts to create child under parent
    const childTx = db.withTenant(ctx, async (tx) => {
      await DepartmentService.create(tx, ctx, {
        campusId: CAMPUS_1,
        name: 'Conc Child C',
        code: 'CC_C',
        parentDepartmentId: PARENT_CONC,
      });
    });

    // Transaction 2 blocks on parent lock
    await waitUntilBlocked('%FOR SHARE%');

    // Release Tx 1 to commit the soft delete
    releaseParent.open();
    await deleteTx;

    // Tx 2 unblocks, re-evaluates parent WHERE deleted_at IS NULL, finds 0 rows, and fails with 404
    expect(await status(childTx)).toBe(404);

    // Cleanup
    await adminQuery('DELETE FROM app.departments WHERE id = $1', [PARENT_CONC]);
  });
});
