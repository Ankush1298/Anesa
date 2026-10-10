import { AppError } from '../errors/http-errors.js';
import type { TenantTx } from '../database/index.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';

export interface AllocateSequenceOptions {
  readonly key: string;
  readonly period: string;
}

const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const KEY_MAX_LENGTH = 100;
const PERIOD_RE = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Number Sequence Engine (docs/architecture/v3/02 §4.2, 08 §5, 11 §5.3).
 *
 * Provides atomic, monotonic sequence allocation per `(organization_id, key, period)`
 * within the caller's active database transaction (`TenantTx`).
 *
 * Invariants:
 *  - First allocation for an unseeded sequence returns `1n`.
 *  - Subsequent successful allocations return unique, strictly increasing integers.
 *  - Uses a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement.
 *  - Handles concurrent first allocations without unique-constraint aborts under PostgreSQL READ COMMITTED.
 *  - Rolls back with the enclosing transaction: uncommitted allocations are NOT consumed.
 *  - Guards against `bigint` arithmetic overflow in SQL without aborting the transaction.
 *  - Strictly internal service: no public routes or endpoints.
 */
export class NumberSequenceService {
  /**
   * Allocates the next monotonic sequence integer for the given (key, period)
   * within the caller's current tenant transaction.
   */
  static async next(
    tx: TenantTx,
    ctx: TrustedContext,
    options: AllocateSequenceOptions,
  ): Promise<bigint> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    const { key, period } = options;

    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > KEY_MAX_LENGTH ||
      !KEY_RE.test(key)
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Invalid sequence key "${key}". Key must be 1-${KEY_MAX_LENGTH} lowercase dot-separated segments.`,
      );
    }

    if (
      typeof period !== 'string' ||
      period.length === 0 ||
      period.length > 50 ||
      !PERIOD_RE.test(period)
    ) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Invalid sequence period "${period}". Period must be 1-50 alphanumeric characters, "-" or "_".`,
      );
    }

    // Atomic allocation statement:
    //  - If row is missing: INSERT sets next_value = 2 and returns 2 - 1 = 1.
    //  - If row exists: DO UPDATE sets next_value = next_value + 1 and returns (new_next_value - 1).
    //  - If row exists at MAX_BIGINT (9223372036854775807): WHERE condition fails, update is skipped,
    //    and 0 rows are returned without aborting the transaction block.
    const res = await tx.query<{ allocated_value: string }>(
      `INSERT INTO app.number_sequences (organization_id, key, period, next_value)
       VALUES ($1, $2, $3, 2)
       ON CONFLICT (organization_id, key, period)
       DO UPDATE
         SET next_value = app.number_sequences.next_value + 1
         WHERE app.number_sequences.next_value < 9223372036854775807
       RETURNING (app.number_sequences.next_value - 1)::text AS allocated_value`,
      [ctx.tenantId, key, period],
    );

    if (res.rows.length === 0) {
      throw new AppError(
        409,
        'SEQUENCE_OVERFLOW',
        `Sequence "${key}" for period "${period}" has reached maximum capacity.`,
      );
    }

    const row = res.rows[0];
    if (!row || typeof row.allocated_value !== 'string') {
      throw new AppError(500, 'INTERNAL_ERROR', 'Failed to allocate sequence value.');
    }

    return BigInt(row.allocated_value);
  }
}
