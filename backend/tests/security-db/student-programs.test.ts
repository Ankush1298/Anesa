import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
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
  ORG_B,
  STAFF_A,
  STAFF_B,
  STUDENT_A,
  STUDENT_B,
  STUDENT_C,
} from '../support/fixtures.js';
import { adminQuery, runAs, runStepsAs, type Step } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0021: app.student_programs and app.student_program_events (Students Phase 3a, step 1: database only).
//  * Constraint, foreign-key, trigger and append-only behaviour: rolled-back superuser transactions on the shared
//    fixtures (RLS does not apply to the superuser, triggers and constraints do), one SAVEPOINT per probe.
//  * Grants, row security and denied writes: the REAL runtime role through runAs / runStepsAs (always rolled back).
//  * Student-self reads and the cohort/opening race need committed rows: a private tenant, cleaned up afterwards.
// Nothing here commits to ORG_A / ORG_B.

const RUN = randomBytes(3).toString('hex');

// ------------------------------------------------------------------------------------------------------------
// Scenario helpers
// ------------------------------------------------------------------------------------------------------------
interface Ids {
  periodA: string;
  p1: string; // program in DEPT_1 (CAMPUS_1)
  p2: string; // program in DEPT_3 (CAMPUS_2)
  c1: string; // ACTIVE cohort of p1
  c2: string; // CLOSED cohort of p1
  c3: string; // ACTIVE cohort of p2
  periodB: string;
  pB: string; // tenant B program (DEPT_B1)
  cB: string;
}
const newIds = (): Ids => ({
  periodA: uuidv7(),
  p1: uuidv7(),
  p2: uuidv7(),
  c1: uuidv7(),
  c2: uuidv7(),
  c3: uuidv7(),
  periodB: uuidv7(),
  pB: uuidv7(),
  cB: uuidv7(),
});

const periodSql = `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, $3, 'Semester', 'Semesters')`;
const programSql = `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
                    VALUES ($1, $2, $3, $4, 'Program', $5, 'UG', 8)`;
const cohortSql = `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name, status)
                   VALUES ($1, $2, $3, $4, 'Cohort', $5)`;

/** Period types, programs and cohorts for tenants A and B (as steps, so a runtime-role transaction can use them too). */
function structureSteps(i: Ids): Step[] {
  const c = (s: string): string => `${s}-${RUN}-${i.p1.slice(-6)}`;
  return [
    [periodSql, [i.periodA, ORG_A, c('PT')]],
    [programSql, [i.p1, ORG_A, DEPT_1, i.periodA, c('P1')]],
    [programSql, [i.p2, ORG_A, DEPT_3, i.periodA, c('P2')]],
    [cohortSql, [i.c1, ORG_A, i.p1, 2024, 'ACTIVE']],
    [cohortSql, [i.c2, ORG_A, i.p1, 2023, 'CLOSED']],
    [cohortSql, [i.c3, ORG_A, i.p2, 2024, 'ACTIVE']],
  ];
}
function structureStepsB(i: Ids): Step[] {
  return [
    [periodSql, [i.periodB, ORG_B, `PT-${RUN}-B`]],
    [programSql, [i.pB, ORG_B, DEPT_B1, i.periodB, `PB-${RUN}`]],
    [cohortSql, [i.cB, ORG_B, i.pB, 2024, 'ACTIVE']],
  ];
}

