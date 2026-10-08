# Smart Campus OS — Architecture Blueprint v3 (Pre-Implementation Lock)

> Status: Proposed for founder approval. Supersedes v1/v2 wherever they conflict. No application code, migrations, controllers or components are produced in this phase.
> **v3.1 revision (this update):** configurable academic structure, configurable attendance policies, face/biometrics isolated as a future optional module, under-18 support, tenant-context propagation, Milestone 1 re-scoped. Where this file's Part 1 text (C2, C14–C16, §1.5 face items) conflicts with v3.1, **v3.1 wins** — see `05`–`11` and `docs/decisions/ADR-*.md`.
> Inputs reviewed: `smart_campus_os_architecture_v1.md`, `smart_campus_os_architecture_v2.md`, and the current scaffold (all files empty except `scaffold.sh`; `docs/decisions/ADR-001-face-attendance.md` is empty).

| File | Parts |
|---|---|
| `01-review-tenancy-domain.md` (this file) | 1 Review · 2 Tenancy · 3 Domain model |
| `02-database-history-identity.md` | 4 Database · 5 Historical data · 6 Student identity |
| `03-authz-services-platform.md` | 7 Authorization · 8 Service engine · 9 Tickets · 10 AI · 11 Audit · 12 Files · 13 Notifications |
| `04-api-frontend-phasing-adrs.md` | 14 API · 15 Frontend · 16 Phasing · 17 ADRs · Status · Next action |
| `05-tenant-isolation-model.md` | v3.1 final tenant & isolation model |
| `06-authorization-model-final.md` | v3.1 final authorization model |
| `07-domain-model-final.md` | v3.1 final domain map, academic/attendance model |
| `08-database-blueprint-final.md` | v3.1 final database blueprint |
| `09-security-test-strategy.md` | v3.1 cross-user / cross-tenant security tests |
| `10-milestone-1-permission-catalog.md` | v3.1 Milestone 1 permission catalog |
| `11-readiness-and-milestone-1.md` | v3.1 freeze candidates, remaining decisions, readiness, Milestone 1 spec |
| `docs/decisions/ADR-001…022` | Architecture decision records |

---

## PART 1 — ARCHITECTURE REVIEW

### 1.1 Decisions that are solid (keep)

| Decision | Why it holds |
|---|---|
| Modular monolith (Fastify + TS), face-service as the only separate process | Right size for 3–5 engineers; face service is genuinely different (Python, CPU/GPU heavy). |
| PostgreSQL as the single system of record; Drizzle; Redis/BullMQ for async | Academic records need ACID and relational integrity. Nothing here needs another datastore yet. |
| REST, `/api/v1`, Zod validation, cursor pagination, idempotency keys | Simple, cacheable, auditable, easy for AI tools to wrap. |
| Service requests as configuration, not per-request-type code | Correct instinct; refined in Part 8 (versioning + coded action hooks). |
| Append-only audit, immutable attendance/marks history | Correct; tightened in Part 11 (transactional, not async). |
| Storage abstraction over S3 API (R2/MinIO/S3 = one SDK, different endpoint) | Thin and cheap. |
| Face attendance is an accelerator, never a gate; manual always available | Correct and important for fairness/legal exposure. |
| PWA first, native later | Saves months; camera/selfie works in browser. |
| `organization_id` on every table | Right foundation (extended with RLS and tests below). |

### 1.2 Decisions that need clarification

| Item | Ambiguity in v1/v2 | Resolution |
|---|---|---|
| "Organization" meaning | v1 says "university, college trust, group of colleges" — three different things. | **Organization = one legal institution that owns its data (a college/university). It is the tenant.** Groups come later as a separate `organization_groups` concept for reporting only. |
| Campus role | v1 says "multi-campus isolation is at this level", but queries are filtered only by `organization_id`. | **Campus is an authorization/scope boundary, not an isolation boundary.** Isolation = organization. Campus = scope on role assignments. |
| Where face embeddings live | v2: "InsightFace internal store". Undefined for backup, deletion, HA. | Decide in ADR-016: face-service owns a separate Postgres schema (pgvector) with its own DB role; backend never reads it. |
| Who is "the student" in FKs | v1 uses `student_user_id` everywhere; `student_profiles` is a 1:1 extension. | Introduce `students.id` as the permanent student key; all academic facts reference `student_id` (Part 6). |
| HOD | `departments.head_user_id` column. | HOD is a **role assignment** scoped to a department, effective-dated. No column. |
| Reference-number scope | `service_requests.reference_number UNIQUE` is global across tenants. | Unique per `(organization_id, ref_no)`; generated from `number_sequences`. |

### 1.3 Decisions that must change

