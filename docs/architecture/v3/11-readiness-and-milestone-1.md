# Blueprint v3.1 — Freeze Candidates, Remaining Decisions, Readiness, Milestone 1

Document map (v3.1): `01` review/tenancy/domain · `02` database column specs/history/identity · `03` authz/services/tickets/AI/audit/files/notifications · `04` API/frontend/phasing/ADR index · `05` tenant isolation · `06` authorization · `07` final domain · `08` final database blueprint · `09` security tests · `10` M1 permission catalog · **`11` this file** · ADRs in `docs/decisions/`.

---

## 1. What your decisions settled

| Your decision | Resolution in v3.1 |
|---|---|
| One college now, SaaS later | Tenant = organization, RLS + context propagation + tests from day one; pilot = one org/campus; platform realm via CLI in M1 (`05`) |
| Configurable academic structure | `period_types`, free-code `terms`, `programs.duration_periods`, `cohorts`, `cohort_periods`, `curriculum_courses`, `elective_groups`, course registration separate from enrollment (`02` §4.5–4.6, `07`) |
| Configurable attendance | `attendance_policies` (scoped, versioned JSON rules, pinned to offerings); statuses PRESENT/ABSENT/LATE/EXCUSED; corrections via revisions (`02` §4.7, `07` §4) |
| Immutable student ID, configurable admission format | `students.id` UUIDv7; `identity.admission_number` setting (pattern/generator); roll number on term enrollment |
| Notifications: in-app, push, email; abstraction | Outbox events → provider registry; SMS/WhatsApp are future providers (`03` Part 13) |
| Face attendance out of pilot, isolated | Removed from core tables/modules; optional module depends on attendance, never reverse (ADR-016, ADR-022) |
| Argon2id, UUIDv7, in-process AI gateway | Adopted (ADR-004, ADR-006, ADR-013); AI inherits user context, no identity parameters (`06` §8) |
| Under-18 support | DOB optional/config, computed `isMinor`, guardian links with consent flags, policy-driven communication, data-minimization register (`06` §6, `02` §4.2/4.4) |
| Non-negotiable security list | Mapped to mechanisms (`05`, `06`) and merge-blocking tests (`09`) |

---

## 2. ARCHITECTURE FREEZE CANDIDATES

Mature enough to freeze now (changes after this point require a new ADR):

| # | Decision | ADR |
|---|---|---|
| F1 | Modular monolith with enforced module boundaries; optional modules (capture, biometrics) separate and one-directional | 001, 022 |
| F2 | Tenant = organization; shared schema; `withTenant` transaction context; RLS FORCE + fail-closed; student-self restrictive policy; role separation (`app_runtime` etc.) | 002, 019 |
| F3 | Identity model: user (account) ≠ student/employee (role records); immutable `students.id`; identifier policy | 003 |
| F4 | AuthN: short-lived access token with minimal claims, rotating refresh family in `sessions`, Argon2id, host-binding | 004 |
| F5 | AuthZ: RBAC + scope modes SELF/ASSIGNED/GRANTED + dated scoped assignments + grant rules; 404-for-out-of-scope | 005 |
| F6 | DB conventions: UUIDv7, `organization_id` everywhere, CHECK-enums, effective-dating, snapshots, optimistic locking, no cascades | 006, 021 |
| F7 | Temporal modelling: enrollment layers, dated memberships, revisions for attendance/marks/results | 007 |
| F8 | Audit: central, transactional, append-only, partitioned; MUST-audit list | 008 |
| F9 | Transactional outbox + BullMQ jobs with tenant envelope | 009, 019 |
| F10 | Documents: central `files`/`file_links`, quarantine + scan, link-derived ACL, short signed URLs | 010 |
| F11 | Service engine: versioned config + linear workflow + coded fulfilment actions | 011 |
| F12 | Tickets separate from requests, shared SLA/queue/file/event kernel | 012 |
| F13 | AI Tool Gateway: in-process, session-bound identity, strict schemas, two-phase writes | 013 |
| F14 | One Next.js app with role-aware shells, PWA for student/staff | 014 |
| F15 | Docker-first, cloud-first deployment; self-host supported later from same images | 015 |
| F16 | Configurable academic structure model | 017 |
| F17 | Attendance policy engine (scoped, versioned, pinned) and four statuses | 018 |
| F18 | Minors/guardians/data-minimization approach (policy-driven, computed age) | 020 |
| F19 | Face/biometric attendance deferred and isolated; QR must be rotating & server-validated if ever built | 016, 022 |

