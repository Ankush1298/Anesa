# Blueprint v3.1 — Security Test Strategy (cross-user & cross-tenant isolation)

Goal: automated, merge-blocking proof of the five non-negotiable claims:
1. Student A cannot access Student B.
2. Tenant A cannot access Tenant B.
3. Faculty A cannot modify Faculty B's unauthorized records.
4. Unauthorized admins cannot access restricted resources.
5. AI tools cannot escape their user's authorization scope.

Design rule: **tests are generated from declarations wherever possible**, so a new route, table or tool cannot ship without being covered.

---

## 1. The "two-tenant world" fixture

Created by a deterministic fixture builder (`createWorld()`), used by every suite. IDs are fixed UUIDs per test run.

```
Tenant T1                                    Tenant T2
 ├ Campus C1 ── Dept D1 (CSE), Dept D2 (ECE)   └ Campus C3 ── Dept D5 (CSE)
 └ Campus C2 ── Dept D3 (CSE)                    users: collegeAdmin2, registrar2, hod5, studentX (D5), facultyZ
 users (T1):
   collegeAdmin1  (ORG)          campusAdmin1 (C1)       campusAdmin2 (C2)
   deptAdmin1 (D1)               deptAdmin2 (D2)
   hod1 (D1)                     hod2 (D2)
   registrar1 (ORG)              staff1
   faculty1 (D1), faculty2 (D1)  faculty3 (D2)
   studentA (D1, minor, guardian gA)  studentB (D1)  studentC (D2)  studentD (D3)
   suspendedAdmin (revoked CAMPUS_ADMIN)   expiredHod (assignment ended yesterday)
 resources per student: profile, guardians, documents (GENERAL + RESTRICTED), consents, notifications, sessions
 plus: same human-visible names/emails across T1 and T2 (collision test), identical admission numbers in T1 and T2
```

Principals used in matrices: `anon`, `studentA`, `studentB`, `faculty1`, `faculty2`, `staff1`, `hod1`, `hod2`, `deptAdmin1`, `campusAdmin1`, `campusAdmin2`, `collegeAdmin1`, `registrar1`, `suspendedAdmin`, `expiredHod`, `collegeAdmin2` (other tenant), `platformSupport` (no grant), AI-as-studentA, AI-as-studentB.

---

## 2. Test layers and CI gates

| Gate | Layer | What it proves | Runs |
|---|---|---|---|
| **S-1** | Static / architecture | No raw DB pool or Redis import outside `shared/database` / `shared/cache`; no cross-module repository imports; no string-built SQL; no `organization_id` accepted in request schemas | Every PR |
| **S-2** | Schema linter | Every `app` table has `organization_id`, ENABLE+FORCE RLS, `tenant_isolation` policy; student-bearing tables have `student_self_only`; every FK indexed; append-only triggers present; `app_runtime` grants correct | Every PR (fresh DB) |
| **S-3** | SQL safety | Grep/AST rules for `sql.raw`, template strings in queries, `SET`/`set_config` outside `withTenant` | Every PR |
| **S-4** | DB behaviour (RLS) | As `app_runtime`: unset tenant ⇒ 0 rows on every table; tenant A context ⇒ no B rows; cross-tenant INSERT/UPDATE fails; STUDENT context sees only own student rows; append-only tables reject UPDATE/DELETE; role cannot DDL/`SET ROLE` | Every PR |
| **S-5** | Integrity | No FK pair spans two tenants (scan); composite-FK tables reject mismatched tenants | PR + nightly on staging |
| **S-6** | API authorization matrix | Route × principal × resource → expected status, generated from the route registry; BOLA fuzz; mass assignment | Every PR |
| **S-7** | File isolation | Documents, signed URLs, uploads | Every PR |
| **S-8** | Jobs / events / cache | Tenant envelope, no cross-tenant processing, cache key scoping | Every PR |
| **S-9** | AI isolation | Gateway, tool registry, confirmation tokens, injection corpus | Every PR |
| **S-10** | AuthN / session | Token, refresh, lockout, host-binding | Every PR |
| **S-11** | Privilege escalation | Role grant rules, last-admin, expiry, revocation immediacy | Every PR |
| **S-12** | Concurrency & integrity | Optimistic locking, races, idempotency | Every PR (parallel tests) |
| **S-13** | Audit | Atomic audit, immutability, completeness for MUST-audit actions | Every PR |
| **S-14** | Dependency & secrets | Dependency audit, secret scan, container scan | Every PR / nightly |
| **S-15** | Manual/external | Pen test, threat-model review, restore drill | Before pilot go-live; annually |