| # | v1/v2 decision | Change | Why |
|---|---|---|---|
| C1 | `student_profiles.current_cohort_id / current_section_id` | **Removed.** "Current" is derived from enrollment history (view). | Mutable pointers destroy history and drift from enrollment rows. |
| C2 | `semesters.cohort_id` with `is_current` + `is_locked` booleans; `sections.semester_id` | Replace with **`academic_years` → `terms` (calendar, per campus) → `cohort_periods` (cohort × term, carries semester number) → `sections`**. Status enum instead of `is_current`. | A "semester" is two things: a calendar window and a cohort's Nth semester. Conflating them blocks repeats, backlog students, transfers, per-campus calendars. `is_current` as boolean is unenforceable. |
| C3 | `enrollments UNIQUE(student, semester)` with one `section_id` | Replace with **four layers**: `student_programs` → `term_enrollments` → `section_memberships` (effective-dated) → `course_registrations` (student × offering). | One row per semester cannot express a mid-term section change, electives, backlog papers, or transfer. Attendance denominators need course-level registration. |
| C4 | `subject_offerings.faculty_user_id` (single, mutable) | **`faculty_assignments`** (effective-dated, with role: PRIMARY / CO / LAB / SUBSTITUTE). `class_sessions.conducted_by_employee_id` records who actually taught. | Faculty change mid-term would rewrite who "owned" past attendance. Substitutes are normal. |
| C5 | `subjects` / `subject_offerings` naming and mutable title/credits | Rename to **`courses` / `course_offerings`**; offerings **snapshot** code/title/credits on publish. | Catalog edits must not rewrite old transcripts. "Course" is the standard term for exam/result domain. |
| C6 | `attendance_records.is_corrected` + `correction_reason` overwriting the row | **`attendance_record_revisions`** (append-only) + `revision_no`. | A boolean flag loses what it was before and who approved. Disputes are the #1 attendance support case. |
| C7 | `attendance_records.student_user_id`, rows only for marked students | Rows for **every registered student at submission** (`student_id`, `course_registration_id`). | Without a snapshot roster, "absent" is inferred and percentages shift whenever enrollment changes. |
| C8 | JWT embeds `permissions[]` (v1 §14.4) while also caching permissions in Redis with invalidation (v1 §9.3) | JWT carries only `sub, org, sid, authz_ver`. Permissions/scopes resolved server-side from cache keyed by `authz_ver`. | Scoped grants (department, assignment) don't fit a token; embedded permissions are stale for up to 15 min after revocation. The two designs contradict each other. |
| C9 | Permission strings with scope suffix (`attendance.read.own/.dept/.all`) | Permission = `attendance.read`; scope lives on **role_permissions.scope_mode** and **role_assignments.scope** (Part 7). | The suffix scheme explodes combinatorially and can't express "assigned course" or campus scope. |
| C10 | `user_roles UNIQUE(user, role, org)` | Role assignments unique per `(user, role, scope)`. | The same person can be HOD of one department and faculty in another; v1's constraint forbids it. |
| C11 | Async "audit log flush" worker (v1 §7.9) | Must-audit events are written **in the same DB transaction** as the change. | Async audit can lose the record while the change commits. |
| C12 | SLA via BullMQ delayed jobs per step | **DB-backed `sla_timers`** polled by a worker; BullMQ only runs the poller. | Redis restart loses scheduled jobs; pause/resume and priority change need rescheduling; DB is the source of truth. |
| C13 | Per-module attachment tables (`service_request_attachments`, `ticket_attachments`) | Central **`files` + `file_links`**. | One scanning/retention/ACL pipeline instead of N. |
| C14 | Face token/window columns on `class_sessions` | **Superseded in v3.1:** no capture or face tables in the core schema at all; an optional capture module (QR/biometric) owns its own tables and calls the attendance service. | Core attendance must not depend on any capture method. |
| C15 | Face "Mode A" classroom group-photo scan | **Cut.** Face attendance entirely deferred (v3.1). | Captures non-consenting bystanders, high false-match risk, 15–30 s CPU latency, weak legal footing. |
| C16 | Mode B selfie + static QR token | Add anti-proxy controls: rotating short-lived code shown in class, optional IP/Wi-Fi range check, faculty review queue for low confidence. | A student can check in remotely with a photographed QR; liveness alone doesn't prove presence. |
| C17 | AI uses student's JWT to call HTTP APIs (v1 §13.5) | AI Tool Gateway calls **application services in-process** with an `ActorContext{actor_type: AI, on_behalf_of}`; same policy engine. | Passing user tokens through an LLM orchestrator widens the blast radius; the invariant that matters is "same authorization path", not "same HTTP hop". |
| C18 | `is_active` / `deleted_at` / status used inconsistently | One rule: `status` for lifecycle; `deleted_at` only where erasure is legally possible; historical facts never deleted. | Inconsistent soft-delete leads to resurrected rows and broken uniqueness. |
| C19 | UUID v4 (`gen_random_uuid`) PKs | **UUIDv7** generated in the app. | Time-ordered keys avoid index bloat on large append tables (attendance, audit). Postgres 15 has no native v7, so generate app-side. |
| C20 | `reference_number` generated "auto-increment per org per year" with no mechanism | `number_sequences` table with row lock. | Gap-free, per-tenant, per-year numbering needs an explicit allocator. |

