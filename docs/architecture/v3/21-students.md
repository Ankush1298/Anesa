# 21 — Students (Milestone 1, Phase 1D) — Phase 1: schema and authorization foundation

Status: **Phase 1 only.** This document describes what migration `0017` and the permission catalog change implement, and the rules the later phases must respect. There is **no student service, no student route and no student HTTP endpoint yet.** Application code only **reads** `app.students`, in three places that already existed: `auth.service` (to derive the actor kind), the `SELF` resolver in the authorization engine, and the exclusivity pre-check in `EmployeeService.create`. Nothing in `backend/src` writes it.

Implementation: migration `0017_students_record_fields.sql`; `shared/authorization/catalog.ts` and `role-matrix.ts`. Specification baseline: `02` §4.4 (`students`) and §6.1 (identifier policy), `06` (authorization model), `10` §1 row 26, ADR-003 and its amendments, `20-employees.md` §3.1 (person-record exclusivity).

## 1. Student record and status ownership

`app.students` is the student **role record** of a login account (ADR-003): `id` (UUIDv7, permanent), `organization_id`, `user_id` (unique per organization), `admission_number` (unique per organization), `status`, `version`, `created_at`, `updated_at`, plus, from `0017`:

| Column | Nullability / default | Why it exists in Phase 1 |
|---|---|---|
| `admission_date date` | **nullable**, no default | Required by `02` §4.4. The service will require it on create. Existing rows are **not** given an invented date. |
| `status_changed_at timestamptz` | **nullable for existing rows**; default `now()` for new rows | Required by `02` §4.4. The default is attached after the column is added, so existing rows are not stamped with the time of the migration. A trigger sets it whenever `status` changes. |

Both columns are guarded by `CHECK (… IS NOT NULL) NOT VALID` constraints (`students_admission_date_ck`, `students_status_changed_at_ck`). PostgreSQL enforces a `NOT VALID` check on every insert and every new row version while not examining rows that already exist. Consequences, all intended:

- every new student must carry `admission_date`; `status_changed_at` is supplied by the default;
- a legacy row that still has a NULL **cannot be updated at all** (including a status change) until it is backfilled;
- the checks are validated and replaced by `NOT NULL` only by the deferred contract migration (§5).

**Status ownership.** Status values are the seven of `02` §4.4 (`ADMITTED`, `ACTIVE`, `ON_LEAVE`, `SUSPENDED`, `DISCONTINUED`, `GRADUATED`, `TRANSFERRED_OUT`); a new student starts as `ADMITTED`. Status is owned by **staff**, not by the student:

- `app.students_guard()` (`BEFORE UPDATE`, `SECURITY INVOKER`, volatile, `search_path = pg_catalog`, `EXECUTE` revoked from `PUBLIC`) rejects any change of `admission_number` (`restrict_violation`) and stamps `status_changed_at = now()` when `status` changes. It fires for every role including a superuser, but **not** for a session with `session_replication_role = replica` (which disables ordinary triggers; the runtime role cannot set it) or after the trigger is dropped.
- The restrictive policy `students_staff_update` allows `UPDATE` only when `app.current_actor_kind() = 'STAFF'`, in both `USING` and `WITH CHECK`.
- The runtime role keeps exactly one column-level `UPDATE` grant on `app.students`: **`status`**. `user_id` and `admission_number` were revoked (`0003` had granted them). `id`, `organization_id`, `admission_date`, `status_changed_at`, `version` and the timestamps were never updatable.
- The `status` grant exists only for the status workflow of a later phase. **No code path may use it yet**, and a static test asserts that no file in `backend/src` updates or inserts `app.students`. Status changes will go through an authorized, audited service (permission `student.status.change`, a mandatory reason, an audit event, optimistic concurrency); a database grant is never sufficient authorization.
- **Approved trade-off.** Until that service exists, the database itself lets **any `STAFF` session** change `status` to any of the seven values: the `STAFF`-only policy removes students and invalid contexts, but the database enforces **no transition rules**, no permission check and no audit for status. Those belong to the later service. The mitigations are only that no application code writes `app.students` (pinned by a text-based static test, which dynamically built SQL could evade) and that the grant is kept solely for that service.

## 2. Student-self behaviour

Unchanged: `students_student_self` (RESTRICTIVE, `ALL`) still lets a `STUDENT` actor **read** exactly their own row, and the tenant policies still bound every actor to their organization. What changed: a student actor can no longer **update** their own row, so they cannot change their own `status`; the filter is silent (zero rows), consistent with the other cross-student tests. Student self-service on other tables (for example `users.display_name`, `student_guardians`) is untouched. Students still cannot insert student rows (`students_no_student_insert`).

Re-pointing a student to a different login account is **not** available at runtime any more (the `0003` grant was revoked). It needs its own service (permission, mandatory reason, active same-tenant target account, uniqueness and the person-record exclusivity guard, optimistic concurrency, audit); that service is out of scope for this slice. The exclusivity trigger on `UPDATE OF user_id` remains as defence in depth for privileged sessions. Like every ordinary trigger, the exclusivity guard (migration `0016`) is **not enforced** for a session running with `session_replication_role = replica` (superuser or equivalent) or after the trigger is dropped; the runtime role can do neither, and a superuser/`BYPASSRLS` writer outside that mode is checked correctly. It is also correct only under `READ COMMITTED` and does not validate pre-existing rows (see `20-employees.md` §3.1).

