# 21 — Students (Milestone 1, Phase 1D) — Phase 1: schema and authorization; Phase 2: create/read API and idempotency

Status: **Phases 1 and 2.** Phase 1 (migration `0017`, the `student.record.create` permission) is committed. Phase 2 adds the student create and read API, the shared idempotency mechanism ([22-idempotency.md](22-idempotency.md), migration `0018`) and the contract migration `0019`. **There is still no student list, no update, no status transition, no program enrolment and no automatic admission-number allocation.** Application code that **reads** `app.students`: `auth.service` (actor kind), the `SELF` resolver in the authorization engine, the exclusivity pre-check in `EmployeeService.create`, and `StudentService.getById`. The **only** code that writes it is `StudentService.create` (`backend/src/modules/students/student.service.ts`); a static test pins that allowlist and that nothing updates or deletes `app.students`.

Implementation: migrations `0017_students_record_fields.sql`, `0018_idempotency_keys.sql`, `0019_students_required_dates_contract.sql`; `modules/students/{student.schemas,student.service,student.routes,index}.ts`; `shared/idempotency/`; `modules/people/validation.ts` (shared `parseDate`/`parseReason`, extracted from the employee service with unchanged behaviour); `shared/authorization/catalog.ts` and `role-matrix.ts`; `AuthorizationEngine.hasActiveAssignment`. Specification baseline: `02` §4.4 (`students`) and §6.1 (identifier policy), `06` (authorization model), `10` §1 row 26, `11` §5.4 (`POST /students`, `GET /students/{id}`), ADR-003 and its amendments, `20-employees.md` §3.1 (person-record exclusivity).

## 0. API (Phase 2)

Mounted at `/api/v1/students`. Authentication, CSRF/origin checks, tenant context, `Cache-Control: no-store` and the error envelope are the repository's existing ones.

### `POST /api/v1/students` — permission `student.record.create`

