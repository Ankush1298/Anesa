# 20 — Employees (Milestone 1, Phase 1D)

Specification sources: `02` §4.4 (`employees`), ADR-003 (account vs role record), `08` §4.1 (version / `If-Match`) and §5 (M1 table set),
`10` §1 rows 32–34 and its notes, `11` §5.4 (`GET/POST /employees`, `GET/PATCH /employees/{id}`), `04` §14.2 (`/faculty` domain, `people` module), `19` Decision 3 (A2 without a history table in M1).
Implementation: migration `0015_employees.sql`, `backend/src/modules/people/`.

## 1. Data model (as specified, nothing added)

`app.employees`: `id`, `organization_id`, `user_id` (composite FK `(organization_id, user_id)` → `users`, **unique**), `employee_code` (≤ 50, **unique per organization**), `employee_type` (`FACULTY|STAFF|ADMIN|VISITING`), `joining_date`, `leaving_date?`, `status` (`ACTIVE|ON_LEAVE|SEPARATED`), `version`, timestamps. FORCE RLS; `touch_row` + `enforce_immutable_keys` triggers.

Database-enforced consistency: **only** `leaving_date >= joining_date` (`employees_dates_ck`; same-day join and leave is allowed). It rests on the general convention "Dates ordered" in `08` §4 (line 60), not on an employee-specific rule. **No coupling between `status` and `leaving_date` is enforced anywhere** (database, service, schema): `01` §3.4 lists `leaving_date` as *optional* and gives employees no constraint beyond "code unique per org". See §4 item 6.

Runtime privileges: `SELECT, INSERT`, and `UPDATE (employee_type, joining_date, leaving_date, status)`. `user_id` and `employee_code` are fixed at creation. No `DELETE`: a leaver is `SEPARATED`.

Restrictive RLS policies refuse a `STUDENT` session on SELECT/INSERT/UPDATE (doc 10: students never list or search employees). Which staff member may touch which record is the application's decision.

## 2. API (`/api/v1/faculty/employees`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /employees` | `employee.profile.read` | filters `status`, `employeeType`; `limit` (1–**100**, default 100) and `offset`; ordered by `employee_code, id`. **Temporary DEVIATION from the signed-cursor contract: see §4 item 7 and follow-up FU-EMP-1** |
| `POST /employees` | `employee.record.create` | body `userId, employeeCode, employeeType, joiningDate, reason`; status is server-set `ACTIVE`; 201 `{id}` |
| `GET /employees/:id` | `employee.profile.read` | `ETag: "<version>"` |
| `PATCH /employees/:id` | `employee.record.update` | `If-Match` required (428 / 400 weak / 409 stale); body any of `employeeType, joiningDate, leavingDate, status` plus `reason`; `leavingDate: null` clears it (an empty string is a 400) |

Strict schemas (`additionalProperties: false`): no tenant, version, `employeeCode`/`userId` on update, status-on-create or `leavingDate`-on-create is accepted (a new record is `ACTIVE`; set a leaving date afterwards with `PATCH`; this is an API restriction, not a documented rule).

## 3. Authorization

Catalog and matrix mirror doc 10 rows 32–34 exactly (a test parses the document): read `N` — FACULTY/STAFF `S`, HOD/DEPT_ADMIN/CAMPUS_ADMIN/COLLEGE_ADMIN `G`; create/update `S` — DEPT_ADMIN/CAMPUS_ADMIN/COLLEGE_ADMIN `G`. STUDENT and REGISTRAR hold none.

Model: permission held (403) → row lookup in tenant (404) → `AuthorizationEngine.assert` with the record's attributes (404). Create additionally requires ORGANIZATION scope (403). Every mutation is audited (`employee.create`, `employee.update`, risk tier 2, reason in `reason_text`, field diff) in the same transaction.