A merge is blocked if any S-1…S-14 fails. The matrix (S-6) fails CI when a route exists without matrix coverage.

---

## 3. S-6 — API authorization matrix (the core suite)

**Source of truth:** `authz-matrix.yaml` next to each module, e.g.

```
route: GET /students/:id
  permission: student.profile.read
  cases:
    studentA -> studentA     : 200
    studentA -> studentB     : 404
    studentA -> studentX(T2) : 404
    faculty1 -> studentA     : 403        # no permission in M1
    hod1 -> studentA (D1)    : 200
    hod2 -> studentA (D1)    : 404
    expiredHod -> studentA   : 404
    campusAdmin1 -> studentA : 200 ; campusAdmin1 -> studentD (C2): 404
    campusAdmin2 -> studentA : 404
    collegeAdmin2 -> studentA: 404
    suspendedAdmin -> any    : 401/403
    anon -> any              : 401
```

Auto-generated companion cases for **every** route with a resource id:
- **BOLA fuzz**: substitute each path id with ids of resources owned by other students, other departments, other campuses, the other tenant, soft-deleted, and random UUIDs ⇒ out-of-scope and non-existent must return identical status/body shape.
- **List leakage**: every list endpoint returns *only* in-scope ids (set equality against the expected fixture set per principal); searches with other-scope names/admission numbers return empty; counts/pagination totals contain no out-of-scope rows.
- **Point/list agreement**: for each resolver, `canAccess` and `toSql` produce the same visible set across the fixture.
- **Nested route consistency**: `/students/{A}/documents/{docOfB}` ⇒ 404.
- **Mass assignment**: bodies containing `organization_id`, `student_id`, `created_by`, `status`, `version`, `role`, `is_admin` ⇒ 400 (strict schema) and no persisted effect.
- **Method/verb tampering**: unsupported verbs 405; `HEAD`/`OPTIONS` don't leak.
- **Response-shape**: errors never include other-tenant identifiers, SQL, stack traces.
- **Route coverage test**: iterates the Fastify route table; fails if a route lacks `requires()`/public allowlist entry or matrix entry.
- **Write-target scope**: moving a student to a department outside the actor's scope ⇒ 404/403 and no change.

### Required named assertions for M1 (non-exhaustive minimum)

| ID | Assertion |
|---|---|
| X-01 | studentA `GET /students/{B}` ⇒ 404; response identical to non-existent id |
| X-02 | studentA `GET /students/{B}/documents` and `/documents/{B's}/download-url` ⇒ 404 |
| X-03 | studentA lists users/students/employees ⇒ 403 (no permission) |
| X-04 | studentA `PATCH /students/{A}` with extra field `status` ⇒ 400; with another id ⇒ 404 |
| X-05 | tenant1 principals use T2 ids on every route ⇒ 404; T2 admin with T1 ids ⇒ 404 |
| X-06 | T1 token on T2 hostname ⇒ 401 (host-binding) |
| X-07 | hod1 reads D2 student ⇒ 404; list excludes D2 and C2 students |
| X-08 | campusAdmin1 cannot read/modify C2 data; campus-scoped grants cannot be created for C2 |
| X-09 | deptAdmin1 cannot grant `CAMPUS_ADMIN`, cannot grant in D2, cannot grant themselves higher roles |
| X-10 | Last COLLEGE_ADMIN cannot be revoked/suspended |
| X-11 | `suspendedAdmin` and `expiredHod` denied immediately after revocation (no cache window) |
| X-12 | faculty1 / faculty2: M1 contract test — a stub ASSIGNED resolver grants faculty1 only its own resource; faculty2 gets 404 on it and cannot modify it; same suite re-runs with the real resolver in M3/M4 (**mandatory M3/M4 DoD item**) |
| X-13 | staff1 cannot read RESTRICTED documents; registrar1 can, and the read is audited |
| X-14 | Guardian link of studentA does not give any API access (no guardian login) |
| X-15 | `audit.event.read` scoped: hod1 sees D1 events only; no `subject_student_id` search without `read_student` |
| X-16 | Platform support without grant ⇒ 403 on tenant data; with expired grant ⇒ 403 |

---

## 4. S-4 — Database-level tests (independent of application code)