### 1.4 Decisions that could create technical debt later

1. **One mutable `users.organization_id` and email unique per org** — fine now; a person at two tenants needs two accounts. Accept deliberately; leave room via `external_identities`.
2. **JSONB `form_data` on requests** — fine for display and light filtering; reporting on fields will need promoted columns. Mitigation: schema flag `report: true` triggers a generated index/column later.
3. **Timezones**: v1 stores `TIMESTAMPTZ` but never says which zone defines "a class day". Add `campuses.timezone` and `class_sessions.session_date` (campus-local date) now; retrofitting is painful.
4. **Wall-clock SLA hours** — acceptable at MVP; business-hours calendars will be requested. Keep `business_calendar_id` nullable on `sla_policies`.
5. **Numeric money as DECIMAL** — use integer minor units + currency to avoid rounding bugs when Finance arrives.
6. **No domain-event backbone** — direct calls from attendance → notifications will entangle modules. Add a transactional outbox from day one (Part 13).
7. **Roles hard-coded in code vs data** — permissions catalog lives in code and is seeded; roles are data. Mixing causes drift between environments.
8. **Parent portal "supported by architecture"** — only true if guardians are first-class (`guardians`, `student_guardians`) with their own consent flags. Included in the model.
9. **No import framework** — CSV import will be the most-used admin feature and the main source of bad data. `import_jobs` with a validate-then-commit step belongs in Milestone 2.

### 1.5 Over-engineering (cut or defer)

| Item | Recommendation |
|---|---|
| Three face providers (InsightFace, AWS Rekognition, Azure) | Build the interface, **ship one** (InsightFace). Add others on customer demand. |
| Face attendance in the first 20 weeks | Move **after** manual attendance is live at the pilot (post-pilot milestone). Needs biometric-consent legal review (India DPDP Act 2023; minors need guardian consent). |
| Hybrid deployment as a day-one product | Keep **Docker-first, env-driven config** (cheap). Defer the polished `install.sh` + support commitment until the second self-hosted customer. One image, cloud-first. |
| Resend + SMTP providers | One path: **SMTP** (Resend and most hosts expose SMTP). Interface stays. |
| Loki/Prometheus/Grafana/OpenTelemetry stack at MVP | Pino JSON logs + Sentry + uptime ping. Add metrics when there's traffic to measure. |
| MFA, SAML | Schema-ready (`external_identities`, `auth_methods`); no implementation. |
| React Native / Expo planning | Not before PWA proves demand. |
| Typesense/Meilisearch, pgvector before AI | Postgres `pg_trgm`; pgvector only when AI milestone starts. |
| Separate `(hod)` route group | HOD is a role, not a persona. Fold into staff shell. |
| Generic BPMN-style workflow engine | Explicitly **not** building it (Part 8: linear steps + coded hooks). |

### 1.6 Under-engineering (add now)

| Gap | Add |
|---|---|
| Academic year / term entities | `academic_years`, `terms`, `cohort_periods` |
| Enrollment history and course-level registration | Four-layer enrollment model (Part 5) |
| Student identity separation | `students`, `student_identifiers`, immutable `admission_number` |
| Session management | `sessions` table with refresh-token family + reuse detection |
| Consent record | `consents` table (face, communications, data processing) |
| Tenant safety net | RLS with `SET LOCAL`, non-superuser app role, automated cross-tenant tests, schema linter |
| Transactional outbox | `outbox_events` |
| Number allocator | `number_sequences` |
| Import jobs | `import_jobs`, `import_job_rows` |
| Work queues | `work_queues` (department/team inboxes for requests and tickets) |
| Data lifecycle | Retention policy per file/audit/notification class; anonymization procedure for users |
| Read-access auditing | Log access to sensitive records (ID documents, face logs, bulk exports) |
| Backup/restore drill | Tested restore as Milestone-7 exit criterion |
| Operational safety | Self-host compose in v2 exposes `api:4000` and `web:3000` directly, bypassing Caddy; bind to internal network only |

---

## PART 2 — MULTI-COLLEGE / MULTI-CAMPUS MODEL

### 2.1 Answers