interface Enrol {
  id: string;
  org: string;
  student: string;
  program: string;
  cohort: string;
  campus: string;
  dept: string;
  start: string;
  end: string | null;
  status: string;
  entry: string;
  previous: string | null;
  exitReason: string | null;
}
const enrolSql = `INSERT INTO app.student_programs
  (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, end_date, status, entry_type,
   previous_student_program_id, exit_reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;
const enrol = (i: Ids, o: Partial<Enrol> = {}): Step => {
  const e: Enrol = {
    id: uuidv7(),
    org: ORG_A,
    student: STUDENT_A,
    program: i.p1,
    cohort: i.c1,
    campus: CAMPUS_1,
    dept: DEPT_1,
    start: '2024-07-01',
    end: null,
    status: 'ACTIVE',
    entry: 'REGULAR',
    previous: null,
    exitReason: null,
    ...o,
  };
  return [
    enrolSql,
    [
      e.id,
      e.org,
      e.student,
      e.program,
      e.cohort,
      e.campus,
      e.dept,
      e.start,
      e.end,
      e.status,
      e.entry,
      e.previous,
      e.exitReason,
    ],
  ];
};
const eventSql = `INSERT INTO app.student_program_events
  (id, organization_id, student_program_id, student_id, event_type, from_status, to_status, effective_date, reason, actor_user_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
const event = (
  programId: string,
  o: Partial<{
    org: string;
    student: string;
    type: string;
    from: string | null;
    to: string;
    reason: string;
    actor: string;
    date: string;
  }> = {},
): Step => [
  eventSql,
  [
    uuidv7(),
    o.org ?? ORG_A,
    programId,
    o.student ?? STUDENT_A,
    o.type ?? 'OPENED',
    o.from === undefined ? null : o.from,
    o.to ?? 'ACTIVE',
    o.date ?? '2024-07-01',
    o.reason ?? 'Admitted to the program',
    o.actor ?? STAFF_A,
  ],
];

const idOf = (step: Step): string => (step[1] as unknown[])[0] as string;
interface Failure {
  code: string | undefined;
  constraint: string | undefined;
}
/** One rolled-back superuser transaction with the structure seeded; `try_` runs a statement under a SAVEPOINT. */
async function scenario(
  body: (a: {
    ids: Ids;
    run: (s: Step) => Promise<void>;
    try_: (s: Step) => Promise<Failure | undefined>;
    q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  }) => Promise<void>,
): Promise<void> {
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    const ids = newIds();
    const run = async ([sql, params]: Step): Promise<void> => {
      await c.query(sql, params ? [...params] : []);
    };
    for (const s of [...structureSteps(ids), ...structureStepsB(ids)]) await run(s);
    const try_ = async ([sql, params]: Step): Promise<Failure | undefined> => {
      await c.query('SAVEPOINT probe');
      try {
        await c.query(sql, params ? [...params] : []);
        await c.query('RELEASE SAVEPOINT probe');
        return undefined;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT probe');
        const err = e as { code?: string; constraint?: string };
        return { code: err.code, constraint: err.constraint };
      }
    };
    await body({ ids, run, try_, q: (sql, params) => c.query(sql, params) });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

// ------------------------------------------------------------------------------------------------------------
describe('relations: composite foreign keys keep every enrolment inside one tenant and one program tree', () => {
  it('a consistent enrolment is accepted, with its OPENED history event', async () => {
    await scenario(async ({ ids, run }) => {
      const e = enrol(ids);
      await run(e);
      await run(event(idOf(e)));
    });
  });

  it.each([
    [
      "a department that is not the program's department",
      (i: Ids) => enrol(i, { dept: DEPT_2 }),
      'student_programs_program_fk',
    ],
    [
      "a campus that is not the department's campus",
      (i: Ids) => enrol(i, { campus: CAMPUS_2 }),
      'student_programs_department_fk',
    ],
    [
      'a cohort of ANOTHER program',
      (i: Ids) => enrol(i, { cohort: i.c3 }),
      'student_programs_cohort_fk',
    ],
    [
      'a student of ANOTHER tenant',
      (i: Ids) => enrol(i, { student: STUDENT_C }),
      'student_programs_student_fk',
    ],
  ] as const)('refuses %s (23503)', async (_label, make, constraint) => {
    await scenario(async ({ ids, try_ }) => {
      expect(await try_(make(ids))).toEqual({ code: '23503', constraint });
    });
  });

  it('refuses a row that mixes tenants: tenant B program/cohort/campus under tenant A (23503)', async () => {
    await scenario(async ({ ids, try_ }) => {
      const r = await try_(
        enrol(ids, { program: ids.pB, cohort: ids.cB, campus: CAMPUS_B1, dept: DEPT_B1 }),
      );
      expect(r?.code).toBe('23503');
    });
  });

  it('refuses a previous enrolment of ANOTHER student (23503) and accepts one of the SAME student', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const prior = enrol(ids, {
        status: 'COMPLETED',
        end: '2025-01-01',
        exitReason: 'Completed',
        cohort: ids.c2,
      });
      await run(prior);
      const priorId = idOf(prior);
      expect(
        await try_(enrol(ids, { student: STUDENT_B, entry: 'READMISSION', previous: priorId })),
      ).toEqual({ code: '23503', constraint: 'student_programs_previous_fk' });
      expect(
        await try_(enrol(ids, { entry: 'READMISSION', previous: priorId, start: '2025-02-01' })),
      ).toBeUndefined();
    });
  });

  it("events: the event student must be the enrolment's student, the actor must be a user of the same tenant (23503)", async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      const id = idOf(e);
      expect(await try_(event(id, { student: STUDENT_B }))).toEqual({
        code: '23503',
        constraint: 'student_program_events_program_fk',
      });
      expect(await try_(event(id, { actor: STAFF_B }))).toEqual({
        code: '23503',
        constraint: 'student_program_events_actor_fk',
      });
      expect((await try_(event(id, { org: ORG_B })))?.code).toBe('23503');
    });
  });

  it('the supporting unique constraints exist on the EXISTING tables (and are the targets of the new foreign keys)', async () => {
    const rows = await adminQuery<{ conname: string; conrelid: string }>(
      `SELECT conname, conrelid::regclass::text AS conrelid FROM pg_constraint
        WHERE conname IN ('programs_org_dept_id_uq', 'cohorts_org_program_id_uq') ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: 'cohorts_org_program_id_uq', conrelid: 'app.cohorts' },
      { conname: 'programs_org_dept_id_uq', conrelid: 'app.programs' },
    ]);
  });
});

describe('at most one ACTIVE enrolment per student (partial unique index)', () => {
  it('a second ACTIVE enrolment for the same student is refused (23505 student_programs_one_active_uq)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      await run(enrol(ids));
      expect(await try_(enrol(ids))).toEqual({
        code: '23505',
        constraint: 'student_programs_one_active_uq',
      });
      expect(await try_(enrol(ids, { student: STUDENT_B }))).toBeUndefined(); // another student is independent
    });
  });

  it('closed enrolments do not count, and closing frees the slot', async () => {
    await scenario(async ({ ids, run, try_, q }) => {
      const open = enrol(ids);
      await run(open);
      await run(
        enrol(ids, {
          status: 'DISCONTINUED',
          end: '2024-08-01',
          exitReason: 'Left',
          cohort: ids.c2,
        }),
      ); // history
      expect(await try_(enrol(ids, { start: '2025-02-01' }))).toEqual({
        code: '23505',
        constraint: 'student_programs_one_active_uq',
      });
      await q(
        `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-01-01', exit_reason = 'Completed' WHERE id = $1`,
        [idOf(open)],
      );
      expect(await try_(enrol(ids, { start: '2025-02-01' }))).toBeUndefined();
    });
  });
});

