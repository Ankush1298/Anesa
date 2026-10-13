# Runbook: students contract migration 0019 and the person-identity backstop 0020

Status: **design and checklist only. Nothing in this document has been run against any persistent or production database.** The migration and its tests have only run on disposable databases.

`0019_students_required_dates_contract.sql` is the CONTRACT step of the expand/contract pair started by `0017_students_record_fields.sql`. It validates the two `NOT VALID` checks on `app.students`, sets `NOT NULL` on `admission_date` and `status_changed_at`, and drops the checks. It contains **no backfill** and invents no value.

## 1. Why it is gated

The file name ends in `_contract`, so an ordinary `pnpm db:migrate` defers it. It runs only with `pnpm db:migrate --allow-contract 0019` (no `--` before the flag), and on an existing database only as the **first** migration of that invocation: it cannot be bundled with pending ordinary migrations (`0010`–`0018`). `contractVersions()` is derived from the file names, so it now returns `0009` and `0019`; disposable test databases pass both on an empty ledger, which the runner exempts.

Typical sequence on a database at `0008`: `pnpm db:migrate --allow-contract 0009` applies `0009`–`0018` and defers `0019` **and `0020`**; `0019` is a later, separate invocation, and it applies `0020` right after itself (see §6).

## 2. Preconditions (operator responsibility; the ledger cannot prove them)

1. The application that writes students through `POST /api/v1/students` (this phase) is deployed everywhere, and every older writer of `app.students` is drained. Anything that still inserts a student without `admission_date` will fail once `NOT NULL` is set.
2. **Every existing student row has `admission_date` and `status_changed_at`.** The migration neither guesses nor backfills them. If rows exist from before `0017`, the backfill rule (what date counts as the admission date, and what `status_changed_at` should be) is a **business decision recorded in the change record** and applied by the operator outside the migration.
3. Read-only preflight, run as a superuser or `BYPASSRLS` role (`app_migrator` sees zero tenant rows because the tables are `FORCE ROW LEVEL SECURITY`):

```sql
-- must both be 0 before running 0019
SELECT count(*) FROM app.students WHERE admission_date IS NULL;
SELECT count(*) FROM app.students WHERE status_changed_at IS NULL;
-- ledger must read 0001 .. 0018 and nothing else
SELECT version FROM platform.schema_migrations ORDER BY version;
```

   These statements have not been executed on a real server.
4. Roles for new students: existing tenants need `seedTenantRoles` re-run to receive `student.record.create` (added by `0017`). Until then no role holds it and creation is refused (fail closed).

## 3. Applying it

```
pnpm db:migrate --allow-contract 0019
```

Expected: `0019` applied first and `0020` (§6) right after it in the same invocation (`0020` is not a contract migration, so it needs no opt-in of its own), ledger `0001`–`0020`. `ALTER TABLE` takes `ACCESS EXCLUSIVE` on `app.students` for the validation scan; the wait for the lock is bounded by `lock_timeout = 5s`, the scan time is **unmeasured**.

## 4. If it fails

The whole migration is one transaction: nothing is applied and the ledger is untouched. `SQLSTATE 23514` with `students_admission_date_ck` or `students_status_changed_at_ck` means a NULL remains: find the rows with the preflight query, backfill by the approved rule, retry. `55P03` means the lock could not be taken in 5 s: find the long transaction, retry later. Never edit an applied migration, never edit the ledger, never relax row security.

## 5. After it

`NOT NULL` replaces the checks: a missing `admission_date` is refused with `23502` instead of `23514`. There is no rollback (forward-only migrations); a later migration could drop `NOT NULL`, which would be a new, reviewed change.

## 6. Migration 0020: the database backstop of the person-identity invariant

`0020_student_staff_role_exclusivity.sql` adds triggers on `app.role_assignments` and `app.students` that enforce, for every writer (including privileged ones), that an account with a student record has no **staff-capable role assignment**. It is a new file; `0016`–`0019` are unchanged. The services already enforce the same rule and take the same per-person advisory lock (`shared/authorization/person-identity.ts`); the triggers are the backstop.

**Rollout boundary, stated precisely.** `0020` is not a `_contract` migration, but the runner defers every migration that follows a deferred contract migration. Therefore:

- an ordinary `pnpm db:migrate` and `pnpm db:migrate --allow-contract 0009` leave `0019` **and `0020`** deferred (`blockedBy` `0019`);
- `0020` is applied only by `pnpm db:migrate --allow-contract 0019` (after `0019`, in the same invocation), or by a later plain `pnpm db:migrate` once `0019` is in the ledger;
- **until then the database backstop is INACTIVE.** The invariant is protected only by the service checks and the per-person lock, which a privileged or raw writer (seed script, DBA session, a future importer) does not go through.

**Staff-capable assignment** (the single predicate: `AuthorizationEngine.hasStaffCapableAssignment`, the two trigger functions, and the query below): a row of `app.role_assignments` whose role code is **not** `STUDENT`, with `status = 'ACTIVE'` and `valid_until` either NULL or in the future. `valid_from` is ignored, so a future-dated active assignment conflicts. Revoked, expired and ended-window rows do not. A `STUDENT`-role assignment never conflicts.

## Person-identity preflight (read-only; run before applying 0020)

The triggers are forward-only: they prevent new violations and neither reject nor change existing rows. Run this as a superuser or `BYPASSRLS` role (the tables are `FORCE ROW LEVEL SECURITY`; `app_migrator` sees zero tenant rows). **Zero rows is the expected result.** There is no automatic remediation: each row is a business decision (revoke the assignment through `RoleAssignmentService`, or leave the student record), recorded in the change record.

```sql
SELECT s.organization_id, s.user_id, s.id AS student_id,
       ra.id AS assignment_id, r.code AS role_code, ra.status, ra.valid_from, ra.valid_until
  FROM app.students s
  JOIN app.role_assignments ra ON ra.organization_id = s.organization_id AND ra.user_id = s.user_id
  JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
 WHERE r.code <> 'STUDENT'
   AND ra.status = 'ACTIVE'
   AND (ra.valid_until IS NULL OR ra.valid_until > now())
 ORDER BY s.organization_id, s.user_id, ra.id;
```

This statement has not been executed on a real server; `tests/integration/person-identity-invariant.test.ts` runs it, extracted from this file, on disposable databases and compares it with the engine and the triggers.

An existing account that holds BOTH a student and an employee record (left by data older than `0016`) is a separate pre-existing gap and is not covered by this query.

Not done and not automatic: `0020` does not backfill, validate or alter any row; it does not make `RoleAssignmentService.grant`'s rule "a `STUDENT` role requires a student record" a database rule (that is a service rule only).
