# Blueprint v3.1 — Final Tenant & Isolation Model

Requirement: Tenant A must never access Tenant B; Student A must never access Student B's private data. This document turns that into mechanisms, and states what each mechanism does **not** protect against.

Terminology: **tenant** = `organization`. **Principal** = authenticated user (or AI acting for a user, or a system job acting for a tenant). **Context** = the immutable `RequestContext` object described below.

---

## 1. Tenant hierarchy and administration

```
Platform (operator realm, separate from tenants)
 └─ Organization (TENANT, the isolation boundary)
     ├─ Campus            ← campus admins
     │   └─ Department    ← department admins / HOD
     └─ Organization-level (college admin, registrar, org-wide staff)
```

| Level | Administered by | Assigned via | Can do |
|---|---|---|---|
| Platform | Operator staff (not tenant users) | CLI + `platform_admins` (separate table, separate auth realm/host, MFA) | Create/suspend tenants, break-glass support access (tenant-approved, time-boxed, audited) |
| Tenant | COLLEGE_ADMIN | `role_assignments(scope_type=ORGANIZATION)` | Everything within the tenant |
| Campus | CAMPUS_ADMIN | `scope_type=CAMPUS` | Everything within one campus; cannot see other campuses |
| Department | DEPARTMENT_ADMIN / HOD | `scope_type=DEPARTMENT` | Everything within one department |

Single-tenant pilot = one `organizations` row and one `campuses` row; every mechanism below is active from day one (nothing is "turned on later for SaaS").

---

## 2. How tenant context is established

1. **Pre-auth (login only).** The host name (`{slug}.campusos.app`, custom domain via `organization_domains`, or `DEFAULT_TENANT` in single-tenant installs) selects the tenant for credential lookup. Credentials are matched only within that tenant (`UNIQUE(organization_id, email)`).
2. **Session creation.** `sessions.organization_id` is stored server-side. The access JWT contains `{sub, org, sid, authz_ver, exp}`.
3. **Every authenticated request** (Fastify `onRequest`, after signature verification):
   - load the session by `sid` (cached 30 s, keyed by `tenant:sid`); reject if revoked/expired or `session.organization_id ≠ jwt.org`;
   - **host-binding check**: the tenant resolved from the request host must equal the session's tenant (blocks a token being replayed against another tenant's hostname);
   - build `RequestContext{tenantId, userId, sessionId, actorKind, studentId?, employeeId?, authzVersion, requestId}` — frozen, created once, stored in `AsyncLocalStorage`.
4. **Tenant never comes from** URL, query, body, or a header supplied by the client. Request fields named `organization_id`/`tenant_id` are rejected by strict Zod schemas.
5. `actorKind` ∈ `STUDENT | STAFF | AI | SYSTEM`. AI acting for a student gets `actorKind=STUDENT` with that student's `studentId` (inherits, never widens). SYSTEM jobs carry the tenant they were enqueued for.

---

## 3. How context reaches repositories and services

```
route handler ──ctx──► application service ──ctx──► repository(tx) ──► Postgres
                         │ policy.assert(ctx, perm, resource)
                         │ audit.record(ctx, event)  (same tx)
```

- Services and repositories **cannot be constructed without a `TenantTx`**. The only way to get one is `db.withTenant(ctx, async tx => …)`, which:
  1. opens a transaction on a pooled connection;
  2. runs `SELECT set_config('app.tenant_id', :tenant, true), set_config('app.actor_kind', :kind, true), set_config('app.student_id', :student, true), set_config('app.user_id', :user, true)` (`true` = transaction-local, safe with PgBouncer transaction pooling and no leakage to the next borrower);
  3. runs the callback; commits/rolls back.
- The raw pool is importable only inside `shared/database`. Enforced by `dependency-cruiser` rules in CI (security gate S-1).
- Repository methods have no `organizationId` parameter to forget: they inherit it from the transaction. Inserts take `organization_id` from `ctx`, never from DTOs.
- Cross-module calls pass `ctx` explicitly (no hidden globals in business code; AsyncLocalStorage is used only by logging and `withTenant` verification).

---

## 4. How database queries are protected — Row Level Security (YES, mandatory)

RLS is the **backstop**, not the primary control (the policy engine is). It guarantees that a missing `WHERE` clause in application code returns nothing from another tenant.

**Roles**