| Question | Answer |
|---|---|
| What is the tenant? | **Organization** — one institution that legally owns the data, has its own admins, academic regulations and contract. |
| Is a college a tenant? | **Yes**, in the normal case. Rule for edge cases: if colleges share students, staff, regulations and a central administration → one organization with several campuses. If they are separate legal entities or data owners → separate organizations (optionally linked by `organization_groups` for group-level reporting). |
| Can a tenant have multiple campuses? | **Yes.** `campuses` belong to an organization. Departments belong to a campus. Courses (catalog) are organization-level so a shared curriculum can be offered at several campuses. |
| Can users belong to multiple campuses? | **Yes, via role assignments.** A user belongs to exactly one organization; staff may hold assignments at several campuses/departments. A student belongs to one campus at a time via `student_programs` (a transfer is a new `student_programs` row). |
| How does isolation work? | Organization isolation by `organization_id` on every row + Postgres RLS + request context + tests. Campus/department limits are enforced by the policy engine (Part 7), not RLS. |
| How are administrators scoped? | `role_assignments(role, scope_type ∈ {ORGANIZATION, CAMPUS, DEPARTMENT}, scope_id)`. A campus admin sees only that campus; a college admin has ORGANIZATION scope. A **platform admin** is a separate account type outside tenants. |
| How do queries enforce boundaries? | Four layers below. |
| How are files isolated? | Key prefix `{org_id}/…`, `files.organization_id` check on every access, per-class buckets, signed URLs only after policy check (Part 12). |
| How is AI isolated? | The Tool Gateway injects `org`/`user` from the session; tools never take student or org IDs from the model; RAG documents are filtered by `organization_id` + audience before retrieval; conversations stored per org (Part 10). |
| How does reporting work across tenants? | Three levels: **within org** (scoped queries), **org group** (future analytics read model), **platform** (aggregated, non-PII usage metrics emitted by a job into a separate schema). No cross-tenant SQL on the OLTP database. |

### 2.2 Enforcement layers (all four required)

1. **Request context.** Tenant is derived from the authenticated session (and host name for the login page), never from URL/body. `ActorContext{org_id, user_id, session_id, actor_type}` is created once per request.
2. **Repository discipline.** All DB access goes through repositories built from a `TenantDb` handle that opens a transaction and runs `SET LOCAL app.org_id = …`. Lint rule: no direct DB import outside repositories.
3. **Postgres RLS.** Every tenant table has `USING (organization_id = current_setting('app.org_id')::uuid)` for SELECT/UPDATE/DELETE and `WITH CHECK` for INSERT/UPDATE. The app connects as a non-owner role without `BYPASSRLS`; migrations run as a different role. Works with PgBouncer transaction pooling because the setting is `SET LOCAL` inside the transaction.
4. **Automated proof.** (a) Schema linter in CI fails if a table lacks `organization_id` + RLS policy (allow-list for global tables: `permissions`, `organizations`). (b) A cross-tenant test suite seeds two orgs and asserts every list/get/mutate endpoint returns 404/empty for the other tenant. (c) Nightly integrity query finds rows whose FK targets belong to a different `organization_id` (substitute for composite FKs; use composite FKs only on `attendance_records` and `marks`).

Platform operations use a separate DB role and an explicit, audited `with_platform_access(reason)` wrapper. Support "break-glass" access to a tenant is time-boxed, requires the tenant admin's approval or a ticket reference, and writes `actor_type = PLATFORM_SUPPORT` audit events.

### 2.3 Tenant resolution

- Cloud: `{slug}.campusos.app` or a custom domain (`organization_domains`) → organization. Login resolves the organization from the host.
- Self-hosted: single organization, `DEPLOYMENT_MODE=single_tenant` selects it implicitly. Same code path, same schema.

### 2.4 Scope-bearing columns

Rows that authorization or reporting must filter by campus/department carry denormalized `campus_id` (and `department_id` where a department owns the record): `student_programs`, `course_offerings`, `class_sessions`, `service_requests`, `tickets`, `examinations`, `files` (optional). Set at creation; changed only by an explicit transfer operation (audited).

### 2.5 Pilot configuration

Seed one `organizations` row and one `campuses` row. No multi-tenant UI. Everything else is identical to the multi-tenant design — this is the "start with one college" guarantee.

---

## PART 3 — COMPLETE DOMAIN MODEL

Conventions used below: **Req** = required fields; **Opt** = optional fields (all entities also carry the standard columns in Part 4.1). **Owner** = who may create/modify. **Audit** = A0 none (standard timestamps only), A1 audited create/update/delete via `audit_events`, A2 = A1 + mandatory reason + immutable history/revision table.

