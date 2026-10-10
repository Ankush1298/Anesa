# Phase 1D: Organization settings registry (implementation note)

Implements the `organization_settings` slice of Milestone 1 Phase 1D. Specification: `02` §4.2, `08` (key registry in
code), `10` rows 18-19, `11` §5.1/5.3/5.4, `09` S-13, `06` §2, `14`. Code: `database/migrations/0012_organization_settings.sql`,
`backend/src/shared/settings/*`, `backend/src/modules/organization/settings.service.ts`, the two routes in
`organization.routes.ts`. Number sequences are **not** part of this slice.

## Dependency decision (evidence)

| Question | Evidence | Result |
|---|---|---|
| Is the settings registry the next Phase 1D item? | `11` §5.1, row 1D: "Campuses/departments/designations, **settings registry**, period types/programs/cohorts, students, student_programs, guardians, employees". Campuses, departments and designations exist; the settings registry is the next named item. | Yes. |
| Does it depend on number sequences? | No foreign key, no use. `02` ties `number_sequences` to admission numbers (§6.1) and service-request reference numbers (`01` C20, `03` §8.8); the registry only stores the *format setting* `identity.admission_number`. | No. |
| Where does the documentation place number sequences? | `11` §5.1, row **1B** (Kernel: "…logging, number sequences"), i.e. an earlier phase than 1D, and not listed in the 1D row. Still unbuilt (no `app.number_sequences`). | It is a Phase 1B carry-over, independent of this slice, and a prerequisite for **students** (admission numbers), not for the registry. The earlier project notes' "settings registry **or** number sequences" framing is not what `11` says. |
| Who consumes the registry? | Students/guardians: `identity.dob_required`, `identity.age_of_majority` (`02` §4.4, ADR-020), `guardian.*`. | Must exist before those slices. |

Correction to the earlier review log: `02` §4.4 does **not** make `employees` depend on `number_sequences` (`employee_code` has
no allocation rule). Number sequences are consumed by students and, later, service requests.

## Data model (`0012`)

`app.organization_settings (organization_id, key, value jsonb, updated_by, version, created_at, updated_at)`, primary key
`(organization_id, key)`, exactly as `02` §4.2 specifies (`key varchar(100)!`, `value jsonb!`, `updated_by!`, `version`).

* **Organization-wide only.** There is no campus or department column. A row is a tenant's choice for one registered key.
* `updated_by` is NOT NULL (the table spec says `updated_by!`) with a **composite** tenant-scoped foreign key
  `(organization_id, updated_by) → app.users (organization_id, id)` and its own index (schema linter S-2).
* `value` is bounded to 16 KiB by a CHECK; the key to 1-100 characters.
* Triggers: `touch_row` (version/updated_at) and `enforce_immutable_keys` (id/organization_id) as on every table.
* **Registry defaults vs. physical rows (approved Decision 2).** `08` §4.1 line 63 notes that "default settings ... [are] seeded per tenant by the provisioning routine". The approved architectural interpretation for Organization Settings is:
  * "Seeded defaults" are logically available through the code registry (`SETTING_DEFINITIONS`).
  * No default rows are inserted during tenant provisioning or migration. Physical rows in `app.organization_settings` are created only when an authorized administrator explicitly overrides a setting.
  * This preserves authorship integrity (`updated_by` non-null FK to `app.users`), enforces strict RLS (`updated_by = current_user_id()`), avoids fake system-user attribution, and prevents uncustomized tenants from freezing code defaults into the database. Clearly, this is the chosen architectural interpretation of the blueprint wording, not a claim that the existing provisioning routine already implements it.
* **Settings history & Milestone 1 contract (approved Decision 3).** The A2 glossary entry in `02` §4.1 defines audit tier A2 as "audit row + mandatory reason + history table", and `02` §4.2 notes "CRITICAL keys A2". However:
  * The authoritative Milestone 1 39-table inventory in `11` §5.2 does not list a dedicated `app.organization_settings_history` table (nor do other M1 A2 entities such as `users`, `role_assignments`, or `consents` have separate history tables in M1).
  * The security test strategy (`09` S-13) requires auditable settings changes with an old/new diff and a reason for CRITICAL actions: "exactly one audit row with actor, tenant, resource, changes diff, request id, IP, reason if CRITICAL".
  * The approved Milestone 1 architectural interpretation is that the atomic `app.audit_events` old/new diff is the settings history record; no separate temporal table is introduced for Milestone 1.
  * Every mutation requires `org.settings.manage` (CRITICAL), a mandatory reason (5-500 chars), and atomically writes a risk-tier-2 audit event in `app.audit_events` with `{ changes: { value: { old, new } } }`. If the audit write fails, the setting is not changed.
  * This is a scoped Milestone 1 interpretation for Organization Settings. It does not claim that every A2 aggregate in every future milestone is exempt from a dedicated history table.

