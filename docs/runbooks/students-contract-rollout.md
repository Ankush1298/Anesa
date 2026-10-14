# Runbook: students contract migration 0019 and the subsequent migrations 0020–0023

Status: **design and checklist only. Nothing in this document has been run against any persistent or production database.** The migration and its tests have only run on disposable databases.

`0019_students_required_dates_contract.sql` is the CONTRACT step of the expand/contract pair started by `0017_students_record_fields.sql`. It validates the two `NOT VALID` checks on `app.students`, sets `NOT NULL` on `admission_date` and `status_changed_at`, and drops the checks. It contains **no backfill** and invents no value.

## 1. Why it is gated

The file name ends in `_contract`, so an ordinary `pnpm db:migrate` defers it. It runs only with `pnpm db:migrate --allow-contract 0019` (no `--` before the flag), and on an existing database only as the **first** migration of that invocation: it cannot be bundled with pending ordinary migrations (`0010`–`0018`). `contractVersions()` is derived from the file names, so it now returns `0009` and `0019`; disposable test databases pass both on an empty ledger, which the runner exempts.

Typical sequence on a database at `0008`: `pnpm db:migrate --allow-contract 0009` applies `0009`–`0018` and defers `0019` **and `0020`–`0023`**; `0019` is a later, separate invocation, and it applies `0020`–`0023` right after itself (see §6 for `0020`; the header of `database/migrations/0021_student_programs.sql` and §6a of `docs/architecture/v3/21-students.md` for `0021`; and §2 items 5–6 for `0022`–`0023`).

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
5. Roles for program enrolment: migration `0022` registers `student.program.assign` (SENSITIVE; `GRANTED` to `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`). Registration must come first: `seedTenantRoles` only syncs permissions already present in `platform.permissions`, so a re-seed before `0022` silently skips the grant. After `0022`, existing tenants need `seedTenantRoles` re-run to receive it; until then no role holds it and the enrolment service (Step 2B) refuses with 403 (fail closed). `0022` is deferred behind `0019` like `0020` and `0021`. The re-seed changes tenant role data and needs its own explicit authorisation; it has not been run.
6. Roles for the student directory lookup: migration `0023` registers `student.directory.search` (SENSITIVE; `GRANTED` to `HOD`, `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`). Same ordering rule as item 5: apply `0023` **first**, then re-run `seedTenantRoles` (it only syncs permissions already in `platform.permissions`, so a re-seed before `0023` silently skips the grant). `0023` is deferred behind `0019` like `0020`–`0022`, and is applied by `pnpm db:migrate --allow-contract 0019` after `0019`–`0022`. Until the re-seed, no role holds the permission and `GET /api/v1/students?admissionNumber=` refuses with 403 (fail closed). The re-seed changes tenant role data and needs its own explicit authorisation; it has not been run.
7. **Which build is live when the migration runs.** Before `pnpm db:migrate --allow-contract 0019`, the build deployed for item 1 must be one that does **not** query `app.student_programs` (no student-program enrolment or student-directory code). Do not deploy the current student-program/directory build until migration `0021` has been applied (in practice, until the ledger reads `0023`). If it goes live too early, these existing operations are expected to fail with HTTP 500 because the relation `app.student_programs` does not exist: department deactivation (`DepartmentService.update`, status ACTIVE to INACTIVE), department soft-delete (`DepartmentService.softDelete`), and a cohort status change away from ACTIVE (`CohortService.update`). The failed request rolls back and writes nothing. This comes from reading the current code (`department.service.ts`, `academic.service.ts`, `shared/http/hardening.ts`); it has not been run against a database without `0021`.
8. **Preflight order.** The command in §3 also applies `0020` in the same invocation, so the person-identity preflight (the SQL under "Person-identity preflight", after §6) must be completed, with zero rows or each row resolved, **before** running the §3 command, in addition to the NULL-date check and approved backfill of items 2 and 3 for `0019`.

