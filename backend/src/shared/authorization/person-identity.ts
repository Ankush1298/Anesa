import type { TenantTx } from '../database/tenant-tx.js';

/**
 * Per-person serialisation of every writer that decides what kind of person an account is: a student record, an
 * employee record, or a staff role assignment (docs/architecture/v3/21-students.md §6, 20-employees.md §3.1).
 *
 * The key is EXACTLY the one migration 0016 (and 0020) take inside their triggers, so the lock a service takes first is
 * the same lock the trigger re-acquires later in the same transaction (re-entrant: no wait, no deadlock).
 *
 * LOCK ORDER (the convention every such writer must follow): this lock is the FIRST database statement of the
 * transaction's work, before any other lock (the account row, the idempotency claim, the scope rows) and before any
 * read the decision depends on. Writers that wait on this lock therefore hold nothing the holder needs.
 * Correct under READ COMMITTED only: each statement after the lock takes a fresh snapshot and sees the committed
 * outcome of the previous holder (Database.withTenant uses the default).
 */
export const PERSON_LOCK_PREFIX = 'app.person_record_exclusive:';

/** The text hashed by `hashtextextended(…, 0)`; `organization_id::text` and `user_id::text` are lower-case in SQL. */
export function personLockKey(organizationId: string, userId: string): string {
  return `${PERSON_LOCK_PREFIX}${organizationId.toLowerCase()}:${userId.toLowerCase()}`;
}

/** Blocks until no other transaction holds the person's lock; held until this transaction ends. */
export async function lockPersonIdentity(
  tx: TenantTx,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    personLockKey(organizationId, userId),
  ]);
}