## Registry (code, `shared/settings`)

`SETTING_DEFINITIONS` holds, per key: key, TypeBox schema and optional default. It registers **only keys whose type `02` §4.2
states completely** and invents nothing else:

| Key | Type | Default |
|---|---|---|
| `identity.age_of_majority` | integer, 0..150 | 18 (stated in `02`) |
| `identity.dob_required` | boolean | none stated |
| `guardian.notification_policy` | `NEVER` \| `MINORS_ONLY` \| `ALWAYS_WHEN_ENABLED` | none stated |
| `guardian.academic_visibility` | `MINORS_ONLY` \| `ALWAYS_WHEN_LINKED` \| `NEVER` | none stated |

The 0..150 bound on `identity.age_of_majority` is a technical sanity limit, not a legal rule (`02`: "jurisdiction decision is the
tenant's/legal's, not ours").

**Deliberately not registered** (no complete schema or default in the architecture): `terminology`, `academic.degree_levels`,
`identity.admission_number`, `privacy.student_fields`, `security.password_policy`/session lifetimes, `retention.*`,
`attendance.default_policy_id`, and `identity.unknown_dob_policy` (used in `02` §4.4 but missing from the §4.2 key list, so that list is
not exhaustive). Each is registered by the slice that owns its meaning. A key without a default has no value until set.

## Permissions and scope

* `org.settings.read` (NORMAL; CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR) existed since `0006`. `org.settings.manage` (**CRITICAL**;
  COLLEGE_ADMIN only) is added in `0012` and in the catalog/role matrix; `permission-matrix.test.ts` parses `10` and proves code ≡ document.
* **Scope rule & approved read exception (approved Decision 1).** Organization settings are tenant-wide institutional policies (e.g. `identity.age_of_majority`, `guardian.*`). Under the approved architecture decision:
  * **Reads (`org.settings.read`):** Treated as tenant-wide reference data. Any caller with a valid tenant context holding an effective `org.settings.read` grant at **any** supported assignment scope (ORGANIZATION, CAMPUS, or DEPARTMENT) within the tenant is authorized to read (`GET /settings`). This is a deliberate, documented exception to normal resource-scope containment, enabling `CAMPUS_ADMIN` and campus-scoped `REGISTRAR`s to observe institutional policies they depend on. Normal scope containment remains unchanged for all other resources.
  * **Writes (`org.settings.manage`):** Remain strictly restricted to **ORGANIZATION** scope (`COLLEGE_ADMIN` only). A CAMPUS- or DEPARTMENT-scoped caller is refused with HTTP 403 `FORBIDDEN`.
* Order of checks in `set`: authorization (403) → key registered (404) → reason (400) → value (400). A refused caller cannot probe the registry.
* **System-managed settings:** the architecture names none; none are modelled.

## Audit and atomicity

* `PUT` is a CRITICAL action (`10`: "reason required, always audited"; `06` §2: CRITICAL decisions are risk tier 2; `09` S-13 lists "settings
  change" as MUST-audit). Reason: required, 5-500 characters (`normaliseReason`, as for role grants).
* One `organization.setting.update` audit row per **change**, in the **same transaction**: tier 2, `reason_text`, actor, request id, IP,
  user agent, `changes {value: {old, new}}` (`old` is the previously *stored* value, null when none), `metadata {settingKey, created}`.
  The key is a metadata *value*, not a JSON key (the audit helper rejects sensitive-looking key names). If the audit write fails, the setting is not changed.
* Setting the stored value again is a **no-op**: no write, no version bump, no audit row (as for campuses/departments).
* Reads write no audit event.
* Concurrency: writers of one key are serialized by `FOR NO KEY UPDATE`; under optimistic concurrency (`If-Match: "0"`), two parallel first writes yield exactly one 200 (insert) and one 409 (conflict), preventing lost updates.

## Tenant isolation, RLS, grants

* RLS enabled **and forced**; PERMISSIVE tenant policies for SELECT/INSERT/UPDATE (`organization_id = current_tenant_id() AND context_ok()`); no
  DELETE policy. Missing or partial context returns zero rows and refuses writes.
* RESTRICTIVE write policies: STAFF actors only (a STUDENT session can read but never write), and **authorship cannot be forged**:
  `updated_by = current_user_id()` on INSERT and UPDATE (the audit table applies the same rule to its actor).
* Grants to `app_runtime`: `SELECT, INSERT`, and `UPDATE (value, updated_by)` only. `organization_id`, `key`, `version` and the timestamps cannot be
  updated; there is no DELETE or TRUNCATE.
* STUDENT sessions may *read* the table at the database level because server-side policy checks (for example "is this person a minor") need the
  values; the API still requires `org.settings.read`.

## API (`/api/v1/organization`)

Prefix per `04` §14 (`/organization` domain contains settings). Both require authentication; `PUT` is state-changing, so CSRF token and Origin are required.

| Method | Path | Gate | Result |
|---|---|---|---|
| GET | `/settings` | `org.settings.read` | Every registered key that has a value: stored, or the registry default (`isDefault: true`, `version`/`updatedAt` null). |
| PUT | `/settings/{key}` | `org.settings.manage` | Body `{ value, reason }` (no other field: tenant, user and version are never accepted). 200 with the resulting record. |

`GET /settings/{key}` is not in `11` §5.4 and was not added. The two routes are the only ones in the architecture's settings area.

## Concurrency and ETag / If-Match contract

Optimistic concurrency for `app.organization_settings` is implemented per `08` §4.1, `ADR-021`, and `09` S-12:

### 1. ETag distinction (collection vs. item)
* **`GET /settings`**: Sets a weak collection ETag in the `ETag` header (`W/"<hash>"`), deterministically hashed from all returned keys and versions via `computeCollectionETag`. This weak tag represents the state of the whole collection.
* **`PUT /settings/{key}`**: On successful update or creation, sets a strong entity tag in the `ETag` header: `"${version}"` (e.g. `"1"`, `"2"`).
* **Cross-route distinction**: The collection ETag (`W/"..."`) represents the collection and MUST NOT be sent in `If-Match` on `PUT /settings/{key}`. Doing so is rejected with 400 `BAD_REQUEST`.

### 2. Client derivation of `If-Match`
* For existing stored settings (`isDefault: false`, `version: N` where $N \ge 1$): clients extract the numeric `version` from `GET /settings` (or a prior `PUT`) and format it as `If-Match: "${version}"` (e.g. `If-Match: "2"`).
* Unquoted positive integers (e.g. `If-Match: 2`) are also parsed as version $N$.

### 3. Initial-write precondition (unpersisted defaults)
* For unpersisted settings (`isDefault: true`, `version: null`), the client asserts that no stored row exists by sending `If-Match: "0"` or `If-Match: "null"`.
* **Application-specific convention**: The `"0"` / `"null"` sentinel in `If-Match` is an application-level contract for unpersisted defaults, NOT standard RFC 9110 HTTP semantics (RFC 9110 §13.1.2 defines `If-None-Match: *` for conditional creation). In this repository, `08` §4.1 and `09` §9 mandate `If-Match` across all versioned mutations.

### 4. Header grammar and validation
* **Supported**:
  * Positive integers: `"<version>"` or `<version>` (`/^[1-9]\d*$/`).
  * Initial sentinels: `"0"`, `0`, `"null"`, `null`.
  * Wildcard: `*` or `"*"` (matches if row exists at any version).
* **Weak entity tags rejected (RFC 9110)**: Any header starting with `W/` (e.g. `W/"1"`, `W/*`) is rejected with HTTP **400 `BAD_REQUEST`** (`code: 'BAD_REQUEST'`, message: `Weak entity tags cannot be used in If-Match headers.`). RFC 9110 §13.1.1 and §8.8.3.2 mandate strong comparison for `If-Match`.
* **Comma-separated tag lists unsupported**: Comma-separated entity-tag lists (e.g. `"1", "2"`) are not supported by this API and are rejected with HTTP **400 `BAD_REQUEST`** (`Invalid If-Match header.`).
* **Malformed values**: Negative numbers, decimals, non-numeric strings, and empty strings (`""`) are rejected with HTTP **400 `BAD_REQUEST`**.

### 5. Error and concurrency responses
* **Missing header**: If `If-Match` is missing or whitespace, returns HTTP **428 `PRECONDITION_REQUIRED`** (`code: 'PRECONDITION_REQUIRED'`, `If-Match header is required.`).
* **Stale version**: If the submitted version differs from stored version, returns HTTP **409 `CONFLICT`** (`code: 'CONFLICT'`, `Setting version mismatch.`).
* **Stale no-op**: Version check executes *before* no-op evaluation. Submitting a stale version when the payload matches the current stored value still rejects with **409 `CONFLICT`**.
* **Initial collision**: Submitting initial sentinel (`"0"`) when a row already exists returns HTTP **409 `CONFLICT`**.
* **Concurrent first writes**: Two parallel first writes both sending initial sentinel (`"0"`) serialize via `FOR NO KEY UPDATE` and `ON CONFLICT DO NOTHING`: exactly one succeeds with HTTP 200 (version 1), and the other fails with HTTP **409 `CONFLICT`** (no lost update).
* **Concurrent updates**: Two parallel updates sending the same version serialize via row lock and version guard (`WHERE version = $5`): exactly one succeeds with HTTP 200 (version $N+1$), and the other fails with HTTP **409 `CONFLICT`**.

## Approved architecture decisions (2026-10-11)

1. **Read access (Decision 1):** Tenant-wide reads permitted for any holder of `org.settings.read` at any valid assignment scope (ORGANIZATION, CAMPUS, DEPARTMENT), enabling `CAMPUS_ADMIN` and campus-scoped `REGISTRAR`s to read institution-wide policies. Writes (`org.settings.manage`) remain strictly restricted to ORGANIZATION scope (`COLLEGE_ADMIN`).
2. **Registry defaults (Decision 2):** Defaults live in the code registry (`SETTING_DEFINITIONS`). Physical `app.organization_settings` rows are reserved for administrator overrides. No rows seeded during provisioning or migrations, preserving authorship integrity and RLS without synthetic users.
3. **Settings history (Decision 3):** For Milestone 1, atomic append-only audit events in `app.audit_events` with old/new value diffs and mandatory reasons satisfy the settings history requirement within the authoritative 39-table schema limit (`11` §5.2); no dedicated history table is introduced.

## Open points (remaining for future milestones)

1. **Further keys.** Schemas and defaults for the unregistered keys; whether `identity.unknown_dob_policy` belongs in the registry.
2. **If-Match / ETag on other aggregates.** Optimistic concurrency with `If-Match` and `ETag` is now implemented for `app.organization_settings`. Extending this exact pattern to the other mutable aggregates named in `08` §4.1 (`users`, `students`, `employees`, `role_assignments`, `campuses`, `departments`, `programs`, `cohorts`, `guardians`), as well as `designations` (`08` §5, migration `0011`), remains an open task for their respective milestones.
3. **Step-up and second approver** for CRITICAL actions: not implemented anywhere (`14`).

## Operational notes

* `0012` is an ordinary migration but follows the contract gate: an ordinary `pnpm db:migrate` stops at `0009`, so `0010`-`0012` are applied only
  after `0009` has been authorized (`--allow-contract 0009`, per the rollout runbook).
* The migration registers the permission only. **Existing tenants** must have `seedTenantRoles` re-run to receive `org.settings.manage`
  (COLLEGE_ADMIN); new tenants get it at provisioning.

## Verification map

| Property | Test |
|---|---|
| Registry shape, exact key list, validation matrix, hostile inputs | `tests/unit/settings-registry.test.ts` |
| Authorization matrix (tenant-wide read for CAMPUS_ADMIN/REGISTRAR/DEPT, org-scoped manage, refusal of non-holders), validation, audit content, audit rollback, no-op, concurrency, tenant isolation | `tests/integration/organization-settings.test.ts` |
| HTTP: auth, CSRF/Origin on PUT, role matrix, schema vs service validation, audit through the stack, tenants | `tests/integration/organization-routes.test.ts` |
| Privileges, policies, forged authorship, student session, cross-tenant, constraints | `tests/security-db/organization-settings.test.ts` |
| Linter rules, privilege lists, permission count | `schema-linter`, `roles-and-privileges`, `authorization-rls` (security-db) |
| Code ≡ doc 10 for the new permission | `tests/security/permission-matrix.test.ts` |
| Migration lists include `0012` | `migrations.test.ts`, `migration-contract.test.ts`, `migrate-plan.test.ts` |
