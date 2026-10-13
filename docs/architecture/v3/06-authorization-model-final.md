# Blueprint v3.1 — Final Authorization Model

Principle: **an unpredictable ID is not authorization.** Every operation that touches a tenant resource runs the same pipeline. UUIDv7 identifiers are used for sortability and non-enumerability only.

---

## 1. Components

| Component | Where | Notes |
|---|---|---|
| Permission catalog | Code (`permissions` table seeded from it) | `module.resource.action`; sensitivity NORMAL / SENSITIVE / CRITICAL |
| Roles | `roles` (system + future custom) | System roles seeded per tenant at provisioning |
| `role_permissions` | per role | `scope_mode` ∈ SELF / ASSIGNED / GRANTED |
| `role_assignments` | per user | role + `scope_type` (ORGANIZATION / CAMPUS / DEPARTMENT) + scope id + validity + status |
| `role_grant_rules` | per tenant | *who may grant which role*: `(grantor_role_id, grantable_role_id)` — prevents privilege escalation |
| Resolvers | Code, registered per resource type | translate scope modes into checks/predicates (below) |
| `PolicyEngine` | shared kernel | `assert(ctx, permission, resource)` and `scopeFilter(ctx, permission, resourceType)` |
| Implicit assignments | created by domain events | `students` row ⇒ STUDENT role (scope ORGANIZATION, SELF-mode permissions); `employees(FACULTY)` ⇒ FACULTY; removed when the person record ends |

---

## 2. The authorization path (every request)

```
 1 AUTHENTICATION   verify JWT signature/exp/alg=EdDSA|RS256 only; load session by sid; not revoked/expired
 2 IDENTITY         ctx.userId; resolve ctx.studentId / ctx.employeeId from person tables (not from token claims)
 3 TENANT           session.org == jwt.org == host tenant; open withTenant(ctx) → RLS active          (05 §2–4)
 4 ROLE             effective role_assignments (ACTIVE, valid today) at authz_version in ctx
 5 PERMISSION       does any role of the actor hold the required permission?  no → 403
                    (route-level `requires('perm')`; routes without it are rejected at boot, except an explicit public allowlist)
 6 RESOURCE SCOPE   load the target resource through the tenant-scoped repository (RLS applies).
                    not found → 404.   Then, per grant matching the permission:
                      SELF     → resource.student_id == ctx.studentId   (or employee/user ownership)
                      ASSIGNED → resolver finds an active assignment/queue/step linking actor→resource at the resource's date
                      GRANTED  → resource.{campus_id, department_id} ⊆ grant.scope  (ORG: always, CAMPUS: campus match, DEPT: department match)
 7 RELATIONSHIP     extra relationship rules: guardian link (minors/consent), request step assignee, ticket participant,
                    file link visibility (OWNER_VISIBLE vs STAFF_ONLY), nested-resource parent consistency
 8 ALLOW / DENY     allow ⇒ proceed; deny ⇒ 404 for out-of-scope resources whose existence is private (students, requests, tickets, files,
                    attendance), 403 for permission-level denial on collection/action endpoints.
                    Every CRITICAL decision and every denial on a sensitive permission is audited (risk tier 2).
```

Response indistinguishability rule: for out-of-scope vs non-existent resources the status, body shape and timing class are identical (404 `RESOURCE_NOT_FOUND`).

### 2.1 Worked example — "Student A requests Student B's profile"

`GET /api/v1/students/{B}` with Student A's token.
1. JWT valid; session active. 2. `ctx.studentId = A`. 3. Tenant T matches; `withTenant` sets `app.tenant_id=T`, `app.actor_kind=STUDENT`, `app.student_id=A`. 4. Roles: STUDENT. 5. Permission `student.profile.read` — STUDENT holds it with `SELF`. 6. Repository loads student B — RLS tenant policy passes, the **student-self RESTRICTIVE policy returns zero rows** (B ≠ A) ⇒ repository returns "not found" ⇒ **404**. Even if step 6's SQL were wrong and returned the row, the SELF resolver would deny, again 404. Audit: denial on sensitive permission recorded (tier 2) with `actor=A`, `resource=students/{B}`.

### 2.2 Worked example — "HOD of Dept D1 reads a student in D2"
Permission `student.profile.read` is GRANTED to HOD; grant scope = DEPARTMENT D1; student's department (from active `student_programs.department_id`) = D2 ⇒ out of scope ⇒ 404. In lists, `scopeFilter` adds `student_programs.department_id IN (D1)` to the SQL, so D2 students are never fetched.