Not frozen (will be frozen when their milestone starts): permission catalog beyond M1, ASSIGNED resolvers (M3/M4), exam/result rules, finance model, SLA business-hours, notification provider specifics beyond email/push, search engine choice.

---

## 3. REMAINING DECISIONS (need product / business / legal input)

Only items that cannot be resolved by engineering. None blocks starting Milestone 1.

| ID | Decision | Needed by | Default used until decided |
|---|---|---|---|
| R-1 | Pilot hosting: cloud region vs college server (affects scanning, storage, email, backup setup) | M1 week 1 (infra) | Cloud, single region, managed Postgres with PITR |
| R-2 | Pilot admission-number pattern and whether a university registration number exists | M2 (import) | Setting left empty = any non-empty unique string |
| R-3 | Pilot attendance defaults (min %, late/excused treatment, edit window, correction approvers) | M4 | Org default policy: 75%, LATE=present, EXCUSED excluded, 3-day edit window |
| R-4 | Legal review per jurisdiction: age of majority, guardian consent/visibility, minors' communications, data residency, retention periods | Before real minors' data in production | `age_of_majority=18`, `guardian.academic_visibility=MINORS_ONLY`, minimal collection; **no compliance claim** |
| R-5 | Retention periods per data class (documents, audit, notifications, sessions) | Before production | Defaults in `08` §5 seeds |
| R-6 | Email sender domain / SMTP provider; Web Push (VAPID) ownership; iOS PWA expectations | M1 week 3 | Provider-agnostic SMTP; push in M2 |
| R-7 | Guardian logins/portal in pilot? | M2 planning | No (contacts only) |
| R-8 | Pilot tenant onboarding: who are the first COLLEGE_ADMIN/REGISTRAR accounts, who approves support access | M1 end | Operator provisions via CLI, invites admin |
| R-9 | Terminology defaults ("Batch" vs "Cohort", "Semester") | M2 | Batch / Section / Semester (display setting) |
| R-10 | Face/QR attendance prerequisites (consent, retention, storage, encryption, deletion, anti-spoofing, liveness, audit, opt-out, alternatives) | Before any such module | Not built |
| R-11 | Grading/exam rules; fee rules and gateway | Before M9 / M11 | Not built |
| R-12 | SLA clock rules (business hours/holidays) | M5 | Wall-clock minutes, pause on PENDING_REQUESTER |
| R-13 | SSO providers (Google/Microsoft/SAML) | Post-pilot | Email+password only |
| R-14 | Tenant provisioning: operator-assisted vs self-service | Post-pilot | CLI only |
| R-15 | Per-tenant encryption keys and data-residency model (see `12`) | Before a regulated / multi-region tenant | One app-level KMS key, per-bucket keys |

---

## 4. IMPLEMENTATION READINESS

Scores = *design* readiness (specification completeness and internal consistency), not implementation quality. Nothing has been run yet; the day-1 spike (`08` §9) converts the database and isolation scores into evidence.

| Area | Score | Why | What would raise it |
|---|:-:|---|---|
| Architecture | **9** | Boundaries, dependency rules, eventing, deployment and module map settled | Validation by building M1 |
| Database | **8** | Conventions, roles, RLS templates, M1 set, partitioning, migration policy defined; column specs for later milestones are less detailed | Day-1 spike results; exam/finance specs when scheduled |
| Security | **8** | Mechanisms + 14 CI gates + named assertions + threat surfaces defined | Pen test, threat-model pass on real code |
| Authorization | **9** | Path, scope modes, resolvers, grant rules, minors, AI rules, point/list agreement tests | Real ASSIGNED resolvers in M3/M4 |
| Multi-tenancy | **9** | Context creation, propagation, RLS, jobs, cache, search, files, support access, tests | Spike with PgBouncer; second real tenant |
| Identity | **9** | Identifier policy, merge, anonymization, login, minors | Pilot data validation |
| Academic model | **8** | Configurable structure validated on three real structures; registration separate | Walkthrough with the pilot's real curriculum before M3 |
| Attendance | **8** | Policy engine, revisions, statuses, events, optional capture isolation | Pilot's real rules; M4 design review |
| Service requests | **8** | Versioned config, assignees, SLA, actions, limits stated | Pilot service list; M5 design review |
| Ticketing | **8** | Model, SLA/escalation/reopen, shared kernel | Pilot categories/SLAs; M6 design review |
| AI foundation | **8** | Gateway rules, registry validation, 24-tool list, test corpus | Red-team plan before AI milestone |