describe('row constraints', () => {
  it.each([
    ['an ACTIVE enrolment with an end date', { end: '2025-01-01' }, 'student_programs_end_date_ck'],
    [
      'a closed enrolment without an end date',
      { status: 'COMPLETED', exitReason: 'Done' },
      'student_programs_end_date_ck',
    ],
    [
      'an end date before the start date',
      { status: 'COMPLETED', end: '2024-06-01', exitReason: 'Done' },
      'student_programs_dates_ck',
    ],
    [
      'an ACTIVE enrolment that already carries an exit reason',
      { exitReason: 'Left' },
      'student_programs_active_no_exit_reason_ck',
    ],
    [
      'a REGULAR entry with a previous enrolment',
      { previous: uuidv7() },
      'student_programs_regular_no_previous_ck',
    ],
  ] as const)('refuses %s (23514)', async (_label, over, constraint) => {
    await scenario(async ({ ids, try_ }) => {
      expect(await try_(enrol(ids, over as Partial<Enrol>))).toEqual({ code: '23514', constraint });
    });
  });

  it('refuses an enrolment that is its own previous enrolment (23514)', async () => {
    await scenario(async ({ ids, try_ }) => {
      const id = uuidv7();
      expect(await try_(enrol(ids, { id, entry: 'READMISSION', previous: id }))).toEqual({
        code: '23514',
        constraint: 'student_programs_previous_not_self_ck',
      });
    });
  });

  it('refuses unknown status / entry type values and out-of-range dates (23514)', async () => {
    await scenario(async ({ ids, try_ }) => {
      expect((await try_(enrol(ids, { status: 'PAUSED' })))?.code).toBe('23514');
      expect((await try_(enrol(ids, { entry: 'WALK_IN' })))?.code).toBe('23514');
      expect((await try_(enrol(ids, { start: '1800-01-01' })))?.code).toBe('23514');
    });
  });

  it('the non-REGULAR entry types are MODELLED (accepted); an ON_LEAVE row cannot be CREATED (23514), though the vocabulary keeps it', async () => {
    await scenario(async ({ ids, try_ }) => {
      expect(await try_(enrol(ids, { entry: 'LATERAL', start: '2024-08-01' }))).toBeUndefined();
      expect(await try_(enrol(ids, { student: STUDENT_B, status: 'ON_LEAVE' }))).toMatchObject({
        code: '23514',
        constraint: 'student_programs_no_direct_on_leave_ck',
      });
      expect(
        await try_(enrol(ids, { student: STUDENT_B, status: 'ON_LEAVE', cohort: ids.c2 })),
      ).toMatchObject({ code: '23514', constraint: 'student_programs_no_direct_on_leave_ck' });
    });
  });
});

describe('opening guard (trigger): start after admission, ACTIVE cohort', () => {
  it("start_date before the student's admission date is refused (23514); the admission day itself is fine", async () => {
    await scenario(async ({ ids, try_ }) => {
      // STUDENT_A is admitted 2024-07-01 (fixtures)
      expect(await try_(enrol(ids, { start: '2024-06-30' }))).toEqual({
        code: '23514',
        constraint: 'student_programs_start_after_admission_ck',
      });
      expect(await try_(enrol(ids, { start: '2024-07-01' }))).toBeUndefined();
    });
  });

  it('opening an ACTIVE enrolment in a CLOSED cohort is refused (23514); a closed history row in it is allowed', async () => {
    await scenario(async ({ ids, try_ }) => {
      expect(await try_(enrol(ids, { cohort: ids.c2 }))).toEqual({
        code: '23514',
        constraint: 'student_programs_cohort_active_ck',
      });
      expect(
        await try_(
          enrol(ids, {
            cohort: ids.c2,
            status: 'COMPLETED',
            end: '2025-01-01',
            exitReason: 'Done',
          }),
        ),
      ).toBeUndefined();
    });
  });

  it('the guard reads no clock: a far-future start date passes the database (the service rejects it against the campus calendar)', async () => {
    await scenario(async ({ ids, try_ }) => {
      expect(await try_(enrol(ids, { start: '2199-01-01' }))).toBeUndefined();
    });
  });
});

describe('lifecycle guard (trigger): immutable identity, terminal states, allowed transitions', () => {
  it('ACTIVE can be closed as COMPLETED, TRANSFERRED_OUT or DISCONTINUED (one at a time per student); touch_row bumps the version', async () => {
    await scenario(async ({ ids, run, try_, q }) => {
      let start = '2024-07-01';
      for (const [i, to] of ['COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED'].entries()) {
        const e = enrol(ids, { start });
        await run(e);
        const before = await q('SELECT version FROM app.student_programs WHERE id = $1', [idOf(e)]);
        const closed = await try_([
          `UPDATE app.student_programs SET status = $2, end_date = $3, exit_reason = 'Closed in the test' WHERE id = $1`,
          [idOf(e), to, `2025-0${i + 1}-01`],
        ]);
        expect(closed, to).toBeUndefined();
        const after = await q('SELECT version, status FROM app.student_programs WHERE id = $1', [
          idOf(e),
        ]);
        expect(after.rows[0]).toEqual({
          version: (before.rows[0] as { version: number }).version + 1,
          status: to,
        });
        start = `2025-0${i + 1}-02`;
      }
    });
  });

  it('ACTIVE -> ON_LEAVE (and any other change of status) is refused: no transition into or out of ON_LEAVE exists yet (23001)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      const id = idOf(e);
      expect(
        (await try_([`UPDATE app.student_programs SET status = 'ON_LEAVE' WHERE id = $1`, [id]]))
          ?.code,
      ).toBe('23001');
      // closing without an end date is refused by the row constraint, after the guard accepted the transition
      expect(
        await try_([`UPDATE app.student_programs SET status = 'COMPLETED' WHERE id = $1`, [id]]),
      ).toEqual({ code: '23514', constraint: 'student_programs_end_date_ck' });
    });
  });

  it('a closed row is terminal (23001): nothing about it can change, including reopening', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      const id = idOf(e);
      await run([
        `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-05-01', exit_reason = 'Done' WHERE id = $1`,
        [id],
      ]);
      for (const sql of [
        `UPDATE app.student_programs SET exit_reason = 'Edited' WHERE id = $1`,
        `UPDATE app.student_programs SET status = 'ACTIVE', end_date = NULL, exit_reason = NULL WHERE id = $1`,
        `UPDATE app.student_programs SET status = 'DISCONTINUED' WHERE id = $1`,
        `UPDATE app.student_programs SET end_date = '2025-06-01' WHERE id = $1`,
      ]) {
        expect((await try_([sql, [id]]))?.code, sql).toBe('23001');
      }
    });
  });

  it('identity columns are immutable even for a privileged session (23001): student, program, cohort, campus, department, dates, entry, previous, ids', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids, { student: STUDENT_A });
      await run(e);
      const id = idOf(e);
      const changes: [string, unknown][] = [
        ['student_id', STUDENT_B],
        ['program_id', ids.p2],
        ['cohort_id', ids.c2],
        ['campus_id', CAMPUS_2],
        ['department_id', DEPT_2],
        ['start_date', '2024-07-05'],
        ['entry_type', 'LATERAL'],
        ['id', uuidv7()],
        ['organization_id', ORG_B],
      ];
      for (const [col, value] of changes) {
        const r = await try_([
          `UPDATE app.student_programs SET ${col} = $2 WHERE id = $1`,
          [id, value],
        ]);
        expect(r?.code, col).toBe('23001');
      }
    });
  });

  it('a referenced program cannot be moved to another department, nor a cohort to another program (foreign keys)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      await run(enrol(ids));
      expect(
        (await try_([`UPDATE app.programs SET department_id = $2 WHERE id = $1`, [ids.p1, DEPT_2]]))
          ?.code,
      ).toBe('23503');
      expect(
        (
          await try_([
            // admission_year changes too, so the cohort's own unique key cannot be what refuses the move
            `UPDATE app.cohorts SET program_id = $2, admission_year = 2030 WHERE id = $1`,
            [ids.c1, ids.p2],
          ])
        )?.code,
      ).toBe('23503');
    });
  });
});