## 3. Admission numbers (Phase 1)

- **Administrator-supplied.** No automatic allocation; `NumberSequenceService` is not used and not modified. Allocation needs a designed setting key (doc 02 names `identity.admission_number`, which is **not** in the settings registry), a format, and engine integration; that is deferred.
- **Approved format:** `^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$`, matching the repository convention of `EMPLOYEE_CODE_PATTERN` (a conservative charset: loosening later is safe, tightening is not). The service validates it; the database enforces length 1–50 and uniqueness only (as for `employee_code`). There is no trimming: whitespace is rejected by the pattern.
- **Case-sensitive uniqueness.** `UNIQUE (organization_id, admission_number)` is unchanged, so `A-1` and `a-1` are different numbers. That is by design and a known duplicate risk; the operator preflight reports case-only collisions.
- **Immutable** once set (doc 02): enforced by `students_guard()` and by the revoked `UPDATE (admission_number)` grant. A correction will be an audited function in a later phase.

## 4. Permission `student.record.create` and the role matrix

`0017` registers `student.record.create` (`SENSITIVE`) in `platform.permissions`; `catalog.ts` and `role-matrix.ts` carry the same entry. The documented four-role matrix of doc 10 row 26 is preserved exactly:

| Role | Grant | Assignable scope types (`ROLE_SCOPE_TYPES`) |
|---|---|---|
| DEPARTMENT_ADMIN | `GRANTED` | DEPARTMENT |
| CAMPUS_ADMIN | `GRANTED` | CAMPUS |
| COLLEGE_ADMIN | `GRANTED` | ORGANIZATION |
| REGISTRAR | `GRANTED` | ORGANIZATION or CAMPUS |

**Effective in the first service phase: organization scope only.** A student record has no campus or department of its own: doc 06 derives a student's scope from the active `student_programs` row, which does not exist yet. The engine's `GRANTED` evaluation needs the resource to prove it lies inside the grant's scope, so only a grant whose scope is `ORGANIZATION` can authorize creation or a read of a bare student. Therefore:

- COLLEGE_ADMIN, and a REGISTRAR assigned at **ORGANIZATION** scope, can create;
- a REGISTRAR assigned at **CAMPUS** scope, CAMPUS_ADMIN and DEPARTMENT_ADMIN are **inert**: the service will answer 403 for create (404 for a read of a specific student), exactly as the `EmployeeService` does for scoped employee grants.

The matrix is **not narrowed** for this: the scoped grants stay seeded and documented, and become effective when `student_programs` gives a student a reliable campus and department. Tests must assert both halves (the four-role matrix and the inert scoped behaviour). Existing tenants need `seedTenantRoles` re-run to receive the permission; until then no role holds it and creation is refused (fail closed). That re-run is not performed by this change.

## 5. Deferred contract migration (`0019`)

`0017` is the **expand** step of an expand/contract pair. The **contract** step is a later migration, `0019_students_required_dates_contract.sql`, which is gated by the runner's `_contract` rule and needs `--allow-contract 0019`. It is **not part of this phase and does not exist yet.** The agreed design:

- It contains **no backfill**. An operator-approved backfill rule for `admission_date` (and `status_changed_at`) is written into the change record and applied by the operator, outside the migration, before the contract step is run.
- The contract step validates both checks and sets `NOT NULL`. If any row still has a NULL, validation fails, the migration transaction rolls back, nothing is applied and the ledger is untouched. If the approved prerequisites are absent, the rollout stops.
- `VALIDATE CONSTRAINT` and `SET NOT NULL` are DDL scans of the table and are expected not to be hidden by row security (the schema owner cannot see tenant rows in a query). **This has not been proven yet**; the migration test `tests/integration/migration-0017.test.ts` is written to prove it on a disposable database and has not been run as part of this change.
- `0017` itself neither reads nor updates a student row and never touches `FORCE ROW LEVEL SECURITY`.
- Operator preflight (read-only, run as a superuser or BYPASSRLS role, because `app_migrator` sees zero tenant rows): student row count per organization; students sharing an `(organization_id, user_id)` with an employee (the exclusivity guard is forward-only); admission numbers with surrounding whitespace or differing only by case; students whose user holds active role assignments (§6).

## 6. Active-role safeguard for the future create service

**Invariant (approved design, not implemented in this phase):** creating a student record for a user who holds **any active role assignment** is refused with 409, including when the target is the creator. Reason: `actor_kind` is derived from the students mapping (`auth.service`, `isStudent ? 'STUDENT' : 'STAFF'`), so a student record turns the account into a `STUDENT` actor and its staff permissions stop working; creating one for an administrator's own account would lock them out of staff capabilities.