### 3.1 Platform & Tenancy

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| Organization | Tenant | name, slug, status, default_timezone, default_locale | legal_name, logo_file_id, settings, organization_group_id | 1..* Campus | Platform admin; ACTIVE→SUSPENDED→ARCHIVED | slug unique; never hard-deleted | A1 |
| OrganizationDomain | Hostnames mapping to a tenant | organization_id, hostname | is_primary, verified_at | →Organization | Platform admin | hostname globally unique | A1 |
| OrganizationGroup *(future)* | Reporting-only parent of orgs | name | — | 1..* Organization | Platform admin | no data access implied | A1 |
| OrgSetting / FeatureFlag | Org-level config and module switches | key, value | — | →Organization | Org admin | key unique per org | A1 |
| PlatformAdmin | Operator accounts outside tenants | email, status | mfa | none (separate realm) | Platform | MFA mandatory | A2 |
| NumberSequence | Per-org/year counters for ref numbers | organization_id, key, period, next_value | — | →Organization | System | unique (org,key,period) | A0 |
| ImportJob / ImportJobRow | Validate-then-commit bulk import | type, status, file_id, created_by | summary, error_report_file_id | →File | Admin; DRAFT→VALIDATED→COMMITTED/FAILED | rows immutable after commit | A1 |

### 3.2 Identity & Access

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| User | A person with an account (student, staff, admin) | organization_id, first_name, display_name, status | email, phone, DOB, gender, locale, avatar | 1..1 Student and/or Employee | Admin/self; INVITED→ACTIVE→SUSPENDED→DEACTIVATED→ANONYMIZED | email unique per org when present | A1 (A2 for email/phone/status) |
| ExternalIdentity | SSO link (Google/Microsoft/SAML) | user_id, provider, subject | — | →User | Self/admin | (provider,subject) unique | A1 |
| Session | Login session + refresh family | user_id, refresh_family_id, token_hash, expires_at | device_label, ip, revoked_at | →User | System | one active token hash per family | A1 (login/logout/revoke) |
| PasswordResetToken | Reset flow | user_id, token_hash, expires_at | used_at | →User | System; hard-delete after 30 d | single-use | A0 |
| Role | Named bundle of permissions | code, name, kind | organization_id (null = system) | →RolePermission | System roles by platform; custom by org admin (later) | code unique per scope | A1 |
| Permission | Catalog entry, defined in code | code, module, sensitivity | description | global | Code/seed only | code is PK | A0 |
| RolePermission | Role grants permission with scope mode | role_id, permission_code, scope_mode | — | Role↔Permission | Platform/org admin | scope_mode ∈ SELF/ASSIGNED/GRANTED | A1 |
| RoleAssignment | User holds role at a scope, time-boxed | user_id, role_id, scope_type, valid_from, status | campus_id, department_id, valid_to, granted_by, reason | →User, Role, Campus, Department | Admin; ACTIVE→REVOKED/EXPIRED | scope columns consistent with scope_type | A2 |
| Consent | Recorded consent by subject | user_id (or student_id), consent_type, policy_version, status, granted_at | withdrawn_at, ip, guardian_user_id | →User | Subject | one active per (subject,type) | A2 |

### 3.3 Organization

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| Campus | Physical/logical site | organization_id, name, code, timezone, status | address, contact | 1..* Department, Room | Org admin; ACTIVE→INACTIVE | code unique per org | A1 |
| Department | Academic/admin unit | campus_id, name, code, kind, status | parent_department_id | →Campus; 1..* Program | Campus/org admin | code unique per campus; no head column (HOD = role assignment) | A1 |
| Designation | Job title | code, name, category | — | used by EmployeePosting | Org admin | code unique per org | A1 |
| Room | Teaching space | campus_id, code, kind | name, capacity | →Campus | Admin | code unique per campus | A0 |
| Holiday / AcademicCalendarEvent | Non-teaching days, events | campus_id (nullable = all), date, name, kind | term_id | →Campus/Term | Admin | unique (campus,date,name) | A1 |

### 3.4 People

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| Student | Permanent student identity (the "who") | user_id, admission_number, admission_date, status | registration_number, merged_into_student_id | 1..* StudentProgram; →User | Registrar; ADMITTED→ACTIVE→(ON_LEAVE)→GRADUATED / DISCONTINUED / TRANSFERRED_OUT | admission_number unique per org and immutable | A2 |
| StudentIdentifier | Extra external IDs (PRN, APAAR, library card) | student_id, id_type, value | issuer, valid_from/to | →Student | Registrar | (org,type,value) unique | A1 |
| Guardian | Parent/guardian contact | full_name, phone | email, user_id | via StudentGuardian | Registrar | — | A1 |
| StudentGuardian | Link with consent/visibility/communication flags (minors support) | student_id, guardian_id, relation, is_legal_guardian, can_give_consent, can_view_academics, can_receive_notifications, valid_from | is_primary, is_emergency_contact, valid_to | Student↔Guardian | Registrar | one primary per student; effective access computed (06 §6) | A2 |
| Employee | Faculty/staff work identity | user_id, employee_code, employee_type, joining_date, status | leaving_date | 1..* EmployeePosting | HR/admin; ACTIVE→ON_LEAVE→SEPARATED | code unique per org | A2 |
| EmployeePosting | Department + designation over time | employee_id, department_id, valid_from | designation_id, valid_to, is_primary | →Employee, Department | HR/admin | no overlap per (employee,department) | A1 |