Body (`additionalProperties: false`; tenant and status are never accepted): `userId` (UUIDv7 of an existing account in the caller's tenant), `admissionNumber` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$`, administrator-supplied, case-sensitive uniqueness per tenant), `admissionDate` (real calendar date, 1900–2200), `reason` (5–500 characters, mandatory, trimmed). Header `Idempotency-Key` is required. Success: `201 {success: true, data: {id}}`; the new student has status `ADMITTED`; **no role is granted** to the account.

Order of decisions: body shape (400) → permission held (403) → ORGANIZATION scope (403; a scoped holder cannot create because a student has no campus/department yet) → idempotency key (428 missing / 400 malformed) → claim or replay (422 key reuse) → account checks → insert → audit.

| Status | Cause |
|---|---|
| 400 | invalid body, key or date; unknown or tenant fields |
| 403 | permission not held, or only held at CAMPUS/DEPARTMENT scope |
| 404 | target account missing **or in another tenant** (indistinguishable) |
| 409 | account not `ACTIVE`; account holds an **active role assignment** (self-targeting included); account has an employee record; account already has a student record; admission number already used |
| 422 | the `Idempotency-Key` was used for a different request |
| 428 | `Idempotency-Key` missing |

A replay returns the original `201` with `Idempotent-Replayed: true`. Failures are never cached ([22-idempotency.md](22-idempotency.md)).

Inside one transaction: claim → `SELECT … FROM app.users … FOR UPDATE` → active-role check → employee pre-check → `INSERT app.students` → audit event `student.record.create` (risk tier 2, `reasonText`, `subjectStudentId`, field diff) → stored response. A failure anywhere rolls all of it back, including the claim; this includes a genuine audit-write failure inside PostgreSQL (the current month's audit partition dropped on a throw-away database): no student, no claim, no audit row, and the same key then succeeds as a fresh request (`tests/integration/student-atomicity.test.ts`, through the HTTP route). The database refusals are mapped: `23P01` with constraint `person_record_exclusive` (migration `0016`) → 409 employee record; `23505` → 409 student record or admission number. Because the account row is locked `FOR UPDATE` and the employee service locks it `FOR SHARE`, creation of a student and of an employee for one account are serialised in either order (tested); the `0016` guard remains as the database-level backstop.

### `GET /api/v1/students/:id` — permission `student.profile.read`

Returns the record (`id, organizationId, userId, admissionNumber, admissionDate, status, statusChangedAt, version, createdAt, updatedAt`) with a strong `ETag: "<version>"`. Held-at-all is checked first (403); a missing record, another tenant's record and a record outside the caller's scope are the same `404`. `STUDENT` actors hold `SELF`: they read exactly their own record. CAMPUS- and DEPARTMENT-scoped `GRANTED` holders (campus admin, HOD, campus registrar) get 404, because a student record carries no campus/department until `student_programs` exist. `admissionDate`/`statusChangedAt` are nullable in the response **only** for rows written before `0017`, until `0019` runs.

## 1. Student record and status ownership

`app.students` is the student **role record** of a login account (ADR-003): `id` (UUIDv7, permanent), `organization_id`, `user_id` (unique per organization), `admission_number` (unique per organization), `status`, `version`, `created_at`, `updated_at`, plus, from `0017`:

| Column | Nullability / default | Why it exists in Phase 1 |
|---|---|---|
| `admission_date date` | **nullable**, no default | Required by `02` §4.4. The service will require it on create. Existing rows are **not** given an invented date. |
| `status_changed_at timestamptz` | **nullable for existing rows**; default `now()` for new rows | Required by `02` §4.4. The default is attached after the column is added, so existing rows are not stamped with the time of the migration. A trigger sets it whenever `status` changes. |

Both columns are guarded by `CHECK (… IS NOT NULL) NOT VALID` constraints (`students_admission_date_ck`, `students_status_changed_at_ck`). PostgreSQL enforces a `NOT VALID` check on every insert and every new row version while not examining rows that already exist. Consequences, all intended:

- every new student must carry `admission_date`; `status_changed_at` is supplied by the default;
- a legacy row that still has a NULL **cannot be updated at all** (including a status change) until it is backfilled;
- the checks are validated and replaced by `NOT NULL` only by the gated contract migration `0019` (§5). **This paragraph describes the schema between `0017` and `0019`**; after `0019` the columns are `NOT NULL` and the checks are gone.

**Status ownership.** Status values are the seven of `02` §4.4 (`ADMITTED`, `ACTIVE`, `ON_LEAVE`, `SUSPENDED`, `DISCONTINUED`, `GRADUATED`, `TRANSFERRED_OUT`); a new student starts as `ADMITTED`. Status is owned by **staff**, not by the student:

- `app.students_guard()` (`BEFORE UPDATE`, `SECURITY INVOKER`, volatile, `search_path = pg_catalog`, `EXECUTE` revoked from `PUBLIC`) rejects any change of `admission_number` (`restrict_violation`) and stamps `status_changed_at = now()` when `status` changes. It fires for every role including a superuser, but **not** for a session with `session_replication_role = replica` (which disables ordinary triggers; the runtime role cannot set it) or after the trigger is dropped.
- The restrictive policy `students_staff_update` allows `UPDATE` only when `app.current_actor_kind() = 'STAFF'`, in both `USING` and `WITH CHECK`.
- The runtime role keeps exactly one column-level `UPDATE` grant on `app.students`: **`status`**. `user_id` and `admission_number` were revoked (`0003` had granted them). `id`, `organization_id`, `admission_date`, `status_changed_at`, `version` and the timestamps were never updatable.
- The `status` grant exists only for the status workflow of a later phase. **No code path may use it yet**, and a static test asserts that no file in `backend/src` updates or deletes `app.students` and that only `StudentService.create` inserts into it. Status changes will go through an authorized, audited service (permission `student.status.change`, a mandatory reason, an audit event, optimistic concurrency); a database grant is never sufficient authorization.
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

## 5. Contract migration `0019`

`0017` is the **expand** step of an expand/contract pair; `0019_students_required_dates_contract.sql` is the **contract** step, gated by the runner's `_contract` rule (`pnpm db:migrate --allow-contract 0019`, first migration of its invocation; `contractVersions()` now returns `0009` and `0019`). Operator steps and preflight: [../../runbooks/students-contract-rollout.md](../../runbooks/students-contract-rollout.md). Behaviour:

- It contains **no backfill** and invents no date. The operator-approved backfill rule for `admission_date` and `status_changed_at` is applied outside the migration, before the contract step.
- It runs `VALIDATE CONSTRAINT` on both `NOT VALID` checks, then `SET NOT NULL` on both columns, then drops the two now-redundant checks. If any row still has a NULL, validation fails (`23514`), the migration transaction rolls back, nothing is applied and the ledger is untouched. Row security does not hide rows from the DDL scan: proved on a disposable database by `tests/integration/migration-0019.test.ts`, which also proves the gating, the phase-boundary refusal, that values are preserved, and that a missing `admission_date` is afterwards refused with `23502`.
- `0017` itself neither reads nor updates a student row and never touches `FORCE ROW LEVEL SECURITY`; neither does `0019`.
- Operator preflight (read-only, as a superuser or BYPASSRLS role, because `app_migrator` sees zero tenant rows): student row count per organization; rows with NULL dates; students sharing an `(organization_id, user_id)` with an employee (the exclusivity guard is forward-only); admission numbers with surrounding whitespace or differing only by case; students whose user holds active role assignments (§6). None of these statements has been run on a real server.
- After `0019`, the application has no NULL-tolerant path left to remove except the nullable response fields (a follow-up cleanup).

## 6. Active-role safeguard (implemented in Phase 2)

**Invariant:** creating a student record for a user who holds **any active role assignment** is refused with 409, including when the target is the creator. Reason: `actor_kind` is derived from the students mapping (`auth.service`, `isStudent ? 'STUDENT' : 'STAFF'`), so a student record turns the account into a `STUDENT` actor and its staff permissions stop working; creating one for an administrator's own account would lock them out of staff capabilities.

**The predicate** is the one the repository defines for "active" (`AuthorizationEngine.loadGrants`, `shared/authorization/engine.ts`, and `RoleAssignmentService`), implemented once as `AuthorizationEngine.hasActiveAssignment` (the student service may not name `role_assignments`; a static test pins that): a row of `app.role_assignments` for the same `organization_id` and `user_id` with `status = 'ACTIVE' AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`. Revoked, expired-status and ended assignments do not block. A **not-yet-valid** assignment (`valid_from > now()`) does not block either and **becomes active later without any write**: the account can then be both a student and staff. That gap is real and tested as the documented behaviour; it is not hidden here.

**Locking.** The create locks the account row `FOR UPDATE` before the check. `FOR UPDATE` conflicts with the `FOR KEY SHARE` lock that a concurrent role grant takes on the account through its foreign key, so a grant that is in flight when a student create starts is either visible to the check (it committed first: the create waits, then is refused) or rolls back (the create proceeds). Both outcomes are covered by `tests/integration/student.test.ts` on a disposable database, using the real `RoleAssignmentService.grant` held in flight (commit and rollback), plus a grant that committed earlier and two creates with different keys for one account (one student, one 409, one stored claim). It also conflicts with the `FOR SHARE` lock of `EmployeeService.create`, so student and employee creation for one account are serialised (tested in both orders).

**What this does NOT close — the role-grant concurrency gap.** The protocol protects only the student-create side.

- `RoleAssignmentService.grant` reads the target user with a plain `SELECT` (no lock) and inserts the assignment; its only lock on the user row is the implicit `FOR KEY SHARE` of the foreign-key check. A staff-role grant that starts **after** a student create has taken its lock simply waits for that lock to be released and then **succeeds**: nothing in `grant` checks whether the account already holds a student record. Likewise a grant that read the target before the student committed can land on an account that now has a student record.
- Preventing a staff role from being granted to a student account needs a change to the role-grant service: it must take a conflicting lock on the target user (for example `FOR SHARE`) **and** refuse targets that have a student record (and decide what the rule is for the implicit `STUDENT` role). That is a separate change to another service, **not part of this phase**. Until it is designed and tested, **no part of this safeguard may be described as race-free**. Recorded as a follow-up.
- A future-dated assignment (above) can also activate without a write.
- The current behaviour is **pinned by a test** (`KNOWN GAP` in `tests/integration/student.test.ts`): a grant that starts while a student create is in flight waits for it and then lands on the new student account. A future fix must change that test deliberately. Closing it requires a decision about the role-grant service (lock, refusal rule, the implicit `STUDENT` role) and is **unresolved**.

## 7. Deferred fields and workflows

Not in this phase, deliberately:

- `registration_number` (set-once, partial unique), `merged_into_student_id` and the merge workflow, and the `(organization_id, status)` index: nothing in this slice writes or queries them.
- Automatic admission-number allocation and the `identity.admission_number` setting.
- Status transitions and the status endpoint (`student.status.change`), `student.record.update`, an audited admission-number correction, account re-pointing.
- Student list and search (they wait for the shared cursor-pagination capability, FU-EMP-1, so a second `limit`/`offset` deviation is not added).
- `student_programs` and the program linkage, which also make scoped create and read effective; `student_identifiers`; guardians beyond the table that already exists.
- Implicit `STUDENT` role assignment (doc 06, "implicit assignments"). Nothing creates it, so a student will not be able to read their own record through the API until one exists; recorded as a follow-up, like FU-EMP-4.
- Student list and search remain deferred (see above); `PATCH`, status endpoints and deletes do not exist.
- Idempotency is wired to the create route only; no other route was retrofitted.

## 8. Audit and history

There is **no history table** for students in this slice. Doc 02 marks `students` as A2 ("audit row + mandatory reason + history table"); doc 08 (which prevails over `02` on platform-level design) lists none in the Milestone 1 table set, and employees took the same reading (`20` §4 item 3): the audit event carries the old/new diff and the mandatory reason. `StudentService.create` (Phase 2) writes one `student.record.create` audit event (risk tier 2, `reasonText` 5–500 characters, `subjectStudentId` set, field diff of the new record) in the same transaction as the insert, and the insert is undone if the audit write fails. Every later service mutation must do the same.

## 9. Deviations from the architecture documents

1. **History table omitted** (doc 02, A2): see §8.
2. **Admission numbers are administrator-supplied** instead of allocated from `number_sequences` under `identity.admission_number` (doc 02 §6.1, doc 11): the setting does not exist in the registry and the format is undesigned.
3. **`registration_number`, `merged_into_student_id` and the status index** (doc 02 §4.4) are deferred.
4. **`admission_date` and `status_changed_at` are enforced by `NOT VALID` checks during the expansion (`0017`)** and by `NOT NULL` only once the gated contract migration `0019` has run (it validates the checks, sets `NOT NULL` and drops them), because the repository must not assume the persistent database has no student rows.
5. **`UPDATE (user_id)` and `UPDATE (admission_number)` revoked** from the runtime role, contrary to the intent recorded in `0003` ("re-pointing a student … is a staff operation"): no audited service exists for it. Doc 02 §6.2 still describes re-pointing as an audited admin action, which stays a future capability.
6. **Students can no longer update their own row.** No document asks for it, and `02`/`06` treat status changes as staff actions.
7. **Scoped `student.record.create` grants are seeded but inert** until `student_programs` (doc 06 line 63 derives student scope from the active program).
8. **Status is writable by any `STAFF` session at the database level**, with no transition rules, permission check or audit until the status service exists (see §1, approved trade-off).
9. **Documentation differences not reconciled here:** doc 06 §2.1 describes an `app.student_id` session setting, while the runtime sets only tenant, user and actor kind and derives the student mapping from the database; doc 11 lists `guardians` and `student_programs` among the 39 tables although neither exists yet.
10. **Idempotency-Key format** (16–128 URL-safe characters), the 24-hour lifetime and the `409`/`503` mapping of lock and statement timeouts are implementation choices recorded in [22-idempotency.md](22-idempotency.md); `04` §14 states the convention but not these values.
11. **Audit action name** is `student.record.create`, equal to the permission code. A repository gate forbids free-standing `student.*` string literals that are not catalogued permissions, so a separate `student.create` action name was not used.
12. **`GET /students/{id}` requires `student.profile.read`** (doc 10); the response omits sensitive fields (none exist on the record yet). `student.profile.read_sensitive` is not used.
13. **`0019` drops the two redundant `NOT VALID` checks** after setting `NOT NULL`, which `0017` did not announce; the error for a missing value changes from `23514` to `23502`.