### 2.3 Worked example — "Faculty A edits Faculty B's offering data" (arrives with M4)
`attendance.session.mark` is ASSIGNED; resolver: exists `faculty_assignments` for `ctx.employeeId` on the session's `course_offering_id` valid on `session_date` ⇒ otherwise 404. Contract test for the ASSIGNED mechanism exists in M1 using a registered stub resolver; the real resolver tests are mandatory acceptance criteria of M3/M4.

---

## 3. Scope resolution table (initial)

| Resource type | SELF means | ASSIGNED means | GRANTED maps to |
|---|---|---|---|
| User account | `user.id == ctx.userId` | — | none (org-wide for admin); campus/department via the person's active program/posting |
| Student | `student.id == ctx.studentId` | faculty assigned to any of the student's current course registrations (read-only basic profile, M3+) | `student_programs.campus_id/department_id` of the **active** program (or, for historical records, the program valid at the record date) |
| Guardian link | student's own guardians | — | same as student |
| Employee | `employee.id == ctx.employeeId` | — | `employee_postings.department_id` (active primary posting) |
| File | uploader (`uploaded_by`) or linked entity passes | — | via linked entity scope |
| Consent | subject user | — | org-wide `consent.read` for admins (audited) |
| Notification | recipient | — | none (users read only their own) |
| Audit event | — | — | `campus_id` / `department_id` columns on the event; `subject_student_id` requires `audit.event.read_student` |
| Role assignment | own assignments (read) | — | assignment scope must be inside the grantor's scope |
| Attendance session/record (M4) | own records | active `faculty_assignments` on offering at `session_date` | `course_offerings.campus_id` + offering's department |
| Service request / ticket (M5/M6) | requester or subject | current step assignee / queue member | `campus_id`, `department_id` on the row |

Resolvers declare both a **point check** (`canAccess(ctx, resource)`) and a **list predicate** (`toSql(ctx)`); both must be implemented, and a unit test asserts they agree on a fixture matrix (guards the classic "list leaks what the detail endpoint hides" bug).

---

## 4. Rules that make BOLA/IDOR structurally hard