### 3.5 Academic structure (configurable — v3.1)

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| PeriodType | Org-defined kind of study period (Semester / Trimester / Year / custom) with display labels | code, label, label_plural | — | used by Program | Org admin | code unique per org | A1 |
| AcademicYear | "2026–27" | label, start_date, end_date, status | — | 1..* Term | Org admin; PLANNED→ACTIVE→CLOSED | no overlap; end>start | A1 |
| Term | Calendar teaching window at a campus (free code: ODD, T1, ANNUAL…) | campus_id, academic_year_id, code, name, start/end, status | attendance_edit_until, locked_at | →AY, Campus; 1..* CohortPeriod | Campus admin; PLANNED→ACTIVE→CLOSED→LOCKED | unique (campus,AY,code) | A2 on lock |
| Program | Degree/diploma/course of study | department_id, period_type_id, name, code, degree_level, duration_periods | periods_per_year, default_regulation | →Department; 1..* Cohort | Admin | code unique per org | A1 |
| Cohort | Intake of a program (UI label "Batch") | program_id, admission_year, intake_code, name | regulation, expected_graduation_year | →Program; 1..* CohortPeriod | Admin; ACTIVE→GRADUATED→CLOSED | unique (program,year,intake) | A1 |
| CohortPeriod | Cohort's Nth study period, running in a calendar term | cohort_id, term_id, period_no | status | →Cohort, Term; 1..* Section, ElectiveGroup | Admin | unique (cohort,term), (cohort,period_no) | A1 |
| Section | Class division | cohort_period_id, name | capacity | →CohortPeriod | Admin | unique (cohort_period,name) | A1 |
| Course | Catalog course (core, lab, project, internship, seminar, audit…) | code, title, credits, course_type, tracks_attendance | owning_department_id | 1..* CourseOffering | Dept/Admin; ACTIVE→RETIRED | code unique per org | A1 |
| CurriculumCourse | What a program prescribes per period & regulation | program_id, course_id, regulation, period_no, category | elective_group_code | →Program, Course | Admin | unique (program,regulation,period,course) | A1 |
| ElectiveGroup | "Choose min..max of these" basket with registration window | cohort_period_id, code, name, min_select, max_select | opens_at, closes_at | →CohortPeriod; 1..* CourseOffering | Admin | unique (cohort_period,code) | A1 |
| CourseOffering | Course delivered in a term (for a section, a group, or open) | campus_id, term_id, course_id, offering_kind, snapshots, registration_policy, status | section_id, cohort_period_id, elective_group_id, group_label, capacity, attendance_policy_id | →Term, Course, Section | Admin; DRAFT→PUBLISHED→CLOSED | unique (term,course,section,group); snapshots frozen at publish | A1 |

### 3.6 Enrollment

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| StudentProgram | Student's enrolment in a program/cohort (department lives here) | student_id, program_id, cohort_id, campus_id, department_id, start_date, status, entry_type | end_date, previous_student_program_id, exit_reason | →Student, Program, Cohort | Registrar; ACTIVE→COMPLETED/TRANSFERRED_OUT/DISCONTINUED | one ACTIVE per student (MVP) | A2 |
| TermEnrollment | Student's participation in a cohort-period | student_id, student_program_id, cohort_period_id, term_id, status, enrollment_type | roll_number, period_no, promoted_from_id | →StudentProgram, CohortPeriod | Registrar/system; REGISTERED→ACTIVE→COMPLETED/WITHDRAWN/DETAINED | unique (student,cohort_period); roll_number unique per (cohort_period) when set | A2 |
| SectionMembership | Which section, with dates | term_enrollment_id, student_id, section_id, valid_from | valid_to, change_reason | →TermEnrollment, Section | Registrar | no overlap per term_enrollment | A2 |
| CourseRegistration | Student takes an offering | term_enrollment_id, student_id, course_offering_id, status, valid_from, source | valid_to, registration_kind | →TermEnrollment, CourseOffering | System (auto from section) / admin / student (electives) | one open registration per (student,offering) | A1 |
| FacultyAssignment | Employee teaches offering | course_offering_id, employee_id, role, valid_from | valid_to | →Offering, Employee | Dept admin/HOD | at most one overlapping PRIMARY per offering | A2 |