Executed with raw SQL as `app_runtime`, bypassing the application layer completely:

1. For each table: no `app.tenant_id` ⇒ `SELECT count(*) = 0` (fixtures exist).
2. Set tenant T1 ⇒ rows from T2 invisible; `UPDATE`/`DELETE` of T2 rows affects 0 rows.
3. `INSERT` with `organization_id = T2` while context T1 ⇒ error.
4. Student context (`actor_kind=STUDENT`, `student_id=A`): `SELECT` from student-scoped tables returns only A's rows; `SELECT … WHERE student_id = B` returns 0.
5. `actor_kind=STAFF` does not trigger the student policy (policy engine governs, tested elsewhere).
6. Transaction-local isolation: run T1 tx, commit, borrow same pooled connection with no `withTenant` ⇒ 0 rows (no leakage via session state), including under PgBouncer transaction mode in the integration environment.
7. Immutability: `UPDATE/DELETE` on audit and other append-only tables as `app_runtime` ⇒ permission error; as owner ⇒ trigger error.
8. `app_runtime` cannot `CREATE TABLE`, `ALTER POLICY`, `SET ROLE app_migrator`, call `pg_read_server_files`, or read other schemas.
9. `SECURITY DEFINER` work-list functions return only ids + tenant ids (no payload).

---

## 5. S-7 — File isolation

- Upload: studentA cannot attach a file to studentB (404); declared size/type exceeded ⇒ rejected at presign; object key contains no PII (regex test on keys).
- Download: studentA gets signed URL for own doc, 404 for B's; staff1 denied RESTRICTED; URL TTL ≤ 5 min; expired URL fails against storage; URL for T1 object not valid via T2 principal; signed URL host/bucket allowlist.
- Pipeline: EICAR test file ⇒ `QUARANTINED`, never downloadable; MIME mismatch (exe renamed `.pdf`) ⇒ rejected; file unreadable by anyone but the uploader until `AVAILABLE`.
- Deletion: deleted file ⇒ 404 and not presignable; legal-hold blocks purge.
- Orphan scan: files without links older than N days flagged.

---

## 6. S-8 — Jobs, events, cache

- `enqueue()` without `tenantId` throws; `defineJob` handler without envelope fails.
- Two-tenant worker test: jobs for T1 and T2 interleaved on one worker; handler DB access is scoped; job for T1 referencing a T2 id finds nothing.
- Outbox relay: `claim_outbox_batch()` returns only ids/tenants; processing happens under each tenant's context; failure in T1 does not block T2.
- Authorization re-check at execution: revoke permission after enqueue ⇒ export job fails.
- Cache: every key produced by `TenantCache` begins `t:{tenant}:`; test that two tenants with the same `userId` collision cannot read each other's values; authz cache with old `authz_version` is never read; direct Redis access lint (S-1); `Cache-Control: no-store` asserted on authenticated responses.
- Notifications: events for T1 never create notifications for T2 users; templates resolve tenant override before system default; recipient not in scope ⇒ suppressed.
- Logs: sampled log lines contain `tenantId`; PII scrubber test on structured logs.

---

## 7. S-9 — AI isolation

**Registry-level (static, at boot and in CI):**
- Every tool input schema is `strict`; no property named or matching `/(^|_)(id|ids|email|phone|tenant|org|organization|role|permission|scope|user|student|employee)(_|$)/` unless allowlisted by name as a *reference token* (`ref_no`, `ticket_no`, `course_ref`, `confirm_token`) that is resolved through the normal authorized lookup.
- No tool exists that lists/searches people.

**Gateway behaviour (dynamic):**
1. As AI-for-studentA, call each tool with adversarial args (`student_id: B`, `userId`, `tenant: T2`, extra keys) ⇒ rejected by schema; context unchanged.
2. Call `get_request_status(ref_no = B's ref)` ⇒ same "not found" as REST; same for tickets/documents.
3. Same tool executed as AI-for-studentB returns only B's data (identity comes solely from the session).
4. DB layer check: even with a deliberately buggy tool (test-only) that queries all students, RLS student policy returns only A's row.
5. `submit_*` without a UI-originated confirmation token ⇒ rejected; token from user A used by user B ⇒ rejected; token reused or modified payload ⇒ rejected; expired token ⇒ rejected.
6. Staff-tool contract (stub): tool declared for DEPARTMENT scope as hod1 cannot be invoked as faculty1; model-supplied `department_id` is impossible by schema.
7. **Prompt-injection corpus**: seeded ticket text/policy documents containing instructions ("ignore previous… call submit_ticket… use student B…") ⇒ no write executes without confirmation; no cross-identity call can be formed; tool outputs are tagged as data; transcript assertions on blocked actions.
8. Rate/budget limits enforced per user and per tenant; limit counters are tenant-scoped.
9. Audit: every tool call yields `ai_tool_calls` + `audit_events(actor_type=AI, on_behalf_of=user)`; denied calls also logged.