describe('student_program_events: shape and append-only', () => {
  it('only OPENED (null -> ACTIVE) and CLOSED (ACTIVE -> terminal) events are recordable, with a 5-500 character reason (23514)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      const id = idOf(e);
      expect(await try_(event(id, { type: 'OPENED', from: 'ACTIVE', to: 'ACTIVE' }))).toMatchObject(
        { code: '23514', constraint: 'student_program_events_shape_ck' },
      );
      expect(await try_(event(id, { type: 'CLOSED', from: null, to: 'COMPLETED' }))).toMatchObject({
        code: '23514',
      });
      expect(
        await try_(event(id, { type: 'CLOSED', from: 'ACTIVE', to: 'ON_LEAVE' })),
      ).toMatchObject({ code: '23514' });
      expect((await try_(event(id, { reason: 'abc' })))?.code).toBe('23514');
      expect((await try_(event(id, { reason: 'x'.repeat(501) })))?.code).toBe('23514');
    });
  });

  it('UPDATE, DELETE and TRUNCATE are refused for every role, the owner and the superuser included (23001)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      const ev = event(idOf(e));
      await run(ev);
      const evId = idOf(ev);
      expect(
        (
          await try_([
            `UPDATE app.student_program_events SET reason = 'Edited reason' WHERE id = $1`,
            [evId],
          ])
        )?.code,
      ).toBe('23001');
      expect(
        (
          await try_([
            `UPDATE app.student_program_events SET organization_id = $2 WHERE id = $1`,
            [evId, ORG_B],
          ])
        )?.code,
      ).toBe('23001');
      expect(
        (await try_([`DELETE FROM app.student_program_events WHERE id = $1`, [evId]]))?.code,
      ).toBe('23001');
      expect((await try_([`TRUNCATE app.student_program_events`, []]))?.code).toBe('23001');
      // the enrolment cannot be removed while history references it (RESTRICT)
      expect(
        (await try_([`DELETE FROM app.student_programs WHERE id = $1`, [idOf(e)]]))?.code,
      ).toBe('23503');
    });
  });
});

describe('student_program_events: an event must describe the enrolment it belongs to (guard + one-per-type indexes)', () => {
  const close = (id: string, status: string, end: string): Step => [
    `UPDATE app.student_programs SET status = $2, end_date = $3, exit_reason = 'Closed for the test' WHERE id = $1`,
    [id, status, end],
  ];
  const mismatch = { code: '23514', constraint: 'student_program_events_matches_enrolment_ck' };

  it('the real lifecycle is accepted: OPENED with the enrolment, CLOSED after the close with its outcome and end date', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      const id = idOf(e);
      await run(e);
      expect(await try_(event(id))).toBeUndefined();
      await run(close(id, 'DISCONTINUED', '2025-01-15'));
      expect(
        await try_(
          event(id, { type: 'CLOSED', from: 'ACTIVE', to: 'DISCONTINUED', date: '2025-01-15' }),
        ),
      ).toBeUndefined();
    });
  });

  it('at most one OPENED and one CLOSED event per enrolment (23505)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      const id = idOf(e);
      await run(e);
      await run(event(id));
      expect(await try_(event(id))).toEqual({
        code: '23505',
        constraint: 'student_program_events_one_opened_uq',
      });
      await run(close(id, 'COMPLETED', '2025-01-15'));
      const closed = event(id, {
        type: 'CLOSED',
        from: 'ACTIVE',
        to: 'COMPLETED',
        date: '2025-01-15',
      });
      await run(closed);
      expect(await try_(closed)).toBeDefined();
      expect(
        await try_(
          event(id, { type: 'CLOSED', from: 'ACTIVE', to: 'COMPLETED', date: '2025-01-15' }),
        ),
      ).toEqual({ code: '23505', constraint: 'student_program_events_one_closed_uq' });
    });
  });

  it('OPENED must match an ACTIVE enrolment and its start date (23514)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      const id = idOf(e);
      await run(e);
      expect(await try_(event(id, { date: '2024-07-02' }))).toEqual(mismatch);
      await run(close(id, 'COMPLETED', '2025-01-15'));
      // a closed enrolment can no longer be "opened" by a late event, even on its start date
      expect(await try_(event(id))).toEqual(mismatch);
    });
  });

  it('CLOSED must match the enrolment actual terminal status and end date (23514)', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      const id = idOf(e);
      await run(e);
      const closedEvent = (to: string, date: string): Step =>
        event(id, { type: 'CLOSED', from: 'ACTIVE', to, date });
      // the enrolment is still ACTIVE: nothing was closed
      expect(await try_(closedEvent('COMPLETED', '2025-01-15'))).toEqual(mismatch);
      await run(close(id, 'DISCONTINUED', '2025-01-15'));
      // wrong outcome, wrong date
      expect(await try_(closedEvent('COMPLETED', '2025-01-15'))).toEqual(mismatch);
      expect(await try_(closedEvent('TRANSFERRED_OUT', '2025-01-15'))).toEqual(mismatch);
      expect(await try_(closedEvent('DISCONTINUED', '2025-01-16'))).toEqual(mismatch);
      expect(await try_(closedEvent('DISCONTINUED', '2025-01-15'))).toBeUndefined();
    });
  });

  it('an event that fits no enrolment of that student/tenant is still refused by the foreign key (23503), the guard stays silent', async () => {
    await scenario(async ({ ids, run, try_ }) => {
      const e = enrol(ids);
      await run(e);
      expect((await try_(event(uuidv7())))?.code).toBe('23503');
      expect((await try_(event(idOf(e), { student: STUDENT_B })))?.code).toBe('23503');
    });
  });
});