**The predicate, as the repository defines "active"** (`AuthorizationEngine.loadGrants`, `shared/authorization/engine.ts`, and the same condition in `RoleAssignmentService`): a row of `app.role_assignments` for the same `organization_id` and `user_id` with `status = 'ACTIVE' AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`. The service must use this condition verbatim, so that "active" cannot drift from what the engine grants. A not-yet-valid assignment (`valid_from > now()`) is not active by this predicate and will become active later; that gap must be stated by the service, not hidden.

**Concurrency limitation — this safeguard is NOT race-free with the current code, and must not be described as such until a locking protocol is verified:**

- `RoleAssignmentService.grant` reads the target user with a plain `SELECT` (no lock) and inserts the assignment; the only lock it takes on the user's row is the implicit `FOR KEY SHARE` of the foreign-key check on insert.
- `EmployeeService.create` locks the user `FOR SHARE`. `FOR SHARE` does not conflict with `FOR KEY SHARE`, so a student create using that same lock and a concurrent role grant would not exclude each other: the grant can commit after the student service's check.
- A candidate protocol for the later phase is to lock the user row with `FOR UPDATE` (which does conflict with the foreign-key key-share lock) before checking role assignments, so a concurrent grant waits and the check runs on a fresh snapshot. **This is a recommendation, unverified.** It must be proven with a disposable-database concurrency test (grant first and student create first, plus rollback), and the person-record exclusivity lock order (`20` §3.1) must be preserved.
- **Closing the other direction needs a separate change to the role-grant service.** The `FOR UPDATE` protocol above only protects the student-create side. A staff-role assignment that races a student create (the grant reads the target before it blocks on the foreign-key check, or after the student commits) can still land on an account that holds a student record, and nothing prevents granting a staff role to an account that already has one. Preventing that requires `RoleAssignmentService.grant` to take a conflicting lock on the target user (for example `FOR SHARE`) before its own checks, plus a rule for what it should refuse. That is a change to another service, not part of this slice's plan; until it is designed and tested, **no part of this safeguard may be described as race-free**. Recorded as a follow-up.

## 7. Deferred fields and workflows

Not in this phase, deliberately:

- `registration_number` (set-once, partial unique), `merged_into_student_id` and the merge workflow, and the `(organization_id, status)` index: nothing in this slice writes or queries them.
- Automatic admission-number allocation and the `identity.admission_number` setting.
- Status transitions and the status endpoint (`student.status.change`), `student.record.update`, an audited admission-number correction, account re-pointing.
- Student list and search (they wait for the shared cursor-pagination capability, FU-EMP-1, so a second `limit`/`offset` deviation is not added).
- `student_programs` and the program linkage, which also make scoped create and read effective; `student_identifiers`; guardians beyond the table that already exists.
- Implicit `STUDENT` role assignment (doc 06, "implicit assignments"). Nothing creates it, so a student will not be able to read their own record through the API until one exists; recorded as a follow-up, like FU-EMP-4.
- The create and read endpoints and their idempotency requirement: a later phase.

## 8. Audit and history

There is **no history table** for students in this slice. Doc 02 marks `students` as A2 ("audit row + mandatory reason + history table"); doc 08 (which prevails over `02` on platform-level design) lists none in the Milestone 1 table set, and employees took the same reading (`20` §4 item 3): the audit event carries the old/new diff and the mandatory reason. Phase 1 writes no student rows from application code, so it emits no audit events. Every later service mutation must write a reason-bearing audit event (risk tier 2, `reasonText` 5–500 characters, `subjectStudentId` set, field diff) in the same transaction as the change.

## 9. Deviations from the architecture documents

1. **History table omitted** (doc 02, A2): see §8.
2. **Admission numbers are administrator-supplied** instead of allocated from `number_sequences` under `identity.admission_number` (doc 02 §6.1, doc 11): the setting does not exist in the registry and the format is undesigned.
3. **`registration_number`, `merged_into_student_id` and the status index** (doc 02 §4.4) are deferred.
4. **`admission_date` and `status_changed_at` are enforced by `NOT VALID` checks first** and by `NOT NULL` only after the deferred contract step, because the repository must not assume the persistent database has no student rows.
5. **`UPDATE (user_id)` and `UPDATE (admission_number)` revoked** from the runtime role, contrary to the intent recorded in `0003` ("re-pointing a student … is a staff operation"): no audited service exists for it. Doc 02 §6.2 still describes re-pointing as an audited admin action, which stays a future capability.
6. **Students can no longer update their own row.** No document asks for it, and `02`/`06` treat status changes as staff actions.
7. **Scoped `student.record.create` grants are seeded but inert** until `student_programs` (doc 06 line 63 derives student scope from the active program).
8. **Status is writable by any `STAFF` session at the database level**, with no transition rules, permission check or audit until the status service exists (see §1, approved trade-off).
9. **Documentation differences not reconciled here:** doc 06 §2.1 describes an `app.student_id` session setting, while the runtime sets only tenant, user and actor kind and derives the student mapping from the database; doc 11 lists `guardians` and `student_programs` among the 39 tables although neither exists yet.
