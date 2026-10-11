import { afterAll, describe, expect, inject, it } from 'vitest';
import { NumberSequenceService } from '../../src/shared/numbering/number-sequence.service.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, ORG_A, ORG_C, STAFF_A, type Ctx } from '../support/fixtures.js';

// Max pool size to accommodate concurrent transaction tests
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 25 });
const db = new Database(pool);

afterAll(async () => {
  await db.close();
});

class Rollback extends Error {}

const ctxOf = (a: Ctx): TrustedContext =>
  issueTrustedContext({ tenantId: a.tenant, userId: a.user, actorKind: a.kind });

describe('NumberSequenceEngine Integration', () => {
  describe('first-allocation and sequential progression', () => {
    it('returns 1 for an unseeded sequence, and increments strictly monotonically', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.mono.${Date.now()}`;
      const period = '2026';

      await db.withTenant(ctx, async (tx) => {
        // First allocation is 1n
        const val1 = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val1).toBe(1n);

        // Sequential allocations are 2n, 3n, 4n
        const val2 = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val2).toBe(2n);

        const val3 = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val3).toBe(3n);

        const val4 = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val4).toBe(4n);
      });
    });
  });

  describe('concurrency guarantees', () => {
    it('handles 20 concurrent first allocations without errors, gaps, or duplicates', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.concur.first.${Date.now()}`;
      const period = '2026';

      // Launch 20 concurrent transactions trying to allocate simultaneously on an unseeded sequence
      const tasks = Array.from({ length: 20 }, () =>
        db.withTenant(ctx, async (tx) => {
          return NumberSequenceService.next(tx, ctx, { key, period });
        }),
      );

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(20);

      // Verify all 20 allocations are unique and range from 1n to 20n
      const sorted = [...results].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const expected = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
      expect(sorted).toEqual(expected);

      // Subsequent allocation returns 21n
      await db.withTenant(ctx, async (tx) => {
        const nextVal = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(nextVal).toBe(21n);
      });
    });

    it('handles 20 concurrent allocations on an existing row correctly', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.concur.existing.${Date.now()}`;
      const period = '2026';

      // Seed row with first allocation
      await db.withTenant(ctx, async (tx) => {
        const first = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(first).toBe(1n);
      });

      // Launch 20 concurrent allocations
      const tasks = Array.from({ length: 20 }, () =>
        db.withTenant(ctx, async (tx) => {
          return NumberSequenceService.next(tx, ctx, { key, period });
        }),
      );

      const results = await Promise.all(tasks);
      const sorted = [...results].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const expected = Array.from({ length: 20 }, (_, i) => BigInt(i + 2));
      expect(sorted).toEqual(expected);
    });
  });

  describe('transactional rollback and reusability', () => {
    it('does not consume a sequence number if the transaction rolls back', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.rollback.${Date.now()}`;
      const period = '2026';

      // Transaction 1: Allocates 1n and then aborts/rolls back
      await expect(
        db.withTenant(ctx, async (tx) => {
          const val = await NumberSequenceService.next(tx, ctx, { key, period });
          expect(val).toBe(1n);
          throw new Rollback('Business operation failed');
        }),
      ).rejects.toThrow(Rollback);

      // Transaction 2: Allocates on the same sequence -> receives 1n (reused!)
      await db.withTenant(ctx, async (tx) => {
        const val = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val).toBe(1n);
      });

      // Transaction 3: Allocates 2n, then rolls back
      await expect(
        db.withTenant(ctx, async (tx) => {
          const val = await NumberSequenceService.next(tx, ctx, { key, period });
          expect(val).toBe(2n);
          throw new Rollback('Second rollback');
        }),
      ).rejects.toThrow(Rollback);

      // Transaction 4: Allocates again -> receives 2n (reused!)
      await db.withTenant(ctx, async (tx) => {
        const val = await NumberSequenceService.next(tx, ctx, { key, period });
        expect(val).toBe(2n);
      });
    });
  });

  describe('key and period independence', () => {
    it('isolates different keys and periods within the same tenant', async () => {
      const ctx = ctxOf(CTX.staffC);
      const periodA = '2025';
      const periodB = '2026';
      const key1 = `test.seq.key1.${Date.now()}`;
      const key2 = `test.seq.key2.${Date.now()}`;

      await db.withTenant(ctx, async (tx) => {
        expect(await NumberSequenceService.next(tx, ctx, { key: key1, period: periodA })).toBe(1n);
        expect(await NumberSequenceService.next(tx, ctx, { key: key1, period: periodA })).toBe(2n);

        // Same key, different period starts at 1
        expect(await NumberSequenceService.next(tx, ctx, { key: key1, period: periodB })).toBe(1n);

        // Different key, same period starts at 1
        expect(await NumberSequenceService.next(tx, ctx, { key: key2, period: periodA })).toBe(1n);
      });
    });
  });

  describe('tenant isolation (RLS)', () => {
    it('strictly isolates number sequences across tenants', async () => {
      const ctxA = ctxOf(CTX.staffA); // ORG_A
      const ctxB = ctxOf(CTX.staffB); // ORG_B
      const key = `test.seq.iso.${Date.now()}`;
      const period = '2026';

      // Tenant A allocates 1n, 2n
      await db.withTenant(ctxA, async (tx) => {
        expect(await NumberSequenceService.next(tx, ctxA, { key, period })).toBe(1n);
        expect(await NumberSequenceService.next(tx, ctxA, { key, period })).toBe(2n);
      });

      // Tenant B allocates on the exact same key & period: starts at 1n!
      await db.withTenant(ctxB, async (tx) => {
        expect(await NumberSequenceService.next(tx, ctxB, { key, period })).toBe(1n);
      });

      // Subsequent allocations confirm independent counter state per tenant
      await db.withTenant(ctxA, async (tx) => {
        expect(await NumberSequenceService.next(tx, ctxA, { key, period })).toBe(3n);
      });
      await db.withTenant(ctxB, async (tx) => {
        expect(await NumberSequenceService.next(tx, ctxB, { key, period })).toBe(2n);
      });
    });
  });

  describe('bigint overflow protection', () => {
    it('guards against bigint overflow in SQL and throws 409 without aborting transaction', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.overflow.${Date.now()}`;
      const period = '2026';
      const MAX_BIGINT = '9223372036854775807';

      // Admin seeds the sequence directly at MAX_BIGINT
      await adminQuery(
        `INSERT INTO app.number_sequences (organization_id, key, period, next_value)
         VALUES ($1, $2, $3, $4::bigint)`,
        [ORG_C, key, period, MAX_BIGINT],
      );

      // Attempting to allocate must throw SEQUENCE_OVERFLOW without aborting the transaction
      await db.withTenant(ctx, async (tx) => {
        await expect(NumberSequenceService.next(tx, ctx, { key, period })).rejects.toMatchObject({
          statusCode: 409,
          code: 'SEQUENCE_OVERFLOW',
        });

        // CRITICAL INVARIANT: The transaction was NOT aborted by PostgreSQL.
        // A subsequent query in the SAME transaction must succeed.
        const probe = await tx.query<{ ok: number }>('SELECT 1 AS ok');
        expect(probe.rows[0]?.ok).toBe(1);
      });
    });
  });

  describe('validation and context security', () => {
    it('refuses untrusted context before querying', async () => {
      const ctx = ctxOf(CTX.staffC);
      const unbranded = {
        tenantId: ORG_C,
        userId: STAFF_A,
        actorKind: 'STAFF' as const,
      };

      await db.withTenant(ctx, async (tx) => {
        await expect(
          // @ts-expect-error testing untrusted context runtime guard
          NumberSequenceService.next(tx, unbranded, { key: 'foo', period: '2026' }),
        ).rejects.toMatchObject({
          statusCode: 500,
          code: 'UNTRUSTED_CONTEXT',
        });
      });
    });

    it.each([
      ['empty key', '', '2026'],
      ['uppercase key', 'Student.Admission', '2026'],
      ['special characters in key', 'student/admission', '2026'],
      ['key exceeding 100 characters', 'a'.repeat(101), '2026'],
      ['empty period', 'student.admission', ''],
      ['period exceeding 50 characters', 'student.admission', 'x'.repeat(51)],
      ['invalid period characters', 'student.admission', '2026/27'],
    ])('rejects invalid inputs: %s', async (_desc, key, period) => {
      const ctx = ctxOf(CTX.staffC);
      await db.withTenant(ctx, async (tx) => {
        await expect(NumberSequenceService.next(tx, ctx, { key, period })).rejects.toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      });
    });
  });

  describe('triggers: touch and immutability', () => {
    it('increments version and touch timestamp on each allocation', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.touch.${Date.now()}`;
      const period = '2026';

      await db.withTenant(ctx, async (tx) => {
        await NumberSequenceService.next(tx, ctx, { key, period });
      });

      const [row1] = await adminQuery<{ version: number }>(
        `SELECT version FROM app.number_sequences WHERE organization_id = $1 AND key = $2 AND period = $3`,
        [ORG_C, key, period],
      );
      expect(row1?.version).toBe(1);

      await db.withTenant(ctx, async (tx) => {
        await NumberSequenceService.next(tx, ctx, { key, period });
      });

      const [row2] = await adminQuery<{ version: number }>(
        `SELECT version FROM app.number_sequences WHERE organization_id = $1 AND key = $2 AND period = $3`,
        [ORG_C, key, period],
      );
      expect(row2?.version).toBe(2);
    });

    it('enforces immutable keys trigger on organization_id', async () => {
      const ctx = ctxOf(CTX.staffC);
      const key = `test.seq.immut.${Date.now()}`;
      const period = '2026';

      await db.withTenant(ctx, async (tx) => {
        await NumberSequenceService.next(tx, ctx, { key, period });
      });

      // Admin attempt to modify organization_id must trigger app.enforce_immutable_keys()
      await expect(
        adminQuery(
          `UPDATE app.number_sequences SET organization_id = $1 WHERE organization_id = $2 AND key = $3`,
          [ORG_A, ORG_C, key],
        ),
      ).rejects.toMatchObject({
        code: '23001', // restrict_violation
      });
    });
  });
});
