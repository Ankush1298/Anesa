# Runbook: students contract migration 0019

Status: **design and checklist only. Nothing in this document has been run against any persistent or production database.** The migration and its tests have only run on disposable databases.

`0019_students_required_dates_contract.sql` is the CONTRACT step of the expand/contract pair started by `0017_students_record_fields.sql`. It validates the two `NOT VALID` checks on `app.students`, sets `NOT NULL` on `admission_date` and `status_changed_at`, and drops the checks. It contains **no backfill** and invents no value.

## 1. Why it is gated

The file name ends in `_contract`, so an ordinary `pnpm db:migrate` defers it. It runs only with `pnpm db:migrate --allow-contract 0019` (no `--` before the flag), and on an existing database only as the **first** migration of that invocation: it cannot be bundled with pending ordinary migrations (`0010`–`0018`). `contractVersions()` is derived from the file names, so it now returns `0009` and `0019`; disposable test databases pass both on an empty ledger, which the runner exempts.

Typical sequence on a database at `0008`: `pnpm db:migrate --allow-contract 0009` applies `0009`–`0018` and defers `0019`; `0019` is a later, separate invocation.

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

Expected: `0019` applied alone, ledger `0001`–`0019`. `ALTER TABLE` takes `ACCESS EXCLUSIVE` on `app.students` for the validation scan; the wait for the lock is bounded by `lock_timeout = 5s`, the scan time is **unmeasured**.

## 4. If it fails

The whole migration is one transaction: nothing is applied and the ledger is untouched. `SQLSTATE 23514` with `students_admission_date_ck` or `students_status_changed_at_ck` means a NULL remains: find the rows with the preflight query, backfill by the approved rule, retry. `55P03` means the lock could not be taken in 5 s: find the long transaction, retry later. Never edit an applied migration, never edit the ledger, never relax row security.

## 5. After it

`NOT NULL` replaces the checks: a missing `admission_date` is refused with `23502` instead of `23514`. There is no rollback (forward-only migrations); a later migration could drop `NOT NULL`, which would be a new, reviewed change.
