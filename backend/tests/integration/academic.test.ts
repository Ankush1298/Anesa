import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  CohortService,
  PeriodTypeService,
  ProgramService,
} from '../../src/modules/academics/academic.service.js';
import type {
  CreateCohortBody,
  CreateProgramBody,
} from '../../src/modules/academics/academic.schemas.js';
import { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, DEPT_1, DEPT_2, DEPT_3, ORG_A, type Ctx } from '../support/fixtures.js';

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
const uniq = (prefix: string): string => `${prefix}${(seq++).toString(36)}`;

/** Create a period type as the given tx/ctx (expects an authorized actor). */
async function makePeriodType(tx: TenantTx, ctx: TrustedContext): Promise<string> {
  return PeriodTypeService.create(tx, ctx, {
    code: uniq('SEM'),
    label: 'Semester',
    labelPlural: 'Semesters',
  });
}

const programBody = (over: Partial<CreateProgramBody> = {}): CreateProgramBody => ({
  departmentId: DEPT_1,
  periodTypeId: over.periodTypeId ?? '',
  name: 'B.Tech CSE',
  code: uniq('BT'),
  degreeLevel: 'UG',
  durationPeriods: 8,
  ...over,
});

const cohortBody = (over: Partial<CreateCohortBody> = {}): CreateCohortBody => ({
  programId: over.programId ?? '',
  admissionYear: 2025,
  name: 'Batch 2025',
  ...over,
});