Relationship checks on create: the user exists **in this tenant** (else 404, indistinguishable from another tenant's user), is not `DEACTIVATED` (409), and has no student record (409) because `actor_kind` is derived from the students mapping (`auth.service`), so an account holding both would be a STUDENT actor that can never exercise staff permissions. The service check gives the friendly early answer; the race-free guarantee is the database guard in §3.1 (migration `0016`).

### 3.1 Student/employee exclusivity (X1, migration `0016`)

Within one organization a user account holds a student record **or** an employee record, never both (ADR-003 amendment). It is enforced by the database, not by the services alone:

- **Mechanism.** One trigger function, `app.enforce_person_record_exclusive()`, attached as `BEFORE INSERT` on `app.students`, `BEFORE INSERT` on `app.employees` and `BEFORE UPDATE OF user_id` on `app.students` (only when `user_id` actually changes; `employees.user_id` is not updatable at runtime, and since migration `0017` the runtime role cannot update `students.user_id` either, so the `UPDATE` path is reachable only by privileged sessions and is defence in depth). It takes `pg_advisory_xact_lock(hashtextextended('app.person_record_exclusive:<org>:<user>', 0))`, then looks for a row for the same `(organization_id, user_id)` in the other table. Two concurrent writers for one account serialise on the lock, so the second runs its check after the first has committed (and refuses) or rolled back (and proceeds).
- **Error contract.** SQLSTATE `23P01` (`exclusion_violation`) with `CONSTRAINT = person_record_exclusive`. `EmployeeService.create` maps exactly that code **and** constraint to the existing `409 CONFLICT` ("This account already has a student record."); any other `23P01` is not mapped. The students writer, when built, must map it the same way.
- **Function properties.** `SECURITY INVOKER`, `VOLATILE`, `search_path = pg_catalog`, `EXECUTE` revoked from `PUBLIC` (repo convention; pinned by a test).
- **Why INVOKER.** `FORCE ROW LEVEL SECURITY` applies to the owner `app_migrator` and neither table has an owner probe policy (unlike `app.users`), so a `SECURITY DEFINER` function would see zero rows and silently pass. Running as the writer is correct because every permitted write to these tables needs a `STAFF` actor in the tenant, and that context sees every row of both tables. RLS is not weakened, and unauthorised writes are still refused by the existing policies (tested: STUDENT actor, missing context, other tenant).
- **Lock ordering.** One advisory lock per firing, taken first inside the trigger. Since the person-identity follow-up (`21-students.md` §6, migration `0020`) the services take the same lock (`shared/authorization/person-identity.ts`) as the first statement of `EmployeeService.create`, `StudentService.create` and `RoleAssignmentService.grant`, i.e. **before** the row locks (`users … FOR SHARE` / `FOR UPDATE`); the trigger's acquisition is then re-entrant. The sentence that follows still holds for privileged sessions that do not use the helper. A privileged session that repoints several students can take several advisory locks in an order another such transaction reverses; PostgreSQL then reports `40P01`, never a wrong answer. The key is a string-derived 64-bit hash, so collisions are possible (in principle even with the runner `727301001` or bootstrap `727301002` keys); a collision only adds contention, because the check still compares the exact `organization_id` and `user_id` and is never bypassed.

**Limitations (stated, not hidden).**

1. **READ COMMITTED only.** The check relies on a fresh statement snapshot after the lock wait. Under `REPEATABLE READ`/`SERIALIZABLE` it can miss the other row. `Database.withTenant` uses the default; do not change it for these writes.
2. **Forward-only.** Existing data is not rewritten or validated; a database that already holds a user with both records is not rejected, it only gains protection against new ones. Changing a legacy row's non-`user_id` columns still works.
3. **Bypass.** A superuser, or a session with `session_replication_role = replica`, or `DROP TRIGGER`, bypasses the guard. The runtime role cannot do any of these. A superuser/`BYPASSRLS` writer is checked correctly (it sees all rows).
4. **Per organization.** Users are tenant-scoped, so the same human with accounts in two organizations is unaffected.
5. **Students writer.** `StudentService.create` (Students slice, Phase 2) maps `23P01`/`person_record_exclusive` to a controlled 409, keeps an early friendly check, and locks the account row `FOR UPDATE` so student and employee creation for one account serialise in either order (`21-students.md` §0).

## 4. Recorded gaps and decisions (not silently resolved)

1. **No department / designation / campus on `employees`.** `02` §4.4 puts these in `employee_postings`, which `08` §5 and `04` assign to **M2**. Consequence: an employee cannot be proven inside a CAMPUS or DEPARTMENT scope, so the engine denies (fail closed). Today only ORGANIZATION-scoped `G` holders (COLLEGE_ADMIN) can read/create/update arbitrary records; FACULTY/STAFF can read **only their own** record (SELF); the `G` rows of doc 10 for HOD, DEPARTMENT_ADMIN and CAMPUS_ADMIN are **inert until postings exist** (list → `[]`, get/update → 404, create → 403). Designation validation is deferred with postings.
2. **Route prefix.** `04` §14.2 names the domain `/faculty`; `11` §5.4 writes the resource as `/employees`. Mounted as `/api/v1/faculty/employees` (module `people`, per `04` line 39), consistent with `/organization/campuses` and `/academics/programs`.
3. **A2 without a history table**, per `19` Decision 3 (`08` §5 lists none for employees). The audit diff and mandatory reason are the history.
4. **`employee_code`** has no allocation rule in `02` §4.4 (number sequences serve admission numbers): supplied by the administrator, restricted to `[A-Za-z0-9][A-Za-z0-9_-]{0,49}` (loosening later is safe; tightening is not), immutable.
5. **Implicit role assignment** (doc 10 intro: employee type FACULTY ⇒ FACULTY role) is **not** done as a side effect: role assignments are made by `RoleAssignmentService` under `role.assignment.grant`.
6. **Status and `leaving_date` (OPEN DECISION: nothing authoritative exists, so nothing is enforced).**
   Evidence searched: `01` §3.4 (Employee row: `leaving_date` under *Optional*; Constraints: "code unique per org"; Lifecycle: "ACTIVE→ON_LEAVE→SEPARATED"), `02` §4.4 (`leaving_date?`, `status [ACTIVE|ON_LEAVE|SEPARATED]!`, no coupling), `07`, `08`, `10`, `11`, and every other document: none states that `SEPARATED` requires a leaving date, that only `SEPARATED` may have one, or which transitions are allowed. Therefore:
   * `SEPARATED` does **not** require `leaving_date`, and a leaving date does **not** require `SEPARATED` (for example a recorded notice period). Changing `status` never alters `leaving_date`; it changes only when the client sends `leavingDate` (a date sets it, `null` clears it).
   * **No status transition is forbidden**, including `SEPARATED` → `ACTIVE`/`ON_LEAVE` and `ACTIVE` → `SEPARATED` directly. The `01` §3.4 chain is read as an illustration of the states, not a state machine: read literally it would forbid a direct `ACTIVE`→`SEPARATED` and any return from leave.
   * Still enforced, because it is a general convention and not a lifecycle rule: `leaving_date >= joining_date` (also checked by the service before the database is reached, including when `joiningDate` is moved past an existing leaving date).
   * **Open questions for the product owner:** must `SEPARATED` carry a leaving date; may a future leaving date exist on an `ACTIVE` employee; is `SEPARATED` terminal or may an employee be reinstated (note `user_id` is unique, so a re-hire can only reuse the record); should separation affect the account or revoke role assignments (it does **not** today: no automatic effect on `users` or `role_assignments`).
7. **Pagination: temporary, documented DEVIATION. This is `limit`/`offset`, NOT the specified signed cursor pagination, and must not be described as compliant.**
   *Specified:* `04` §14.1 "Cursor pagination"; `security_artitecture.md` lines 385–386 (Pagination) "Cursor-based, opaque, signed cursors bound to principal and query" and line 384 (Size/complexity limits) "max page size (e.g., 100)"; `01` §1.1 (line 32) also lists cursor pagination.
   *Implemented (interim):* `limit` 1–**100** (default 100; enforced by the schema **and** the service, 400 above the cap) and an integer `offset` ≥ 0 (schema maximum 1,000,000), ordered by `(employee_code, id)`. Only the page-size cap of the specification is met.
   *Requirements of the specification that this endpoint does NOT meet:*
   * **opaque**: the position is a plain integer a client can read and construct;
   * **signed**: nothing is tamper-evident;
   * **bound to the principal**: the same offset is accepted from any caller;
   * **bound to the query**: nothing ties it to the filters or sort it was issued for.
   *Instability under concurrent writes (a known defect of offset paging):* the runtime role cannot `DELETE`, but rows are inserted and updated while a client pages. A new employee whose code sorts before the client's position shifts every later row down by one, so the next page repeats a row already returned; an update that moves a row into or out of a `status`/`employeeType` filter shifts positions in the same way, so rows can be skipped or repeated. The response carries no snapshot or integrity information, so a client cannot detect either. Deep offsets also cost a scan of that many index entries.
   *Security properties of the interim contract (honest limits):* an offset carries no authority. Every request recomputes the caller's visibility from the session (tenant, RLS, grants), so replaying an offset across principals, tenants or filters cannot expose anything the caller could not already list; it only selects a different position. That is a property of the endpoint's per-request scoping, not a substitute for the specified cursor.
   *Why it was not built to specification:* the repository contains **no cursor primitive and no signing key**. `AppConfig` (`backend/src/config/env.ts`) defines no secret at all, `app.ts` deliberately leaves the cookie unsigned, and no other list endpoint paginates. An employee-only cursor would be exactly the ad hoc, per-endpoint security scheme that the specification's "signed cursors bound to principal and query" is meant to rule out, and it would have to be redone.
   *What replacing it requires:* a **shared** capability, not an employee scheme. See FU-EMP-1 in §5.
8. Existing tenants need `seedTenantRoles` re-run to receive the three permissions; `0015` sits behind the `--allow-contract 0009` gate like `0010`–`0014`, and so does `0016`.

## 5. Follow-ups (deferred work)

None of the behaviours below is implemented by this slice, with two exceptions that are stated in their rows: FU-EMP-1 has the interim `limit`/`offset` implementation described in §4 item 7, and FU-EMP-4 concerns two create-time refusals that exist today and are inferred, not specified. "Blocked on" names what must exist or be decided first; none of these may be resolved by inference inside the employee module.

| ID | Follow-up | Blocked on | Boundary | Done when |
|---|---|---|---|---|
| **FU-EMP-1** | Replace `limit`/`offset` with the specified signed, opaque cursor pagination. | A **shared** cursor/signing capability that does not exist: (a) a server-side signing key in configuration with a rotation story (no secret exists in `AppConfig` today); (b) one shared module used by every list endpoint, not an employee-only scheme (`11` §5.3 lists `shared/http` for the error envelope and `If-Match` middleware, a candidate home; that is a proposal, not a decision). | Keyset on `(employee_code, id)`. The cursor must be authenticated (HMAC, constant-time verify) and bound to tenant, user, the normalised filters and sort, the position and an expiry. No change to authorization or scoping. `offset` is removed (a breaking change that should land before any client depends on it). The 100-row cap stays. | Tests prove a cursor is rejected when replayed by another user, another tenant, with other filters or another sort, when tampered with, and when expired; this document (§2, §4 item 7) is updated and the deviation text removed. |
| **FU-EMP-2** | Decide the employee lifecycle: whether `SEPARATED` requires a leaving date, whether a future leaving date may exist on an `ACTIVE` employee, whether `SEPARATED` is terminal or reinstatement is allowed, and which transitions are valid. | Product owner. Nothing authoritative exists (§4 item 6); nothing is enforced beyond `leaving_date >= joining_date`. | Enforce only what the decision says, consistently in database, service, schema and tests. | The decision is recorded in `01`/`02` and this document, and the code matches it. |
| **FU-EMP-3** | `employee_postings` (department and designation over time) and scope by campus/department. | Milestone 2 (`08` §5, `04`). | Until then HOD, DEPARTMENT_ADMIN and CAMPUS_ADMIN grants are inert for employees by design (§4 item 1). | A record can be proven inside a campus/department scope and the scoped roles of `10` rows 32–34 take effect. |
| **FU-EMP-4** | Account and role effects of employment: implicit role assignment from the employee type, and whether separation affects the account or revokes role assignments. Also confirm the two inferred create-time refusals (deactivated account, existing student record; §3). | Product owner and the role-assignment design (`RoleAssignmentService`, `role.assignment.grant`). | No automatic effect on `users` or `role_assignments` exists today and none may be added implicitly. | The behaviour is specified and implemented through the role-assignment path with its own tests and audit. |
| **FU-EMP-5** | ~~Make the student/employee exclusivity symmetric and race-free.~~ **Done:** database guard (X1, migration `0016`, §3.1) plus the students writer (Phase 2: early check, shared per-person lock then `FOR UPDATE` account lock, `23P01` mapped to 409). | — | — | `tests/integration/student.test.ts` creates both records for one account concurrently, in both orders, and exactly one succeeds (the other is a 409, not a 500). |