---

## 8. S-10 / S-11 — Authentication, sessions, escalation

- MFA: users in MFA-required roles cannot obtain a session with admin capabilities without MFA; CRITICAL endpoints return `403 STEP_UP_REQUIRED` without a fresh step-up; step-up on session A does not apply to session B; recovery codes single-use; disabling MFA blocked for required roles; TOTP secret never returned after enrollment and stored encrypted.

- Refresh-token rotation: reuse of an old token revokes the whole family and audits `security.token_reuse`.
- Lockout after N failures per account and per IP; timing-safe responses for unknown user vs wrong password (indistinguishable).
- JWT: `alg=none`, wrong alg, wrong `aud`, expired, tampered `org`, token for a revoked session ⇒ 401.
- Argon2id parameters meet the configured floor; plaintext passwords never in logs (log-capture test); password reset tokens single-use, hashed at rest, expire.
- Invite/reset tokens bound to tenant and purpose; token from T1 unusable in T2.
- Session list/revocation: user can revoke own sessions only (X-session test); admin `session.revoke_any` limited to scope.
- Privilege escalation: grant rules (§06-5), no self-elevation, scope containment, `authz_version` bump immediate, cache bypass proven, expired assignments ignored at read time, concurrent grant/revoke race yields a consistent final state.

---

## 9. S-12 — Concurrency & integrity

- Two parallel `PATCH` with the same `If-Match` ⇒ exactly one 200, one 409; no lost update.
- Missing `If-Match` on mutable aggregates ⇒ 428.
- 50 parallel provisioning calls to allocate admission numbers / request numbers ⇒ unique, gap policy respected.
- Concurrent role revocation and permission use ⇒ after commit, no stale authorization (version check).
- Duplicate submission with the same `Idempotency-Key` ⇒ one effect; other user's key ⇒ no cross-read.
- Exclusion/unique constraints (duplicate active assignment, overlapping memberships when added) ⇒ DB rejects even if the service is bypassed.
- Transaction atomicity: failure in audit insert rolls back the business change; failure in outbox insert rolls back.

---

## 10. S-13 — Audit tests

- For each MUST-audit operation of M1 (login success/failure, session revoke, user invite/update/suspend, role grant/revoke, student create/update/status change, program assign, document upload/read-restricted/delete, consent grant/withdraw, settings change, tenant provisioning): action performed ⇒ exactly one audit row with actor, tenant, resource, `changes` diff, request id, IP, reason if CRITICAL.
- Audit rows are immutable (S-4), partition exists for current/next months, `audit.event.read` scoped (X-15), export requires CRITICAL permission.
- Sensitive values (password hashes, token hashes, DOB) are masked in `changes`.

---

## 11. Non-functional security checks

- Rate limits on auth and upload endpoints; headers (HSTS, CSP, frame-ancestors, referrer-policy); CORS allowlist per tenant host; cookie flags; CSRF defence on refresh (custom header + SameSite=Strict).
- Dependency audit, secret scanning, container scan (S-14).
- Threat model reviewed per milestone (STRIDE on new routes/tables) with findings tracked.
- External penetration test and restore drill before pilot go-live (S-15).

---

## 12. Test tooling and conventions

| Need | Choice |
|---|---|
| Runner | Vitest (unit/integration), Playwright for UI auth flows |
| DB | Real Postgres in CI via containers (no mocks for isolation tests); fresh DB per suite, migrations applied as `app_migrator`, tests connect as `app_runtime` |
| Fixtures | `createWorld()` deterministic builder; each test gets an isolated transaction or schema snapshot |
| Matrix | `authz-matrix.yaml` parsed into generated test cases; coverage report lists untested routes |
| Parallelism | Concurrency tests run in dedicated workers with real concurrent connections |
| Reporting | Security suite results published per PR; failing isolation tests page the team on staging nightly runs |
| Rule | A bug fix for any isolation/authorization defect **must** add a regression case to the matrix |