## 3. Applying it

```
pnpm db:migrate --allow-contract 0019
```

Expected: `0019` applied first and `0020` (§6) right after it in the same invocation, followed by `0021`–`0023` (none is a contract migration, so none needs an opt-in of its own), ledger `0001`–`0023`. `ALTER TABLE` takes `ACCESS EXCLUSIVE` on `app.students` for the validation scan; the wait for the lock is bounded by `lock_timeout = 5s`, the scan time is **unmeasured**.

After the command succeeds, in this order:

1. Verify the ledger reads `0001`–`0023` and that `student.program.assign` and `student.directory.search` are present in `platform.permissions` (read-only checks, as a superuser or `BYPASSRLS` role). If the run stopped early, do not deploy the current build (see §4).
2. Deploy the current student-program/directory build. Until the reseed, the new routes refuse every caller with 403 (fail closed).
3. Run `seedTenantRoles` for each existing tenant **using that current build**, as a separately authorised operation; it changes tenant role data and **has not been run**. Never run the seed from an older build once these grants exist: it deletes `role_permissions` rows that are not in its own role matrix, which would remove the new grants.

This order is derived from reading the code and migrations. It has not been validated against a real deployment, and nothing in this document has been run against any persistent or production database.

## 4. If it fails

Each migration runs in its own transaction. A failing migration rolls back its own SQL and its ledger insert, migrations that already committed earlier in the same invocation stay applied and recorded, and later migrations do not run. The runner throws instead of returning its applied list, so read `platform.schema_migrations` to see how far it got. If `0019` itself fails: `SQLSTATE 23514` with `students_admission_date_ck` or `students_status_changed_at_ck` means a NULL remains: find the rows with the preflight query, backfill by the approved rule, retry. `55P03` means the lock could not be taken in 5 s: find the long transaction, retry later. Never edit an applied migration, never edit the ledger, never relax row security.

## 5. After it

`NOT NULL` replaces the checks: a missing `admission_date` is refused with `23502` instead of `23514`. There is no rollback (forward-only migrations); a later migration could drop `NOT NULL`, which would be a new, reviewed change.

**Application rollback after enrolments exist.** The database does not stop a department or cohort with an ACTIVE enrolment from being deactivated; that rule lives only in the application (`DepartmentService.update` / `softDelete`, `CohortService.update`). If the application is rolled back to a build without those guards once enrolments exist, department deactivation, department soft-delete and cohort status changes away from ACTIVE could succeed while ACTIVE enrolments reference them. During such a rollback, freeze those operations unless equivalent protection has been independently verified. This is a code-reading conclusion, not a tested rollback procedure.

## 6. Migration 0020: the database backstop of the person-identity invariant

`0020_student_staff_role_exclusivity.sql` adds triggers on `app.role_assignments` and `app.students` that enforce, for every writer (including privileged ones), that an account with a student record has no **staff-capable role assignment**. It is a new file; `0016`–`0019` are unchanged. The services already enforce the same rule and take the same per-person advisory lock (`shared/authorization/person-identity.ts`); the triggers are the backstop.

**Rollout boundary, stated precisely.** `0019` is the contract migration (its name ends in `_contract`), so it runs only when named with `--allow-contract 0019`. `0020`–`0023` are not `_contract` migrations, but the runner defers every migration that follows a deferred contract migration. Therefore:

- an ordinary `pnpm db:migrate` and `pnpm db:migrate --allow-contract 0009` leave `0019` **and `0020`–`0023`** deferred (`blockedBy` `0019`);
- `0020`–`0023` are applied only by `pnpm db:migrate --allow-contract 0019` (after `0019`, in order, in the same invocation), or by a later plain `pnpm db:migrate` once `0019` is in the ledger;
- **until then the `0020` database backstop is INACTIVE.** The invariant is protected only by the service checks and the per-person lock, which a privileged or raw writer (seed script, DBA session, a future importer) does not go through.

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