| DB role | Used by | Rights |
|---|---|---|
| `app_migrator` | migrations only | Table owner, DDL. Never used at runtime |
| `app_runtime` | API + workers | `NOSUPERUSER NOBYPASSRLS`, DML on tenant tables; **no** UPDATE/DELETE on append-only tables; no DDL |
| `app_system` | scheduler/outbox relay/SLA poller | Only `EXECUTE` on `SECURITY DEFINER` functions that return `(tenant_id, row_id)` work lists; no table SELECT |
| `app_reporting` *(later)* | read replica analytics | Read-only; RLS applies; per-tenant context required |
| `platform_ops` | CLI tenant provisioning | Can INSERT into `organizations` and seed; every action audited; no BYPASSRLS either (sets the new tenant context while seeding) |

**Policy template (every tenant table)**

```
ALTER TABLE t ENABLE ROW LEVEL SECURITY;  ALTER TABLE t FORCE ROW LEVEL SECURITY;   -- owner is also subject
POLICY tenant_isolation ON t FOR ALL TO app_runtime
  USING      (organization_id = app_tenant_id())
  WITH CHECK (organization_id = app_tenant_id());
-- app_tenant_id() = NULLIF(current_setting('app.tenant_id', true), '')::uuid   → NULL when unset → predicate false → ZERO rows (fail closed)
```

Global tables (`permissions`, `organizations`, `organization_domains`, `platform_admins`): `organizations` is readable only where `id = app_tenant_id()`; hostname lookup before auth goes through a `SECURITY DEFINER` function that returns only `(tenant_id, slug, display_name)`.

**Cross-tenant references** — RLS cannot stop a row in tenant A from *pointing at* tenant B's id. Mitigation: `WITH CHECK` plus composite FKs `(organization_id, x_id)` on the highest-risk joins (attendance_records, marks, file_links, role_assignments, student_programs) and a nightly integrity scan for any FK whose target has a different `organization_id`.

**Honest limits**: `set_config` is callable by any SQL the app role runs, so SQL injection could change the tenant. Mitigations: parameterized queries only (ORM/`sql` tagged template; raw string concatenation banned by lint), no dynamic SQL from user input, DB role has no `EXECUTE` on dangerous functions, and the security gate S-3 greps for unsafe SQL patterns. Per-tenant DB roles/schemas are the next step up if a customer demands it; not needed for the first tenants.

---

## 5. Student isolation backstop in the database

Tables whose rows belong to one student (`attendance_records`, `attendance_summaries`, `marks`, `results`, `service_requests` where `subject_student_id` is set, `consents`, …) get a **second policy**:

```
POLICY student_self_only ON t AS RESTRICTIVE FOR SELECT TO app_runtime
  USING ( app_actor_kind() <> 'STUDENT'  OR  student_id = app_student_id() );
```

Meaning: when the context is a STUDENT (or the AI acting for one), the database itself refuses to return another student's rows even if the service layer has a bug. Staff access is governed by the policy engine (their scope is dynamic—assignments, departments—and not expressible as a cheap RLS predicate). Guardian access (post-pilot) uses `actor_kind=GUARDIAN` with a `app_guardian_student_ids()` list, same restrictive-policy pattern.

---

## 6. Background jobs carry tenant context

Every job is an envelope; there is no job type without tenant.

```
JobEnvelope {
  tenantId   uuid!            // required by the enqueue helper: enqueue() throws if absent
  actor      {kind: SYSTEM|USER|AI, userId?, onBehalfOfUserId?}
  correlationId, requestId?
  type, payload (IDs only; no PII, no authz decisions baked in)
}
```

- `defineJob()` wrapper is the only way to register a worker: it validates the envelope, **rebuilds `RequestContext`**, and runs the handler inside `db.withTenant(ctx)`. A handler that touches the DB outside it fails (no pool access).
- Jobs **re-check authorization at execution time** where the action is user-initiated (e.g., export report: re-evaluate permission when the job runs, not just when enqueued).
- **Scheduled/cross-tenant sweeps** (outbox relay, SLA poller, retention purge, summary rebuild): `app_system` calls `claim_outbox_batch()` / `due_sla_timers()` (SECURITY DEFINER; return only ids and `tenant_id`), then each item is processed by a normal tenant-scoped job. No worker ever holds a connection that spans tenants.
- Queue keys are namespaced (`q:{env}:{type}`); the envelope's tenant is logged in every job log line; dead-letter entries keep the envelope.
- Idempotency: handlers dedupe on `(tenantId, dedupKey)`.

---

## 7. Caching includes tenant and user scope

