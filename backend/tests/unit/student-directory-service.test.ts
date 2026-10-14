import { describe, expect, it } from 'vitest';
import { StudentDirectoryService } from '../../src/modules/students/student-directory.service.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { registerIssued } from '../../src/shared/tenancy/context-registry.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';

// The actor-kind guard runs before any statement. A scripted transaction records every query, so the tests prove both
// the refusal and that nothing (no grant lookup, no directory query) ran for a non-STAFF actor.
function script() {
  const statements: string[] = [];
  const row = {
    id: uuidv7(),
    admission_number: 'ADM-1',
    display_name: 'Ada',
    status: 'ACTIVE',
    has_active_enrolment: false,
  };
  const tx = {
    query: (sql: string) => {
      statements.push(sql);
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('role_permissions')) {
        return rows([{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }]);
      }
      if (sql.includes('FROM app.students')) return rows([row]);
      return rows([]);
    },
  };
  return { tx, statements };
}

const ids = () => ({ tenantId: uuidv7(), userId: uuidv7() });

describe('StudentDirectoryService.findByAdmissionNumber: actor kind', () => {
  it('refuses a STUDENT actor with 403 before running any statement', async () => {
    const { tx, statements } = script();
    const ctx = issueTrustedContext({ ...ids(), actorKind: 'STUDENT' });
    const err = await StudentDirectoryService.findByAdmissionNumber(
      tx as never,
      ctx,
      'ADM-1',
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements).toEqual([]);
  });

  it('refuses an unknown actor kind (fails closed, never treated as "no enrolments")', async () => {
    const { tx, statements } = script();
    // The issuer rejects unknown kinds, so register a forged-kind context the way a future ActorKind could appear.
    const forged = Object.freeze({ ...ids(), actorKind: 'AI' }) as unknown as TrustedContext;
    registerIssued(forged);
    const err = await StudentDirectoryService.findByAdmissionNumber(
      tx as never,
      forged,
      'ADM-1',
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements).toEqual([]);
  });

  it('still returns the entry for an authorized STAFF actor', async () => {
    const { tx, statements } = script();
    const ctx = issueTrustedContext({ ...ids(), actorKind: 'STAFF' });
    const res = await StudentDirectoryService.findByAdmissionNumber(tx as never, ctx, 'ADM-1');
    expect(res).toMatchObject({
      admissionNumber: 'ADM-1',
      displayName: 'Ada',
      hasActiveEnrolment: false,
    });
    expect(statements.some((s) => s.includes('FROM app.students'))).toBe(true);
  });
});

describe('AuthorizationEngine.assertStaffActor', () => {
  it('passes STAFF and refuses STUDENT and an unknown kind with 403, without any query', () => {
    expect(() =>
      AuthorizationEngine.assertStaffActor(issueTrustedContext({ ...ids(), actorKind: 'STAFF' })),
    ).not.toThrow();
    expect(() =>
      AuthorizationEngine.assertStaffActor(issueTrustedContext({ ...ids(), actorKind: 'STUDENT' })),
    ).toThrow(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
    const forged = Object.freeze({ ...ids(), actorKind: 'AI' }) as unknown as TrustedContext;
    registerIssued(forged);
    expect(() => AuthorizationEngine.assertStaffActor(forged)).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it('refuses a context that was not issued by the trusted issuer', () => {
    const fake = { ...ids(), actorKind: 'STAFF' } as unknown as TrustedContext;
    expect(() => AuthorizationEngine.assertStaffActor(fake)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'UNTRUSTED_CONTEXT' }),
    );
  });
});