### 3.7 Timetable & Attendance (core only — biometrics are a separate optional module)

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| TimetableSlot | Recurring weekly slot | course_offering_id, weekday, start_time, end_time, effective_from | room_id, effective_to, faculty_assignment_id | →Offering, Room | Dept admin | no room overlap in same period | A1 |
| ClassSession | One actual class meeting | course_offering_id, campus_id, session_date, starts_at, ends_at, conducted_by_employee_id, status, attendance_state | timetable_slot_id, topic, kind, room_id, cancel_reason | →Offering, Employee | Faculty (own), admin; SCHEDULED→CONDUCTED/CANCELLED; attendance NOT_STARTED→OPEN→SUBMITTED→LOCKED | unique (offering,starts_at) | A1 |
| AttendanceRecord | Student's status for a session (PRESENT / ABSENT / LATE / EXCUSED) | class_session_id, student_id, course_registration_id, course_offering_id, session_date, status, source, marked_by_user_id, marked_at, revision_no | remarks, excused_by_request_id, capture_session_id (opaque) | →ClassSession, Student | Faculty at submission; changes only via revision | unique (session,student); never deleted | A2 |
| AttendanceRecordRevision | Append-only change history | attendance_record_id, revision_no, status_after, changed_by, reason_code | status_before, reason_text, approved_by, service_request_id | →AttendanceRecord | System | immutable | A2 |
| AttendancePolicy | Configurable, versioned rules; scope wildcard-able (org→campus→department→program→course→offering) | name, status, version_no, rules, effective_from | scope ids, priority, effective_to | pinned by CourseOffering | Org/campus admin | no overlapping ACTIVE policies of same scope | A2 |
| AttendanceSummary | Rebuildable percentage + eligibility under the pinned policy | student_id, course_offering_id, counts, numerator, denominator, policy_id, eligibility_state | percentage | derived | System | rebuildable from records | A0 |
| LeaveRecord *(reserved)* | Approved leave/medical period auto-excusing sessions | — | — | — | post-pilot | — | A2 |

Removed from the core model (moved to future optional modules, ADR-016): AttendanceCaptureSession, FaceEnrollment, FaceRecognitionLog.

### 3.8 Examination (Phase: after pilot)

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| Examination | An exam event (Mid-sem, End-sem, Supplementary) | campus_id, term_id, name, kind, status | starts_on, ends_on, result_published_at | →Term | Exam staff; PLANNED→SCHEDULED→MARKS_ENTRY→PUBLISHED→CLOSED | — | A1 |
| ExamSchedule | Paper on a date | examination_id, course_id, starts_at, ends_at, max_marks | course_offering_id, room/venue, pass_marks | →Examination, Course | Exam staff | unique (examination,course,starts_at) | A1 |
| ExamRegistration | Student sits the paper | exam_schedule_id, student_id, status | course_registration_id, eligibility_snapshot, hall_ticket_no | →Schedule, Student | System/exam staff | unique (schedule,student) | A1 |
| Assessment | Graded component of an offering | course_offering_id, name, kind, max_marks, weightage, status | exam_schedule_id | →Offering | Faculty/exam staff; DRAFT→OPEN→LOCKED→PUBLISHED | weightages per offering sum to 100 on publish | A1 |
| Mark | Score for student × assessment | assessment_id, student_id, course_registration_id, status | marks_obtained, remarks | →Assessment | Faculty; edits create `mark_revisions` | unique (assessment,student) | A2 |
| MarkRevision | Append-only | mark_id, revision_no, value_after, changed_by, reason_code | value_before, approved_by | →Mark | System | immutable | A2 |
| GradeScale | Marks→grade mapping | name, scale(json), effective_term_id | — | →Org | Exam admin | versioned | A1 |
| Result | Per-student, per-term outcome (versioned) | student_id, term_enrollment_id, version, status | examination_id, sgpa, cgpa, outcome, supersedes_result_id, published_at | →TermEnrollment | Exam staff; DRAFT→PUBLISHED→SUPERSEDED | published rows immutable | A2 |
| ResultLine | Snapshot per course | result_id, course_registration_id, course_code, course_title, credits, grade | marks, grade_points, pass_status | →Result | System | immutable once published | A2 |