// ------------------------------------------------------------------------------------------------------------
describe('catalogue: row security, policies, grants, no DELETE', () => {
  const TABLES = ['student_programs', 'student_program_events'];

  it('both tables have row security enabled AND forced and are owned by the migrator', async () => {
    const rows = await adminQuery(
      `SELECT c.relname, c.relrowsecurity AS s, c.relforcerowsecurity AS f, pg_get_userbyid(c.relowner) AS o
         FROM pg_class c WHERE c.oid = ANY (ARRAY['app.student_programs'::regclass, 'app.student_program_events'::regclass])
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { relname: 'student_program_events', s: true, f: true, o: 'app_migrator' },
      { relname: 'student_programs', s: true, f: true, o: 'app_migrator' },
    ]);
  });

  it('policies: tenant-scoped permissive ones TO app_runtime, a RESTRICTIVE student-self policy, authorship on events', async () => {
    const rows = await adminQuery<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      roles: string;
    }>(
      `SELECT tablename, policyname, permissive, cmd, roles::text FROM pg_policies
        WHERE schemaname = 'app' AND tablename = ANY ($1::text[]) ORDER BY 1, 2`,
      [TABLES],
    );
    expect(rows.map((r) => `${r.tablename}.${r.policyname}:${r.permissive}:${r.cmd}`)).toEqual([
      'student_program_events.student_program_events_authorship:RESTRICTIVE:INSERT',
      'student_program_events.student_program_events_student_self:RESTRICTIVE:ALL',
      'student_program_events.student_program_events_tenant_insert:PERMISSIVE:INSERT',
      'student_program_events.student_program_events_tenant_select:PERMISSIVE:SELECT',
      'student_programs.student_programs_student_self:RESTRICTIVE:ALL',
      'student_programs.student_programs_tenant_insert:PERMISSIVE:INSERT',
      'student_programs.student_programs_tenant_select:PERMISSIVE:SELECT',
      'student_programs.student_programs_tenant_update:PERMISSIVE:UPDATE',
    ]);
    expect(rows.every((r) => r.roles === '{app_runtime}')).toBe(true);
  });

  it('app_runtime table privileges: student_programs SELECT+INSERT, events SELECT only (INSERT is column-level, next test); never DELETE, TRUNCATE, REFERENCES or TRIGGER', async () => {
    const rows = await adminQuery<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'app' AND grantee = 'app_runtime' AND table_name = ANY ($1::text[]) ORDER BY 1, 2`,
      [TABLES],
    );
    expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      'student_program_events:SELECT',
      'student_programs:INSERT',
      'student_programs:SELECT',
    ]);
  });

  it('column-level INSERT on events: every column but occurred_at (the server clock always applies)', async () => {
    const rows = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'app' AND grantee = 'app_runtime' AND privilege_type = 'INSERT'
          AND table_name = 'student_program_events' ORDER BY 1`,
    );
    const all = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'student_program_events' AND column_name <> 'occurred_at' ORDER BY 1`,
    );
    expect(rows).toEqual(all);
    expect(rows.map((r) => r.column_name)).not.toContain('occurred_at');
  });

  it('column-level UPDATE: only status, end_date and exit_reason of student_programs; none on events', async () => {
    const rows = await adminQuery<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE table_schema = 'app' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'
          AND table_name = ANY ($1::text[]) ORDER BY 1, 2`,
      [TABLES],
    );
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'student_programs.end_date',
      'student_programs.exit_reason',
      'student_programs.status',
    ]);
  });

  it('every guard function is SECURITY INVOKER, VOLATILE, pinned search_path, not executable by PUBLIC or the runtime role', async () => {
    const names = [
      'student_programs_guard',
      'student_programs_open_guard',
      'reject_student_program_event_mutation',
    ];
    const rows = await adminQuery(
      `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY ($1::text[]) ORDER BY 1`,
      [names],
    );
    expect(rows).toEqual(
      [...names].sort().map((proname) => ({
        proname,
        prosecdef: false,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog'],
        public_exec: false,
        runtime_exec: false,
      })),
    );
  });

  it("the required foreign-key and query indexes exist (leading columns, in the foreign keys' order)", async () => {
    const rows = await adminQuery<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'app' AND tablename = ANY ($1::text[]) ORDER BY 1`,
      [TABLES],
    );
    const have = new Set(rows.map((r) => r.indexname));
    for (const ix of [
      'student_programs_one_active_uq',
      'student_programs_org_student_previous_ix',
      'student_programs_org_dept_program_ix',
      'student_programs_org_program_cohort_ix',
      'student_programs_org_campus_dept_ix',
      'student_programs_org_dept_status_ix',
      'student_programs_org_cohort_ix',
      'student_program_events_org_student_program_ix',
      'student_program_events_org_actor_ix',
    ]) {
      expect(have.has(ix), ix).toBe(true);
    }
    const [partial] = await adminQuery<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'student_programs_one_active_uq'`,
    );
    expect(partial?.def).toMatch(
      /UNIQUE INDEX .* \(organization_id, student_id\) WHERE \(status = 'ACTIVE'::text\)/,
    );
  });
});

// ------------------------------------------------------------------------------------------------------------
describe('the real runtime role (rolled back)', () => {
  const asStaffA = (steps: Step[]) => runStepsAs(CTX.staffA, steps);

  it('a STAFF actor can open an enrolment and append its history event', async () => {
    const ids = newIds();
    const e = enrol(ids);
    const r = await asStaffA([
      ...structureSteps(ids),
      e,
      event(idOf(e)),
      ['SELECT status FROM app.student_programs WHERE id = $1', [idOf(e)]],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([{ status: 'ACTIVE' }]);
  });

  it('a STAFF actor can close it (status, end_date, exit_reason) but cannot change any other column (42501)', async () => {
    const ids = newIds();
    const e = enrol(ids);
    const base = [...structureSteps(ids), e];
    const close = await asStaffA([
      ...base,
      [
        `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-05-01', exit_reason = 'Done' WHERE id = $1`,
        [idOf(e)],
      ],
    ]);
    expect(close.error).toBeUndefined();
    for (const col of [
      'start_date',
      'cohort_id',
      'student_id',
      'program_id',
      'campus_id',
      'entry_type',
    ]) {
      const value = col === 'start_date' ? '2024-07-09' : col === 'entry_type' ? 'LATERAL' : ids.c2;
      const r = await asStaffA([
        ...base,
        [`UPDATE app.student_programs SET ${col} = $2 WHERE id = $1`, [idOf(e), value]],
      ]);
      expect(r.error?.code, col).toBe('42501');
    }
  });

  it('nothing can be DELETEd or TRUNCATEd by the runtime role, and events cannot be updated or deleted (42501)', async () => {
    const ids = newIds();
    const e = enrol(ids);
    const ev = event(idOf(e));
    const base = [...structureSteps(ids), e, ev];
    for (const sql of [
      'DELETE FROM app.student_programs',
      'TRUNCATE app.student_programs',
      'DELETE FROM app.student_program_events',
      'TRUNCATE app.student_program_events',
      `UPDATE app.student_program_events SET reason = 'Edited reason'`,
    ]) {
      expect((await asStaffA([...base, [sql]])).error?.code, sql).toBe('42501');
    }
  });

  it('the runtime role cannot supply occurred_at (42501); the server clock applies', async () => {
    const ids = newIds();
    const e = enrol(ids);
    const r = await asStaffA([
      ...structureSteps(ids),
      e,
      [
        `INSERT INTO app.student_program_events
           (id, organization_id, student_program_id, student_id, event_type, to_status, effective_date, reason, actor_user_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'OPENED', 'ACTIVE', '2024-07-01', 'Admitted to the program', $5, '2001-01-01')`,
        [uuidv7(), ORG_A, idOf(e), STUDENT_A, STAFF_A],
      ],
    ]);
    expect(r.error?.code).toBe('42501');
  });

  it('an event must be attributed to the session user (restrictive authorship policy, 42501)', async () => {
    const ids = newIds();
    const e = enrol(ids);
    const r = await asStaffA([
      ...structureSteps(ids),
      e,
      event(idOf(e), { actor: CTX.facultyA.user }),
    ]);
    expect(r.error?.code).toBe('42501');
  });

  it('a STAFF actor of tenant A cannot write an enrolment row for tenant B (42501: tenant check of row security)', async () => {
    const ids = newIds();
    const r = await asStaffA([
      ...structureSteps(ids),
      enrol(ids, { org: ORG_B, student: STUDENT_C, program: ids.p1, cohort: ids.c1 }),
    ]);
    expect(r.error?.code).toBe('42501');
  });

  it('with no context at all the tables are empty and cannot be written (fail closed)', async () => {
    const read = await runAs({}, 'SELECT count(*)::int AS n FROM app.student_programs');
    expect(read.rows).toEqual([{ n: 0 }]);
    const ids = newIds();
    const r = await runStepsAs({}, [...structureSteps(ids), enrol(ids)]);
    expect(r.error).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------------------------
describe('committed rows in a private tenant: student-self reads, denied student writes, isolation, opening race', () => {
  let T!: IsolatedTenant;
  const ids = newIds();
  const enrolOne = uuidv7();
  const enrolTwo = uuidv7();
  const staffCtx = (): { tenant: string; user: string; kind: string } => ({
    tenant: T.orgId,
    user: T.users.admin,
    kind: 'STAFF',
  });
  const studentCtx = (user: string): { tenant: string; user: string; kind: string } => ({
    tenant: T.orgId,
    user,
    kind: 'STUDENT',
  });

  beforeAll(async () => {
    T = await createIsolatedTenant('test-hash');
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(periodSql, [ids.periodA, T.orgId, `PT-${RUN}-S`]);
      await c.query(programSql, [ids.p1, T.orgId, T.departmentId, ids.periodA, `PS-${RUN}`]);
      await c.query(cohortSql, [ids.c1, T.orgId, ids.p1, 2024, 'ACTIVE']);
      await c.query(cohortSql, [ids.c2, T.orgId, ids.p1, 2023, 'ACTIVE']);
      for (const [id, student] of [
        [enrolOne, T.students.one],
        [enrolTwo, T.students.two],
      ] as const) {
        await c.query(enrolSql, [
          id,
          T.orgId,
          student,
          ids.p1,
          ids.c1,
          T.campusId,
          T.departmentId,
          '2024-07-01',
          null,
          'ACTIVE',
          'REGULAR',
          null,
          null,
        ]);
        await c.query(eventSql, [
          uuidv7(),
          T.orgId,
          id,
          student,
          'OPENED',
          null,
          'ACTIVE',
          '2024-07-01',
          'Admitted to the program',
          T.users.admin,
        ]);
      }
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  afterAll(async () => {
    // events are append-only (even for the superuser): remove the test rows with triggers skipped, in one transaction
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM app.student_program_events WHERE organization_id = $1', [T.orgId]);
      await c.query('DELETE FROM app.student_programs WHERE organization_id = $1', [T.orgId]);
      await c.query('DELETE FROM app.cohorts WHERE organization_id = $1', [T.orgId]);
      await c.query('DELETE FROM app.programs WHERE organization_id = $1', [T.orgId]);
      await c.query('DELETE FROM app.period_types WHERE organization_id = $1', [T.orgId]);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    await T.cleanup();
  });

  it('a STUDENT reads only the enrolments (and events) of their OWN student record', async () => {
    const mine = await runAs(studentCtx(T.users.studentOne), 'SELECT id FROM app.student_programs');
    expect(mine.rows).toEqual([{ id: enrolOne }]);
    const myEvents = await runAs(
      studentCtx(T.users.studentOne),
      'SELECT student_program_id FROM app.student_program_events',
    );
    expect(myEvents.rows).toEqual([{ student_program_id: enrolOne }]);
    const other = await runAs(
      studentCtx(T.users.studentTwo),
      'SELECT id FROM app.student_programs',
    );
    expect(other.rows).toEqual([{ id: enrolTwo }]);
    // asking for somebody else's row by id returns nothing, not an error
    const peek = await runAs(
      studentCtx(T.users.studentOne),
      'SELECT id FROM app.student_programs WHERE id = $1',
      [enrolTwo],
    );
    expect(peek.error).toBeUndefined();
    expect(peek.rows).toEqual([]);
  });

  it('a STAFF actor of the tenant reads all of it; staff of ANOTHER tenant and a session with no context read none', async () => {
    const staff = await runAs(staffCtx(), 'SELECT id FROM app.student_programs ORDER BY id');
    expect(staff.rows.map((r) => r['id']).sort()).toEqual([enrolOne, enrolTwo].sort());
    const foreign = await runAs(
      { tenant: ORG_B, user: STAFF_B, kind: 'STAFF' },
      'SELECT id FROM app.student_programs WHERE id = ANY ($1::uuid[])',
      [[enrolOne, enrolTwo]],
    );
    expect(foreign.rows).toEqual([]);
    const foreignEvents = await runAs(
      { tenant: ORG_A, user: STAFF_A, kind: 'STAFF' },
      'SELECT id FROM app.student_program_events WHERE organization_id = $1',
      [T.orgId],
    );
    expect(foreignEvents.rows).toEqual([]); // tenant A staff cannot see the private tenant
    expect((await runAs({}, 'SELECT id FROM app.student_programs')).rows).toEqual([]);
  });

  it('an actor kind other than STAFF / STUDENT sees nothing', async () => {
    const r = await runAs(
      { tenant: T.orgId, user: T.users.admin, kind: 'AI' },
      'SELECT id FROM app.student_programs',
    );
    expect(r.rows).toEqual([]);
  });

  it('a STUDENT can neither create nor change nor remove an enrolment or an event, not even their own (42501)', async () => {
    const asStudent = studentCtx(T.users.studentOne);
    const attempts: Step[] = [
      [
        `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-05-01', exit_reason = 'Self' WHERE id = $1`,
        [enrolOne],
      ],
      ['DELETE FROM app.student_programs WHERE id = $1', [enrolOne]],
      ['DELETE FROM app.student_program_events WHERE student_program_id = $1', [enrolOne]],
      [
        `UPDATE app.student_program_events SET reason = 'Edited reason' WHERE student_program_id = $1`,
        [enrolOne],
      ],
      [
        eventSql,
        [
          uuidv7(),
          T.orgId,
          enrolOne,
          T.students.one,
          // a well-formed OPENED event (the guard accepts it), so the refusal below is the row-security check itself
          'OPENED',
          null,
          'ACTIVE',
          '2024-07-01',
          'Opened by the student',
          T.users.studentOne,
        ],
      ],
      [
        enrolSql,
        [
          uuidv7(),
          T.orgId,
          T.students.one,
          ids.p1,
          ids.c2,
          T.campusId,
          T.departmentId,
          '2025-06-01',
          null,
          'ACTIVE',
          'REGULAR',
          null,
          null,
        ],
      ],
    ];
    for (const [sql, params] of attempts) {
      const r = await runAs(asStudent, sql, params);
      expect(r.error?.code, sql).toBe('42501');
    }
    // and the data is unchanged
    const after = await runAs(staffCtx(), 'SELECT status FROM app.student_programs WHERE id = $1', [
      enrolOne,
    ]);
    expect(after.rows).toEqual([{ status: 'ACTIVE' }]);
  });

  it('a student cannot read the enrolments of another student even through a join with their own record', async () => {
    const r = await runAs(
      studentCtx(T.users.studentOne),
      `SELECT sp.id FROM app.students s JOIN app.student_programs sp ON sp.student_id = s.id ORDER BY 1`,
    );
    expect(r.rows).toEqual([{ id: enrolOne }]);
  });

  // ---- the cohort / opening race at the database layer ----------------------------------------------------
  const WAITER = `it-sp-waiter-${RUN}`;
  async function waitUntilBlocked(like: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const r = await adminQuery(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = $2
            AND wait_event_type = 'Lock' AND query LIKE $1`,
        [like, WAITER],
      );
      if (r.length > 0) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`no backend ever blocked on a statement like ${like}`);
  }
  const rawClient = async (app?: string): Promise<pg.Client> => {
    const c = new pg.Client({
      connectionString: inject('dbAdminUrl'),
      ...(app ? { application_name: app } : {}),
    });
    await c.connect();
    await c.query('BEGIN');
    return c;
  };
  it('opening an ACTIVE enrolment share-locks the cohort: a concurrent cohort deactivation waits for it (then proceeds)', async () => {
    // a fresh student without an ACTIVE enrolment: studentTwo's enrolment is closed first (committed, privileged)
    const closer = await rawClient();
    await closer.query(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-01-01', exit_reason = 'Closed for the race test' WHERE id = $1`,
      [enrolTwo],
    );
    await closer.query('COMMIT');
    await closer.end();

    const opener = await rawClient();
    const closerOfCohort = await rawClient(WAITER);
    try {
      await opener.query(enrolSql, [
        uuidv7(),
        T.orgId,
        T.students.two,
        ids.p1,
        ids.c2,
        T.campusId,
        T.departmentId,
        '2025-02-01',
        null,
        'ACTIVE',
        'REGULAR',
        null,
        null,
      ]);
      const deactivation = closerOfCohort.query(
        `UPDATE app.cohorts SET status = 'CLOSED' WHERE id = $1`,
        [ids.c2],
      );
      await waitUntilBlocked('%UPDATE app.cohorts%');
      await opener.query('COMMIT'); // the opening wins; the deactivation then proceeds
      await deactivation;
      await closerOfCohort.query('COMMIT');
    } finally {
      await opener.query('ROLLBACK').catch(() => undefined);
      await closerOfCohort.query('ROLLBACK').catch(() => undefined);
      await opener.end();
      await closerOfCohort.end();
    }
    const state = await adminQuery<{ status: string }>(
      'SELECT status FROM app.cohorts WHERE id = $1',
      [ids.c2],
    );
    expect(state).toEqual([{ status: 'CLOSED' }]);
  });

  it('a cohort deactivation that COMMITTED first is seen by the next opening, which is refused (23514)', async () => {
    // c2 is CLOSED now (previous test); studentTwo has no ACTIVE enrolment other than the one opened above, so use the
    // closed cohort with a student that has none: close the opened one first.
    await adminQuery(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-03-01', exit_reason = 'Closed for the race test' WHERE student_id = $1 AND status = 'ACTIVE'`,
      [T.students.two],
    );
    const opener = await rawClient();
    try {
      await opener.query('SAVEPOINT p');
      await expect(
        opener.query(enrolSql, [
          uuidv7(),
          T.orgId,
          T.students.two,
          ids.p1,
          ids.c2,
          T.campusId,
          T.departmentId,
          '2025-04-01',
          null,
          'ACTIVE',
          'REGULAR',
          null,
          null,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'student_programs_cohort_active_ck' });
    } finally {
      await opener.query('ROLLBACK').catch(() => undefined);
      await opener.end();
    }
  });

  it('events under concurrency: two writers of the same event type serialize on the unique index (second gets 23505); a close waits for an OPENED writer and no mismatching event survives', async () => {
    const student = T.students.two;
    // c2 is CLOSED by now; use c1 (ACTIVE). Open a fresh enrolment (committed), no event yet.
    await adminQuery(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2025-05-01', exit_reason = 'Closed for the event race' WHERE student_id = $1 AND status = 'ACTIVE'`,
      [student],
    );
    const fresh = uuidv7();
    await adminQuery(enrolSql, [
      fresh,
      T.orgId,
      student,
      ids.p1,
      ids.c1,
      T.campusId,
      T.departmentId,
      '2025-06-01',
      null,
      'ACTIVE',
      'REGULAR',
      null,
      null,
    ]);
    const ev = (): unknown[] => [
      uuidv7(),
      T.orgId,
      fresh,
      student,
      'OPENED',
      null,
      'ACTIVE',
      '2025-06-01',
      'Opened for the race test',
      T.users.admin,
    ];
    const a = await rawClient();
    const b = await rawClient(WAITER);
    const closer = await rawClient(WAITER);
    try {
      await a.query(eventSql, ev());
      const second = b.query(eventSql, ev());
      second.catch(() => undefined);
      await waitUntilBlocked('%INSERT INTO app.student_program_events%');
      // a concurrent close of the enrolment waits for A's share lock taken by the guard
      const close = closer.query(
        `UPDATE app.student_programs SET status = 'DISCONTINUED', end_date = '2025-06-10', exit_reason = 'Closed for the race' WHERE id = $1`,
        [fresh],
      );
      close.catch(() => undefined);
      await waitUntilBlocked('%UPDATE app.student_programs%');
      await a.query('COMMIT');
      await expect(second).rejects.toMatchObject({
        code: '23505',
        constraint: 'student_program_events_one_opened_uq',
      });
      await close; // proceeds after A commits
      await closer.query('COMMIT');
    } finally {
      for (const c of [a, b, closer]) {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    }
    const events = await adminQuery<{ event_type: string }>(
      'SELECT event_type FROM app.student_program_events WHERE student_program_id = $1',
      [fresh],
    );
    expect(events).toEqual([{ event_type: 'OPENED' }]);
  });
});