**Gate result:** every area ≥ 8 ⇒ the "≥ 8/10 before implementing" condition is met for starting Milestone 1. Academic model, attendance, service requests, and ticketing must each be re-reviewed against pilot facts before their own milestone begins (Milestones 3, 4, 5, 6).

---

## 5. MILESTONE 1 — Foundation, Identity & Isolation (≈ 6 weeks)

**Objective:** deliver the secure, multi-tenant platform kernel plus one complete vertical slice (users, roles, organization, students, guardians, employees, documents, consents, notifications, AI gateway skeleton) — enough real resources to *prove* tenant, student and scope isolation before any academic feature is built.

**Explicitly out of M1:** terms/enrollment/attendance, services, tickets, exams, finance, push notifications (M2), CSV import (M2), face/QR, LLM integration (gateway only), guardian logins, SSO/MFA for tenant users.

### 5.1 Work plan and gates

| Phase | Weeks | Content | Exit gate |
|---|:-:|---|---|
| 1A Spike & harness | 1 | Repo layout per `04` Part 14; Postgres + PgBouncer containers; **spike** (UUIDv7, `withTenant`, FORCE RLS with non-owner role, partitioned audit + RLS, exclusion constraint); CI with gates S-1…S-4; schema linter; `createWorld()` fixture builder | Spike green; S-1/S-2/S-4 running on a sample table |
| 1B Kernel | 2 | Config/env validation, RequestContext, `withTenant`, TenantCache, jobs envelope, outbox, audit service, PolicyEngine + catalog loader, errors, logging, number sequences | Kernel unit + S-8/S-12/S-13 basics green |
| 1C Identity & IAM | 3 | Users, sessions, Argon2id, login/refresh/logout/reset/invite, lockout, **TOTP MFA + step-up for CRITICAL actions**, roles/assignments/grant rules, provisioning CLI, seeds | S-10, S-11 green |
| 1D Organization & people | 4 | Campuses/departments/designations, settings registry, period types/programs/cohorts, students, student_programs, guardians, employees | S-6 matrix for these routes green (X-01…X-11) |
| 1E Documents, consent, notifications, AI skeleton | 5 | files pipeline (+ClamAV), consents, notification core (in-app, email), AI gateway with 2 tools, audit viewer | S-7, S-9 green |
| 1F Frontend & hardening | 6 | Screens (below), PWA shell, headers/CSP, rate limits, observability basics, docs, full security suite run, tidy-up | Definition of done |

### 5.2 Database entities (39 tables — specs in `02`/`08`)

organizations, organization_domains, organization_settings, number_sequences, platform.platform_admins, platform.platform_support_grants, users, external_identities, sessions, password_reset_tokens, invite_tokens, user_mfa_factors, user_recovery_codes, consents, roles, permissions, role_permissions, role_assignments, role_grant_rules, campuses, departments, designations, period_types, programs, cohorts, student_programs, students, guardians, student_guardians, employees, files, file_links, retention_policies, outbox_events, notification_templates, notifications, notification_deliveries, notification_preferences, audit_events (partitioned).

### 5.3 Backend modules

| Module | Contents |
|---|---|
| `shared/tenancy` | RequestContext, `withTenant`, DB role handling, host→tenant resolver |
| `shared/database` | Pool, migrations runner, UUIDv7, RLS helpers |
| `shared/policy` | PolicyEngine, permission catalog, resolver registry, `scopeFilter` |
| `shared/audit` | `audit.record`, partition manager |
| `shared/events` | Outbox writer/relay, event catalog |
| `shared/jobs` | `defineJob`, tenant envelope, schedulers via `app_system` |
| `shared/cache` | TenantCache |
| `shared/storage` | S3 client abstraction, presign, scan hook |
| `shared/settings`, `shared/numbering`, `shared/errors`, `shared/http` | Registry, sequences, error envelope, idempotency/If-Match middleware |
| `iam` | auth, sessions, users, roles/assignments, grant rules, invites |
| `organization` | campuses, departments, designations, settings |
| `academics` (minimal) | period types, programs, cohorts |
| `people` | students, student_programs, guardians, employees |
| `documents` | uploads, files, links, scan worker, download URLs |
| `consents` | consent registry and records |
| `notifications` | templates, in-app, email provider (SMTP), preferences, delivery worker |
| `ai` | Tool Gateway, registry validator, tools `get_my_profile_summary`, `get_my_documents`; **no LLM client** |
| `audit` (read API) | viewer endpoint |
| `platform-cli` | `tenant:create`, `tenant:seed`, `tenant:suspend`, `support:grant` |

