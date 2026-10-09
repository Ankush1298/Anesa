# Slice 3 — Authorization scopes and trusted data (implementation note)

Implements `06-authorization-model-final.md` and the subset of `10-milestone-1-permission-catalog.md`
needed for Slice 3. Code: `backend/src/shared/authorization/**`. Migrations: `0005`, `0006`.

## Decision log (deviations are deliberate and small)

| Topic | Decision |
|---|---|
| Scope vocabulary | `scope_mode` ∈ SELF / ASSIGNED / GRANTED stays (docs 06/08/10 define it). It is **not** a catch-all: GRANTED is bounded by the role *assignment's* `scope_type` (ORGANIZATION / CAMPUS / DEPARTMENT) and the resource must prove membership. |
| Catalog | Trimmed to the 10 permissions in doc 10 that Slice 3 needs. `attendance.*` (reserved namespace, doc 10 §3) and `student.profile.update` (not in the catalog) were removed by migration `0006`. A test keeps code ≡ doc 10. |
| FACULTY | `student.profile.read` (ASSIGNED) is **not** seeded (doc 10 footnote 1). The ASSIGNED mechanism is proven with a registered stub resolver. |
| `platform.permissions` | Global reference data, no tenant column → no RLS. The constant-true policy from `0005` was removed. Runtime has `SELECT` only. |
| Migration `0005` | Left untouched (checksummed); fixes are in `0006`. |

## Meaning of each scope and the trusted data it is evaluated against

| Mode / assignment scope | Allows when | Trusted evidence (never from the client) |
|---|---|---|
| SELF | `resource.user_id == ctx.userId`, or `resource.student_id ==` the student row mapped to `ctx.userId` | `TrustedContext` (issued after session validation) and `app.students.user_id` read inside the tenant transaction. A URL id is only the *target* being compared. |
| ASSIGNED | the resolver registered for that permission proves an actor→resource relationship | The resolver's own tables (M3/M4). **No resolver ⇒ deny.** |
| GRANTED + ORGANIZATION | `resource.organization_id == ctx.tenantId` | organization_id of a row loaded under RLS |
| GRANTED + CAMPUS(c) | org matches **and** `resource.campus_id == c` | campus attribute of the loaded row; `c` from `role_assignments.scope_id` |
| GRANTED + DEPARTMENT(d) | org matches **and** `resource.department_id == d` | department attribute of the loaded row |

Rules that hold for every decision:

* Effective assignment = `status='ACTIVE' AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`, same tenant. Revoked, expired and future-dated rows grant nothing.
* A user holds the **union** of grants of all effective assignments; the result does not depend on row order.
* A missing attribute denies (a CAMPUS grant never matches a resource that carries no `campus_id`).
* Resource given and not allowed (no permission, wrong scope, other tenant, nonexistent) ⇒ one identical `404 RESOURCE_NOT_FOUND`. No resource (collection/action endpoint) and no permission ⇒ `403 FORBIDDEN`.
* Handlers must build `ResourceScope` from a row loaded through the tenant transaction. `extractScope` in route config may carry the URL's *target* id (`student_id` / `user_id`) only; a static test forbids request data feeding tenant/campus/department/role/permission.

## Role assignment safety (`RoleAssignmentService`)

* Grantor needs `role.assignment.grant|revoke`; target user and role must exist **in the tenant** (else the same 404).
* `GRANT_RULES` (doc 06 §5): COLLEGE_ADMIN → all roles; CAMPUS_ADMIN → DEPARTMENT_ADMIN, HOD, FACULTY, STAFF; DEPARTMENT_ADMIN → FACULTY, STAFF. Only COLLEGE_ADMIN grants COLLEGE_ADMIN.
* The grantor must hold an effective assignment whose role may grant the target role **and whose scope contains** the target scope (`scopeContains`). A campus admin cannot yet grant at DEPARTMENT scope because there is no department→campus relation to prove containment; this fails closed.
* No self-grant, no self-revoke. Role ↔ scope-type validity per `ROLE_SCOPE_TYPES` (e.g. HOD needs DEPARTMENT).
* Database: user/role/scope/start immutable, REVOKED/EXPIRED terminal, `valid_until > valid_from`, runtime may only update `status`/`valid_until`, no DELETE.

## Known limits (carried to later slices)

* ~~`scope_id` has no foreign key~~ (superseded by F2.1, `18-academic-structure-f21.md`): campuses and departments exist, `role_assignments` carries typed `campus_id` / `department_id` with same-tenant composite foreign keys, and from migration 0009 the strict `ra_scope_integrity_ck` requires them to agree with `scope_id`. The engine still evaluates `scope_id`; the typed columns are the integrity/FK layer.
* Role grant/revoke are now audited with a mandatory reason (F1, `17-audit-foundation.md`). Still not implemented: auditing of any other operation, denial auditing, an audit viewer, MFA step-up for CRITICAL permissions and the `authz_version` cache key.
* `role_grant_rules` is a code constant, not a tenant table.
* `roles` / `role_permissions` are read-only for `app_runtime`; provisioning (seeding a tenant) is a platform operation (`seedTenantRoles`).