1. Handlers receive IDs; services **load by ID inside the tenant tx and then assert**. No service method accepts a pre-loaded entity from a handler without re-asserting.
2. **Nested routes** (`/students/{sid}/documents/{did}`): the service verifies `document ∈ student` before authorizing; a mismatched parent is 404.
3. **Bulk and list endpoints** use `scopeFilter`; bulk mutations authorize **each** target and fail the whole request (or report per-item) — never partial silent success.
4. **Mass assignment**: all request schemas are `strict()` Zod; ownership/tenant/status/`student_id`/`created_by` fields are not accepted from clients.
5. **Sort/filter/include parameters** are whitelisted per endpoint; no client-supplied column names or relation expansions.
6. **Exports/reports** reuse `scopeFilter`; they never run an unscoped query "for speed".
7. **Writes check the scope of the *target after* the change** (e.g., moving a student to a department outside the actor's scope is denied).
8. **No capability URLs for private data.** Signed file URLs are issued only after authorization and expire in ≤5 minutes.
9. **Identifiers in AI tools** — none (see §8).
10. **Idempotency keys** are scoped to `(tenant, user)`; replaying someone else's key cannot read their response.

---

## 5. Granting roles safely (privilege escalation control)

- `role.assignment.grant` / `revoke` are CRITICAL and require a **reason**.
- A grant is allowed only if all hold: (a) grantor holds `role.assignment.grant` with a scope that **contains** the target scope; (b) `(grantor's role, target role)` exists in `role_grant_rules`; (c) grantor ≠ grantee for roles granting more permissions than they already hold (no self-elevation); (d) target scope valid for the role (e.g., HOD requires DEPARTMENT scope).
- Seed rules: COLLEGE_ADMIN may grant everything except platform realm; CAMPUS_ADMIN may grant DEPARTMENT_ADMIN/HOD/FACULTY/STAFF within their campus; DEPARTMENT_ADMIN may grant FACULTY/STAFF within their department; nobody may grant COLLEGE_ADMIN except COLLEGE_ADMIN.
- **Last-admin protection**: revoking or suspending the last active COLLEGE_ADMIN of a tenant is rejected.
- Every grant/revoke runs in one transaction: insert/update assignment, bump `users.authz_version`, audit row, outbox event. Concurrent grants are serialized per target user with `SELECT … FOR UPDATE` on the user row. *(Implementation note: the repository serialises grants, student creation and employee creation per person with one advisory lock, `shared/authorization/person-identity.ts`; see `21-students.md` §6.)*
- Expiring assignments: nightly expiry job + resolution by date at read time (an expired assignment is ignored immediately even before the job runs).

---

## 6. Minors and guardians

- `isMinor(student, on_date)` is computed from `users.date_of_birth` and `identity.age_of_majority`. Never stored.
- **Student access to own data** is unaffected by age.
- **Guardian access** (contact-level in the pilot; guardian logins post-pilot) is computed: a guardian may receive information only if `student_guardians` link is active **and** `can_view_academics` / `can_receive_notifications` is true **and** the tenant policy allows it for this student (`guardian.academic_visibility`: `MINORS_ONLY` means once the student turns 18 the link stops granting visibility until the student consents).
- **Consent**: for a minor, consents may be granted by a guardian with `can_give_consent`; recorded with `granted_by_user_id`, `guardian_id`, policy text hash. On reaching majority, the system flags consents for re-confirmation by the student (event `consent.reconfirm_required`).
- **Communication**: notification routing consults `guardian.notification_policy` and the link flags; messages to a minor's guardian use a minimal-content template (no grades/health details by email/push).
- **Data minimization**: the only collectable student fields are those registered in `privacy.student_fields`; defaults are the minimum required for admission and teaching (name, admission number, program, institutional contact). DOB is optional unless the tenant requires it. Health, caste/religion, biometric and ID-document data are not collected unless a tenant enables a specific module with its own purpose and retention rule.
- No legal-compliance claim is made by the platform; each jurisdiction requires its own legal/privacy review (open item R-6).

---

## 7. Concurrency and integrity in authorization-sensitive writes

- Optimistic locking: `version` column on mutable aggregates; updates carry `If-Match: "<version>"`; mismatch ⇒ `409 CONFLICT` with the current version (no silent overwrite).
- State transitions use guarded updates (`UPDATE … WHERE id=:id AND status=:expected AND version=:v`); 0 rows ⇒ 409.
- Uniqueness and overlap rules live in the database (UNIQUE, partial UNIQUE, EXCLUDE), not only in code.
- Sequences (admission numbers, request numbers) use `number_sequences` with row locks.
- Appends (attendance submission, approvals) are idempotent via natural keys / idempotency keys.
- Person identity: an account with a student record holds no staff-capable role assignment (`STUDENT`-role assignments excepted; pending future-dated ones count). Enforced by the services under a per-person advisory lock and by database triggers (`21-students.md` §6, migration `0020`; the triggers are active only once the gated migrations have run).
- Authorization cache is keyed by `authz_version`, so a revoked permission cannot be served from cache after commit.

---

## 8. AI authorization

1. The Tool Gateway creates `ctx` from the **user's session** — the model cannot change `tenantId`, `userId`, `studentId`, roles, permissions or scope.
2. A tool is `{name, requiredPermission, scopeMode, inputSchema(strict), outputDto, risk}`. The registry **rejects at boot** any tool whose input schema contains identity-like fields (`*_id` for people/orgs/roles, `email`, `phone`, `tenant`, `role`, `scope`).
3. Student assistant tools only declare SELF-mode permissions. Staff assistant tools (later) declare ASSIGNED/GRANTED permissions, and the engine resolves the actor's scope — the model never passes a scope.
4. Execution inside `withTenant(ctx)` with `actorKind` = the user's kind ⇒ RLS and the student backstop apply.
5. Tool-supplied references to resources (e.g., `ref_no`, `course_ref`) are **lookups within the actor's scope**: the same authorization path as REST. A reference outside scope returns the same "not found" the REST API would.
6. Writes are two-phase (`prepare` → UI-confirmed `submit`) with a confirmation token bound to `(userId, conversationId, payloadHash, expiry)`; replay by another user or with another payload fails.
7. Each call is audited with `actor_type=AI`, `on_behalf_of_user_id`.

---

## 9. Platform realm

Separate login host, separate token audience (`aud=platform`), MFA required, no access to tenant tables except through audited, time-boxed support grants created or approved by the tenant. A tenant JWT is rejected by platform endpoints and vice-versa.

---

## 10. Where each rule is enforced and tested

| Rule | Enforced in | Proven by (see 09) |
|---|---|---|
| Route requires a permission | Boot-time route registry check | S-6 route-coverage test |
| Object-level check | Service layer `policy.assert` | S-6 matrix, BOLA fuzz |
| List scoping | `scopeFilter` in repositories | S-6 list matrix + point/list agreement tests |
| Tenant & student backstop | RLS | S-4, S-5 |
| Grant constraints | `RoleAssignmentService` | S-11 escalation tests |
| AI scope | Gateway + registry boot check | S-9 |
| Concurrency | Optimistic locking + DB constraints | S-12 |