### 5.4 API endpoints (`/api/v1`)

| Area | Endpoint | Permission |
|---|---|---|
| Public | `GET /health`, `GET /ready`, `GET /public/tenant` (name, branding by host) | public |
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/accept-invite` | public/session |
| Sessions | `GET /me/sessions`, `DELETE /me/sessions/{id}` | `session.read`, `session.revoke` |
| MFA / step-up | `POST /me/mfa/totp/enroll`, `POST /me/mfa/totp/verify`, `POST /auth/mfa/challenge`, `POST /auth/step-up`, `POST /me/mfa/recovery-codes/regenerate`, `DELETE /me/mfa/totp` (blocked for MFA-required roles) | `auth.mfa.manage` |
| Me | `GET /me` (identity + capabilities), `PATCH /me/profile`, `GET /me/role-assignments` | `user.profile.read/update`, `role.assignment.read` |
| Consents | `GET /me/consents`, `POST /me/consents`, `POST /me/consents/{id}/withdraw` | `consent.read/record/withdraw` |
| Notifications | `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `GET/PUT /notifications/preferences` | `notification.read`, `notification.preference.manage` |
| Users | `GET /users`, `POST /users/invite`, `GET /users/{id}`, `PATCH /users/{id}`, `POST /users/{id}/suspend`, `POST /users/{id}/reactivate`, `POST /users/{id}/reset-password` | `user.account.*` |
| Sessions admin | `DELETE /users/{id}/sessions` | `session.revoke_any` |
| Roles | `GET /roles`, `GET /users/{id}/role-assignments`, `POST /users/{id}/role-assignments`, `POST /role-assignments/{id}/revoke` | `role.read`, `role.assignment.*` |
| Organization | `GET/POST/PATCH /campuses`, `GET/POST/PATCH /departments`, `GET/POST /designations` | `org.structure.read`, `org.campus.manage`, `org.department.manage` |
| Settings | `GET /settings`, `PUT /settings/{key}` | `org.settings.read/manage` |
| Programs | `GET/POST/PATCH /programs`, `GET/POST/PATCH /cohorts`, `GET/POST /period-types` | `academic.program.read/manage`, `academic.cohort.manage` |
| Students | `GET /students` (scoped list/search), `POST /students`, `GET /students/{id}`, `PATCH /students/{id}`, `POST /students/{id}/status`, `POST /students/{id}/programs`, `POST /students/{id}/programs/{pid}/close` | `student.directory.search`, `student.record.*`, `student.profile.read`, `student.status.change`, `student.program.assign` |
| Guardians | `GET/POST /students/{id}/guardians`, `PATCH/DELETE /students/{id}/guardians/{gid}` | `student.guardian.read/manage` |
| Employees | `GET /employees`, `POST /employees`, `GET/PATCH /employees/{id}` | `employee.*` |
| Documents | `POST /documents/uploads`, `POST /documents/uploads/{id}/complete`, `GET /documents/{id}`, `GET /documents/{id}/download-url`, `DELETE /documents/{id}`, `GET /students/{id}/documents` | `document.*` |
| Audit | `GET /audit/events` (filters: actor, resource, date, student) | `audit.event.read(_student)` |

≈ 66 endpoints. All require `If-Match` on mutating updates of versioned aggregates and `Idempotency-Key` on creates (`/users/invite`, `/students`, `/documents/uploads`). The AI gateway has **no HTTP endpoint** in M1 (invoked by tests and an internal CLI).

### 5.5 Frontend screens (single Next.js app, PWA shell)

| Shell | Screens |
|---|---|
| Auth | Login (tenant branded by host), forgot/reset password, accept invite |
| Student (mobile-first) | Home (profile summary, notifications), My profile (edit phone/locale/avatar), My documents (upload/list/download), Privacy & consents, Security (active sessions, revoke), Notification centre + preferences |
| Staff (mobile/tablet) | Home (placeholder tiles from capabilities), My profile, Notifications |
| Admin (desktop-first) | Dashboard (counts), Users (list/search/filter, detail, invite, suspend/reactivate, reset), Role assignments (grant/revoke with reason, scope picker), Campuses & departments, Programs & cohorts, Students (list, create, detail with program history, guardians, documents), Employees (list, create, detail), Settings (identifier format, age of majority, terminology, privacy fields), Audit viewer |
| Shared | App shell driven by `/me` capabilities, persona switcher, error pages (403/404/409/offline), skeleton loaders, accessibility baseline, i18n wiring (en) |

