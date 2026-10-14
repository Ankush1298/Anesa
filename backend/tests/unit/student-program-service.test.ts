import { describe, expect, it } from 'vitest';
import { StudentProgramService } from '../../src/modules/students/student-program.service.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { registerIssued } from '../../src/shared/tenancy/context-registry.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';

// A student row with a NULL admission_date cannot be built in a database that ran the 0019 contract migration (NOT NULL),
// so that refusal is pinned here against a scripted transaction. The script answers by SQL text and records every
// statement, so the test can also prove that nothing was written.
function script() {
  const statements: string[] = [];
  const dept = uuidv7();
  const campus = uuidv7();
  const tx = {
    query: (sql: string) => {
      statements.push(sql);
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('role_permissions')) {
        return rows([{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }]);
      }
      if (sql.includes('FROM app.programs p'))
        return rows([{ department_id: dept, campus_id: campus }]);
      if (sql.includes('INSERT INTO app.idempotency_keys')) return rows([{ key: 'k' }]);
      if (sql.includes('FROM app.students'))
        return rows([{ status: 'ACTIVE', admission_date: null }]);
      if (sql.includes('FROM app.campuses')) return rows([{ today: '2026-01-01' }]);
      if (/FROM app\.(departments|programs|cohorts)/.test(sql)) return rows([{ status: 'ACTIVE' }]);
      return rows([]);
    },
  };
  return { tx, statements };
}

describe('StudentProgramService.open: a student without an admission date', () => {
  it('is refused with 409 and a generic message, and nothing is written', async () => {
    const { tx, statements } = script();
    const ctx = issueTrustedContext({ tenantId: uuidv7(), userId: uuidv7(), actorKind: 'STAFF' });
    const err: unknown = await StudentProgramService.open(
      tx as never,
      ctx,
      uuidv7(),
      {
        programId: uuidv7(),
        cohortId: uuidv7(),
        startDate: '2024-08-01',
        reason: 'Admitted to the program',
      },
      { idempotencyKey: 'a'.repeat(24) },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409 });
    expect((err as Error).message).toBe('The student cannot be enrolled in a program.');
    expect((err as Error).message).not.toMatch(/admission|ACTIVE|status/i);
    expect(statements.some((s) => /INSERT INTO app\.student_program/.test(s))).toBe(false);
  });
});

// The staff-actor guard runs before the permission lookup, the idempotency claim and every row lock, so the scripted
// transaction must see no statement at all for a non-STAFF actor.
describe('StudentProgramService: only STAFF actors reach the database', () => {
  const ids = () => ({ tenantId: uuidv7(), userId: uuidv7() });
  const forged = (): TrustedContext => {
    // The issuer rejects unknown kinds; register a forged one the way a future ActorKind could appear.
    const ctx = Object.freeze({ ...ids(), actorKind: 'AI' }) as unknown as TrustedContext;
    registerIssued(ctx);
    return ctx;
  };
  const contexts: [string, () => TrustedContext][] = [
    ['STUDENT', () => issueTrustedContext({ ...ids(), actorKind: 'STUDENT' })],
    ['an unknown kind', forged],
  ];
  const openInput = {
    programId: uuidv7(),
    cohortId: uuidv7(),
    startDate: '2024-08-01',
    reason: 'Admitted to the program',
  };
  const closeInput = { outcome: 'COMPLETED' as const, endDate: '2024-09-01', reason: 'Finished' };

  it.each(contexts)('open refuses %s with 403 before any statement', async (_name, make) => {
    const { tx, statements } = script();
    const err: unknown = await StudentProgramService.open(
      tx as never,
      make(),
      uuidv7(),
      openInput,
      { idempotencyKey: 'a'.repeat(24) },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements).toEqual([]);
  });

  it.each(contexts)('close refuses %s with 403 before any statement', async (_name, make) => {
    const { tx, statements } = script();
    const err: unknown = await StudentProgramService.close(
      tx as never,
      make(),
      uuidv7(),
      closeInput,
      { expected: { type: 'exists' } },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements).toEqual([]);
  });

  it('an untrusted context is still 500 (the trusted-context check comes first)', async () => {
    const { tx, statements } = script();
    const fake = { ...ids(), actorKind: 'STAFF' } as unknown as TrustedContext;
    const err: unknown = await StudentProgramService.open(tx as never, fake, uuidv7(), openInput, {
      idempotencyKey: 'a'.repeat(24),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 500, code: 'UNTRUSTED_CONTEXT' });
    expect(statements).toEqual([]);
  });
});
