-- 0019_students_required_dates_contract
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students slice, Phase 2. CONTRACT step of the expand/contract pair started by 0017.
--
-- GATED: the file name ends in `_contract`, so an ordinary `pnpm db:migrate` defers it. It runs only with
-- `pnpm db:migrate --allow-contract 0019`, and (existing database) only as the FIRST migration of that invocation.
-- Run it only after the application that writes students (this phase) is deployed, every older writer is drained,
-- and an operator-approved backfill has given every legacy student row an admission_date and a status_changed_at.
--
-- This migration contains NO backfill and invents no value. It tightens the schema:
--  * VALIDATE CONSTRAINT scans the table. If any row still has a NULL, validation fails, this transaction rolls back,
--    nothing is applied and the ledger is untouched (the operator backfills and retries). Row security does not hide
--    rows from a DDL scan, so the schema owner (who sees zero tenant rows in a query) still sees them here
--    (proved on a disposable database by tests/integration/migration-0019.test.ts).
--  * SET NOT NULL then needs no further scan, because a validated `col IS NOT NULL` check proves it (PostgreSQL 12+).
--  * The two NOT VALID checks of 0017 are redundant afterwards and are dropped. From now on a missing value is
--    refused by NOT NULL (SQLSTATE 23502) instead of the check (23514).
--
-- Locks: ALTER TABLE takes ACCESS EXCLUSIVE on app.students for the validation scan. The wait for that lock is bounded;
-- the scan time itself is unmeasured (see docs/runbooks/academic-structure-rollout.md for the general caveat).

SET LOCAL lock_timeout = '5s';

ALTER TABLE app.students VALIDATE CONSTRAINT students_admission_date_ck;
ALTER TABLE app.students VALIDATE CONSTRAINT students_status_changed_at_ck;

ALTER TABLE app.students ALTER COLUMN admission_date    SET NOT NULL;
ALTER TABLE app.students ALTER COLUMN status_changed_at SET NOT NULL;

ALTER TABLE app.students DROP CONSTRAINT students_admission_date_ck;
ALTER TABLE app.students DROP CONSTRAINT students_status_changed_at_ck;