### 5.6 Permissions

50 tenant permissions + 5 platform permissions as specified in `10`; seeded roles STUDENT, FACULTY, STAFF, HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR; role grant rules per `06` §5.

### 5.7 Tests

- **Unit**: policy engine (modes, resolvers, expiry, union of roles), settings validation, admission-number validator/generator, number sequences, Argon2id wrapper, uuidv7 ordering, job envelope, cache key builder, DTO mappers.
- **Integration (real Postgres)**: every endpoint happy path + validation errors; migrations up/down; provisioning CLI creates a usable tenant; invite→accept→login flow; document upload→scan→download; consent flows; notification delivery to in-app + SMTP sandbox; outbox relay; audit completeness.
- **Contract**: OpenAPI generated from Zod; breaking-change check in CI.
- **E2E (Playwright)**: login, invite acceptance, student uploads document, admin creates student and assigns role, session revocation, 409 conflict UX.
- **Accessibility/Perf smoke**: axe on key screens; p95 < 300 ms for core reads on seeded 5k-student dataset.

### 5.8 Security tests required for M1 sign-off

Gates S-1, S-2, S-3, S-4, S-5, S-6 (X-01…X-16 as applicable), S-7, S-8, S-9 (registry + gateway with two real tools), S-10, S-11, S-12, S-13, S-14 — all green, plus: route-coverage report shows 100% of routes in the matrix; fixture world passes the full principal × route matrix; documented threat model (STRIDE) for auth, documents and the AI gateway.

### 5.9 Definition of done

1. `pnpm dev` starts API, web, Postgres (+PgBouncer), Redis, MinIO, ClamAV, SMTP sandbox; `pnpm tenant:create` provisions a usable tenant with a COLLEGE_ADMIN invite.
2. Two tenants provisioned in CI; **all isolation gates (S-1…S-14) pass** and block merges.
3. Every table passes the schema linter; app runs as `app_runtime` without BYPASSRLS; migrations run as `app_migrator`.
4. Student A cannot read/modify Student B through API, SQL-as-student, files or AI gateway (X-01…X-04, S-4, S-7, S-9).
5. Tenant A cannot reach Tenant B through any route, job, cache key or file (X-05, X-06, S-8).
6. Department/campus-scoped admins are bounded to scope; grants obey rules; last-admin protection; revocation is immediate.
7. Every MUST-audit M1 action writes exactly one transactional audit event; audit is immutable and scope-readable.
8. Optimistic locking and idempotency work (409/428 behaviours tested; races pass).
9. Argon2id parameters configured; no plaintext secrets/passwords in logs; refresh reuse detected; TOTP MFA enforced for MFA-required roles (default HOD and above, REGISTRAR) and step-up enforced on every CRITICAL permission.
10. Admission-number format, age of majority, guardian policy, terminology are configurable settings with validation and audit.
11. All screens in §5.5 work on a 375 px phone (student/staff) and desktop (admin); axe has no critical violations.
12. Restore of the database from backup into a clean environment demonstrated once (early rehearsal; formal drill at M7).
13. Documentation: ADRs merged, permission matrix file in repo, runbook for provisioning and key rotation, threat model.

### 5.10 First ten tasks (so the next prompt can start immediately)

1. Repo restructure to `04` Part 14 (remove `services/face-service` and face code from compose, CI and `backend/src/modules/attendance/face` — left on disk, excluded from build).
2. Postgres/PgBouncer/Redis/MinIO/ClamAV/Mailpit compose; DB role bootstrap script.
3. Day-1 spike branch and report.
4. Migration framework + RLS helper + schema linter + CI gates S-1…S-4.
5. `createWorld()` fixture builder.
6. RequestContext/`withTenant`/TenantCache/jobs envelope.
7. Audit service + partition manager.
8. Permission catalog + PolicyEngine + route registry check.
9. Auth/session/IAM + provisioning CLI.
10. Matrix test generator wired to the route registry.