### 3.9 Service Engine

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| ServiceType | A kind of service (Bonafide…) | code, name, audience, status | category, icon, current_version_id | 1..* Version | Org admin | code unique per org | A1 |
| ServiceTypeVersion | Immutable published definition | service_type_id, version_no, form_schema, status | eligibility, sla_minutes, fulfilment_action, fulfilment_config, document_template_id | 1..* WorkflowStep | Admin; DRAFT→PUBLISHED→RETIRED | one PUBLISHED per type; published = frozen | A2 |
| WorkflowStep | Ordered step | version_id, seq, name, step_type, assignee_kind | role/relation/user/queue ref, sla_minutes, condition, on_reject | →Version | Admin | unique (version,seq) | with version |
| ServiceRequest | Instance | service_type_id, version_id, requester_user_id, status, form_data, ref_no | subject_student_id, department_id, due_at, idempotency_key | →Version | Requester; DRAFT→SUBMITTED→IN_PROGRESS→APPROVED/REJECTED→FULFILLED; CANCELLED | ref_no unique per org | A1 |
| RequestStepInstance | Runtime step state | request_id, workflow_step_id, seq, attempt, status | assigned_user/queue, due_at, completed_at | →Request | System | unique (request,seq,attempt) | A1 |
| RequestApproval | Decision record | step_instance_id, actor_user_id, decision, decided_at | comment, delegated_to | →StepInstance | Approver | append-only | A2 |
| RequestEvent | Timeline + internal notes | request_id, event_type, visibility | body, data, actor | →Request | System/staff | append-only | A0 |
| DocumentTemplate | Template for generated docs | name, kind, body, status | version | used by Version | Admin | versioned | A1 |
| GeneratedDocument | Issued certificate | template_id, template_version, file_id, verification_code, generated_for | data_hash, revoked_at | →File, Request | System | verification_code unique | A1 |

### 3.10 Support

| Entity | Purpose | Req | Opt | Relationships | Owner / Lifecycle | Constraints | Audit |
|---|---|---|---|---|---|---|---|
| WorkQueue / WorkQueueMember | Team/department inbox | name, kind | department_id, campus_id; members(user,role) | used by tickets, requests | Admin | — | A1 |
| TicketCategory | Routing + SLA basis | name, audience, default_queue_id | default_priority, sla_policy_id | →Queue | Admin | — | A1 |
| Ticket | Issue/question | ticket_no, kind, category_id, requester_user_id, subject, description, priority, status | requester_department_id, about_student_id, queue_id, assignee_user_id, parent_ticket_id, linked_request_id, resolution_code/summary | →Category | Requester/staff; OPEN→IN_PROGRESS⇄PENDING_REQUESTER/ON_HOLD→RESOLVED→CLOSED; reopen within window | ticket_no unique per org | A1 |
| TicketMessage | Conversation | ticket_id, author_user_id, visibility, body | attachments via FileLink | →Ticket | Participants | append-only, no edit | A0 |
| TicketAssignment | Assignment history | ticket_id, assigned_by, assigned_at, reason | assignee_user_id, queue_id, unassigned_at | →Ticket | System/staff | — | A0 |
| TicketParticipant | Watchers/CC | ticket_id, user_id, role | — | →Ticket | Staff | unique | A0 |
| EscalationRule / TicketEscalation | Rule and its occurrences | trigger, after_minutes, action; (ticket_id, rule_id, at) | — | →Category | Admin / System | — | A1 |
| TicketFeedback | Post-closure rating | ticket_id, user_id, rating | comment | →Ticket | Requester | one per ticket | A0 |
| SlaPolicy / SlaTimer | Targets and running clocks (shared with service requests) | policy: name, minutes; timer: subject_type, subject_id, kind, due_at, status | calendar, pause info | polymorphic | System | timer unique per (subject,kind) | A0 |

### 3.11 Finance (Phase: later; shape only)

| Entity | Purpose | Notes |
|---|---|---|
| FeeStructure, FeeComponent | What a program/cohort/term costs | Effective-dated; versioned; money in minor units |
| StudentFeeAssignment | Student's applicable structure + concessions | References `term_enrollment` |
| Invoice, InvoiceLine | Amount due | Immutable once issued; corrections via CreditNote |
| Payment | Gateway transaction | `provider_ref` unique, idempotent webhooks |
| Receipt | Proof of payment | Generated document, sequence-numbered |
| Scholarship, ScholarshipAward | Scheme and awards | Awards reduce invoices through lines, never edit payments |
| Refund, CreditNote | Reversals | Append-only |
All finance entities: A2, organization-scoped, never deleted.

### 3.12 Platform services

| Entity | Purpose | Notes |
|---|---|---|
| File, FileLink, RetentionPolicy | Central document storage | Part 12 |
| OutboxEvent, NotificationTemplate, Notification, NotificationDelivery, NotificationPreference, PushSubscription | Notifications | Part 13 |
| AuditEvent | Central audit | Part 11 |
| AiConversation, AiMessage, AiToolCall, KbDocument, KbChunk | AI assistant | Part 10; `ai_tool_calls` is the AI-specific audit extension |

### 3.13 Deferred domains (names reserved, not modeled)

Assignments/LMS-lite, Library, Hostel, Transport, Alumni, Parent portal UI, Placement. The model already supports them through `students`, `guardians`, `files`, `work_queues`, and `service_types` (hostel/library requests are service types first).