- **One cache API**: `TenantCache` (wrapper over Redis). Keys are built *only* by the wrapper: `t:{tenantId}:{scope}:{…}` where `scope ∈ {u:{userId}, ref, public}`. Direct Redis client import outside `shared/cache` is banned by lint.
- Categories:
  - **Authorization cache**: `t:{tenant}:u:{user}:authz:{authz_ver}` — a role/assignment change bumps `users.authz_version`, so stale entries are never read (no invalidation race).
  - **Reference data** (departments, courses): `t:{tenant}:ref:…` — contains no per-user data; invalidated by event.
  - **Per-user derived data** (dashboards): `t:{tenant}:u:{user}:…`; never shared across users.
  - **Never cached**: documents, signed URLs, any PII lists, search results containing student data.
- HTTP: all authenticated API responses `Cache-Control: no-store`; `Vary: Authorization, Host`. CDN caches only static assets and public tenant branding (`/public/tenant`).
- Service worker (PWA): caches app shell and a short allowlist of *user-scoped, read-only* GET responses keyed by `userId+tenantId`; cleared on logout and on session change.
- Rate-limit counters: key by `(tenant, user|ip, route-class)`.

---

## 8. Search includes authorization filtering

- **Pilot**: search is Postgres (`pg_trgm`/FTS) executed **in the same `withTenant` transaction** with the policy engine's `scopeFilter(ctx, permission)` predicate in the same query — so RLS (tenant) + scope predicate (campus/department/assignment/self) both apply. There is no separate index to leak.
- **If an external search engine is introduced later** (Meilisearch/Typesense/OpenSearch), mandatory rules: (a) every document carries `tenant_id`, `campus_id`, `department_id`, `student_id` filter attributes; (b) the engine is reachable only from the backend, never from browsers; (c) queries always include the tenant filter (or per-tenant index) and the scope filter derived from `scopeFilter`; (d) **verify-after-search**: returned ids are re-fetched through the normal authorized repository before being returned (the index may be stale or wrong); (e) deletions/revocations propagate via outbox events.
- Autocomplete/user pickers use the same path (no "global" people search in the API; a student cannot search for other students at all — the permission does not exist).

---

## 9. Files, AI, logs, exports

| Surface | Control |
|---|---|
| Files | Object key prefix `{tenant}/…`; `files` under RLS; access derived from linked entity via policy engine; presigned URL issued only after policy check; ≤5 min TTL |
| AI | Tool Gateway builds context from the session (`actorKind=STUDENT`/`STAFF`), runs tools inside `withTenant`; RLS + student backstop apply to AI exactly as to the user; tool schemas contain no identity parameters |
| Logs/telemetry | Every log line has `tenantId`, `userId`, `requestId`; no PII in message bodies; log access is itself a privileged operation |
| Exports/reports | Run as jobs with envelope; re-authorize at run time; file stored as `files` with the requester as sole reader; link expires |
| Email/push links | Signed tokens containing tenant + purpose; consumed within `withTenant` for that tenant |
| Migrations/seed | `app_migrator` only; seeds set tenant context explicitly |
| Support access | `PLATFORM_SUPPORT` context created only by a time-boxed grant row approved in the tenant; actions audited with the grant id |

---

## 10. Student isolation: the authorization path (summary)

`Authentication → Identity → Tenant → Role → Permission → Resource scope → Relationship → Allow/Deny` is specified step by step, with a worked example, in `06-authorization-model-final.md` §2. Three independent barriers protect a student's data:

1. **Policy engine** (object-level check in the service layer).
2. **Query scoping** (`scopeFilter` in the SQL for lists).
3. **RLS** (tenant + student-self backstop in the database).

A request is served only if barrier 1 allows it; barriers 2 and 3 limit damage if barrier 1 has a bug. Tests (see `09`) attack each barrier separately.

---

## 11. How tests prove isolation (index)

| Claim | Proof | Gate |
|---|---|---|
| Every tenant table has `organization_id` + FORCE RLS + policy | Schema linter reads `pg_catalog` in CI | S-2 |
| Unset tenant ⇒ zero rows | DB test as `app_runtime` with no GUC | S-4 |
| Tenant B rows invisible/immutable to tenant A through every endpoint | Generated route × principal matrix | S-6 |
| Student A cannot read B (API, SQL, AI, files) | Matrix + RLS-student tests + AI gateway tests | S-6, S-7, S-9 |
| Jobs cannot run without tenant, cannot cross tenant | Envelope tests + two-tenant worker test | S-8 |
| Cache keys always tenant-scoped | Wrapper unit tests + lint + runtime assertion in tests | S-1, S-10 |
| Cross-tenant FK references never exist | Nightly integrity scan + insert-attempt tests | S-5 |

Details: `09-security-test-strategy.md`.