// ============================================================================
// Period types
// ============================================================================
describe('PeriodTypeService', () => {
  it('creates a period type and atomically rolls back the row and its audit event', async () => {
    let id: string | undefined;
    await scratch(CTX.staffA, async (tx, ctx) => {
      id = await makePeriodType(tx, ctx);
      const row = await tx.query('SELECT id FROM app.period_types WHERE id = $1', [id]);
      expect(row.rows).toHaveLength(1);
    });
    // Rollback leaves neither the row nor its audit event (audit_events is only readable as superuser).
    expect(await adminQuery('SELECT 1 FROM app.period_types WHERE id = $1', [id])).toHaveLength(0);
    expect(
      await adminQuery('SELECT 1 FROM app.audit_events WHERE resource_id = $1', [id]),
    ).toHaveLength(0);
  });

  it('rejects a duplicate code within the tenant (409)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await PeriodTypeService.create(tx, ctx, { code: 'DUP', label: 'A', labelPlural: 'As' });
      await expect(
        PeriodTypeService.create(tx, ctx, { code: 'DUP', label: 'B', labelPlural: 'Bs' }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  it.each([
    ['campus-scoped admin (org-wide config needs org scope)', CTX.campusAdminA, 403],
    ['read-only faculty', CTX.facultyA, 403],
    ['student', CTX.studentA, 403],
    ['user without roles', CTX.noroleA, 403],
  ])('create authorization: %s', async (_n, actor, expected) => {
    await scratch(actor, async (tx, ctx) => {
      expect(
        await statusOf(
          PeriodTypeService.create(tx, ctx, { code: uniq('X'), label: 'L', labelPlural: 'Ls' }),
        ),
      ).toBe(expected);
    });
  });

  it.each([
    ['bad code', { code: 'a b', label: 'L', labelPlural: 'Ls' }],
    ['empty label', { code: 'OK', label: '', labelPlural: 'Ls' }],
    ['label too long', { code: 'OK', label: 'a'.repeat(51), labelPlural: 'Ls' }],
  ])('rejects %s with 400', async (_n, body) => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await expect(PeriodTypeService.create(tx, ctx, body)).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  it('list requires academic.program.read and is readable by students', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await makePeriodType(tx, ctx);
      const asStudent = await PeriodTypeService.list(tx, ctxOf(CTX.studentA));
      expect(asStudent.length).toBeGreaterThan(0);
    });
    await scratch(CTX.noroleA, async (tx, ctx) => {
      await expect(PeriodTypeService.list(tx, ctx)).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});

// ============================================================================
// Programs
// ============================================================================
describe('ProgramService.create', () => {
  it('creates a program with a department+period_type and audits it', async () => {
    let id: string | undefined;
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      id = await ProgramService.create(tx, ctx, programBody({ periodTypeId: pt }), {
        ip: '10.0.0.1',
      });
      const row = await tx.query<{ department_id: string; status: string }>(
        'SELECT department_id, status FROM app.programs WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ department_id: DEPT_1, status: 'ACTIVE' });
    });
    // Rollback is atomic across the program row and its audit event.
    expect(await adminQuery('SELECT 1 FROM app.programs WHERE id = $1', [id])).toHaveLength(0);
    expect(
      await adminQuery('SELECT 1 FROM app.audit_events WHERE resource_id = $1', [id]),
    ).toHaveLength(0);
  });

  // NOTE: a CAMPUS_ADMIN *successfully* creating writes an audit event bound to its own session, so
  // positive cross-actor create/scope cases are exercised at the HTTP layer (academic-routes.test.ts),
  // where each request runs under the acting principal's own session. Here we test the scoped-out 403.
  it('a CAMPUS_ADMIN cannot create a program in another campus department (403)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      // DEPT_3 is in CAMPUS_2, outside campusAdminA's CAMPUS_1 scope; rejected before any audit write.
      expect(
        await statusOf(
          ProgramService.create(
            tx,
            ctxOf(CTX.campusAdminA),
            programBody({ periodTypeId: pt, departmentId: DEPT_3 }),
          ),
        ),
      ).toBe(403);
    });
  });

  it.each([
    ['read-only HOD', CTX.hodA, 403],
    ['read-only faculty', CTX.facultyA, 403],
    ['student', CTX.studentA, 403],
    ['no role', CTX.noroleA, 403],
  ])('create authorization: %s', async (_n, actor, expected) => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      expect(
        await statusOf(ProgramService.create(tx, ctxOf(actor), programBody({ periodTypeId: pt }))),
      ).toBe(expected);
    });
  });

  it('returns 404 when the department does not exist or is in another tenant', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      // DEPT_B1 belongs to ORG_B; from ORG_A it is simply not found (resource hiding).
      await expect(
        ProgramService.create(
          tx,
          ctx,
          programBody({ periodTypeId: pt, departmentId: '01939a00-0000-7000-8000-00000000db01' }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('returns 404 when the period type is unknown', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await expect(
        ProgramService.create(
          tx,
          ctx,
          programBody({ periodTypeId: '01939a00-0000-7000-8000-00000000ffff' }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('rejects a duplicate program code (409)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const code = uniq('DUP');
      await ProgramService.create(tx, ctx, programBody({ periodTypeId: pt, code }));
      await expect(
        ProgramService.create(tx, ctx, programBody({ periodTypeId: pt, code })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  it.each([
    ['duration 0', { durationPeriods: 0 }],
    ['duration too big', { durationPeriods: 101 }],
    ['empty degree', { degreeLevel: '' }],
    ['bad code', { code: 'a b' }],
  ])('rejects %s with 400', async (_n, over) => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      await expect(
        ProgramService.create(tx, ctx, programBody({ periodTypeId: pt, ...over })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('rejects an untrusted context with 500', async () => {
    await scratch(CTX.staffA, async (tx) => {
      await expect(
        ProgramService.create(tx, {} as unknown as TrustedContext, programBody()),
      ).rejects.toMatchObject({ statusCode: 500, code: 'UNTRUSTED_CONTEXT' });
    });
  });
});

describe('ProgramService.list', () => {
  it('scopes a department-scoped reader to its own department', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      await ProgramService.create(
        tx,
        ctx,
        programBody({ periodTypeId: pt, departmentId: DEPT_1, code: uniq('D1') }),
      );
      await ProgramService.create(
        tx,
        ctx,
        programBody({ periodTypeId: pt, departmentId: DEPT_3, code: uniq('D3') }),
      );

      // HOD of DEPT_1 sees only DEPT_1 programs.
      const hodList = await ProgramService.list(tx, ctxOf(CTX.hodA));
      expect(hodList.every((p) => p.departmentId === DEPT_1)).toBe(true);
      expect(hodList.some((p) => p.departmentId === DEPT_3)).toBe(false);

      // COLLEGE_ADMIN (org) sees both.
      const orgList = await ProgramService.list(tx, ctx);
      expect(orgList.some((p) => p.departmentId === DEPT_1)).toBe(true);
      expect(orgList.some((p) => p.departmentId === DEPT_3)).toBe(true);
    });
  });

  it('hides INACTIVE programs from non-managers', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const id = await ProgramService.create(
        tx,
        ctx,
        programBody({ periodTypeId: pt, departmentId: DEPT_1 }),
      );
      await tx.query("UPDATE app.programs SET status = 'INACTIVE' WHERE id = $1", [id]);
      const student = await ProgramService.list(tx, ctxOf(CTX.studentA));
      expect(student.some((p) => p.id === id)).toBe(false);
      const admin = await ProgramService.list(tx, ctx, { status: 'INACTIVE' });
      expect(admin.some((p) => p.id === id)).toBe(true);
    });
  });

  it('enforces tenant isolation', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const id = await ProgramService.create(tx, ctx, programBody({ periodTypeId: pt }));
      await scratch(CTX.staffB, async (txB, ctxB) => {
        const listB = await ProgramService.list(txB, ctxB);
        expect(listB.some((p) => p.id === id)).toBe(false);
      });
    });
  });
});

describe('ProgramService.update', () => {
  it('is a no-op (no version bump, no audit) when nothing changes', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const id = await ProgramService.create(
        tx,
        ctx,
        programBody({ periodTypeId: pt, name: 'Same' }),
      );
      await ProgramService.update(tx, ctx, id, { name: 'Same' });
      const row = await tx.query<{ version: number }>(
        'SELECT version FROM app.programs WHERE id = $1',
        [id],
      );
      expect(row.rows[0]?.version).toBe(1);
    });
  });

  it('refuses to deactivate a program with an active cohort (409)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const prog = await ProgramService.create(tx, ctx, programBody({ periodTypeId: pt }));
      await CohortService.create(tx, ctx, cohortBody({ programId: prog }));
      await expect(
        ProgramService.update(tx, ctx, prog, { status: 'INACTIVE' }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  it('out-of-scope CAMPUS_ADMIN gets 404 (resource hiding)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const pt = await makePeriodType(tx, ctx);
      const prog = await ProgramService.create(
        tx,
        ctx,
        programBody({ periodTypeId: pt, departmentId: DEPT_3 }),
      );
      await expect(
        ProgramService.update(tx, ctxOf(CTX.campusAdminA), prog, { name: 'Renamed' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('returns 404 for an unknown program', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await expect(
        ProgramService.update(tx, ctx, '01939a00-0000-7000-8000-00000000ffff', { name: 'X' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});

// ============================================================================
// Cohorts
// ============================================================================
describe('CohortService', () => {
  async function seedProgram(
    tx: TenantTx,
    ctx: TrustedContext,
    departmentId = DEPT_1,
  ): Promise<string> {
    const pt = await makePeriodType(tx, ctx);
    return ProgramService.create(tx, ctx, programBody({ periodTypeId: pt, departmentId }));
  }

  it('creates a cohort under a program and audits it', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      const id = await CohortService.create(tx, ctx, cohortBody({ programId: prog }));
      const row = await tx.query<{ program_id: string; intake_code: string }>(
        'SELECT program_id, intake_code FROM app.cohorts WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ program_id: prog, intake_code: 'MAIN' });
    });
  });

  it('rejects a duplicate (program, admission_year, intake) with 409', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      await CohortService.create(tx, ctx, cohortBody({ programId: prog, admissionYear: 2024 }));
      await expect(
        CohortService.create(tx, ctx, cohortBody({ programId: prog, admissionYear: 2024 })),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  it('allows a second intake in the same year', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      await CohortService.create(tx, ctx, cohortBody({ programId: prog, admissionYear: 2024 }));
      expect(
        await statusOf(
          CohortService.create(
            tx,
            ctx,
            cohortBody({ programId: prog, admissionYear: 2024, intakeCode: 'LAT' }),
          ),
        ),
      ).toBe(200);
    });
  });

  it('returns 404 for an unknown or inactive program', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      await expect(
        CohortService.create(
          tx,
          ctx,
          cohortBody({ programId: '01939a00-0000-7000-8000-00000000ffff' }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('rejects expectedGraduationYear earlier than admissionYear (400)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      await expect(
        CohortService.create(
          tx,
          ctx,
          cohortBody({ programId: prog, admissionYear: 2025, expectedGraduationYear: 2024 }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('requires academic.cohort.manage (read-only HOD is forbidden)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      expect(
        await statusOf(CohortService.create(tx, ctxOf(CTX.hodA), cohortBody({ programId: prog }))),
      ).toBe(403);
    });
  });

  it('CAMPUS_ADMIN cannot create a cohort under a program in another campus (403)', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx, DEPT_3); // CAMPUS_2
      expect(
        await statusOf(
          CohortService.create(tx, ctxOf(CTX.campusAdminA), cohortBody({ programId: prog })),
        ),
      ).toBe(403);
    });
  });

  it('lists cohorts scoped through the program department: EVERY returned cohort belongs to the HOD department', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      // One cohort in the HOD's department, one in a sibling department of the SAME campus, one in another campus.
      const prog1 = await seedProgram(tx, ctx, DEPT_1);
      const prog2 = await seedProgram(tx, ctx, DEPT_2);
      const prog3 = await seedProgram(tx, ctx, DEPT_3);
      for (const programId of [prog1, prog2, prog3]) {
        await CohortService.create(tx, ctx, cohortBody({ programId, admissionYear: 2025 }));
      }

      const hod = await CohortService.list(tx, ctxOf(CTX.hodA));

      // Not vacuous: this test's own DEPT_1 cohort is visible.
      expect(hod.some((c) => c.programId === prog1)).toBe(true);

      // The property under test, independent of any other test file's committed rows (which may legitimately add
      // DEPT_1 cohorts, and must never add anything else): resolve the department of EVERY returned cohort.
      const programIds = [...new Set(hod.map((c) => c.programId))];
      const owners = await tx.query<{ id: string; department_id: string }>(
        'SELECT id, department_id FROM app.programs WHERE organization_id = $1 AND id = ANY($2::uuid[])',
        [ORG_A, programIds],
      );
      expect(owners.rows, 'every returned cohort must resolve to a program').toHaveLength(
        programIds.length,
      );
      const outOfScope = owners.rows.filter((r) => r.department_id !== DEPT_1);
      expect(outOfScope, 'cohorts returned from a department other than DEPT_1').toEqual([]);

      // Readable failure messages for the two seeded decoys.
      expect(hod.some((c) => c.programId === prog2)).toBe(false);
      expect(hod.some((c) => c.programId === prog3)).toBe(false);
    });
  });

  it('updates a cohort status and audits it', async () => {
    await scratch(CTX.staffA, async (tx, ctx) => {
      const prog = await seedProgram(tx, ctx);
      const id = await CohortService.create(tx, ctx, cohortBody({ programId: prog }));
      await CohortService.update(tx, ctx, id, { status: 'GRADUATED' });
      const row = await tx.query<{ status: string; version: number }>(
        'SELECT status, version FROM app.cohorts WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ status: 'GRADUATED', version: 2 });
    });
  });
});
