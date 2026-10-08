# Blueprint v3 — Parts 14–17: API, Frontend, Phasing, ADRs, Status

---

## PART 14 — API BOUNDARIES

### 14.1 Conventions (all domains)

- Base `/api/v1`. Tenant comes from the session, never the URL. `GET /api/v1/me` returns identity, roles, **capabilities** (what menus/actions exist) — the frontend renders from this, not hard-coded role names.
- Auth: `Authorization: Bearer <access JWT>` (15 min) + refresh cookie (HttpOnly, SameSite=Strict, Secure) on `/auth/*` only, with a custom header to defeat CSRF on refresh.
- Every handler: `requires(permission)` at route + `policy.assert` at service layer.
- `Idempotency-Key` on creates that matter (requests, tickets, attendance submission, payments). `version`/`If-Match` on concurrent edits. Cursor pagination. Uniform error envelope with `requestId`.
- Modules communicate through service interfaces and domain events — never by reading each other's tables.

### 14.2 Domains

| Domain | Responsibility | Main resources | AuthN | AuthZ | Common operations |
|---|---|---|---|---|---|
| `/auth` | Login, sessions, password flows, SSO callbacks | session, password-reset, invite-accept, mfa (later) | Public (rate-limited) / refresh cookie | None / session owner | login, refresh, logout, logout-all, forgot/reset, accept-invite, list/revoke my sessions |
| `/users` | Accounts and role assignments | user, role-assignment, role, consent | Bearer | `user.*`, `role.assignment.*` GRANTED | invite, update contact, suspend, assign/revoke role (reason), list my consents |
| `/students` | Student identity and academic enrolment | student, student-program, term-enrollment, section-membership, guardian, identifier, import | Bearer | `student.*` SELF/GRANTED/ASSIGNED | create/import, view profile, change section, transfer program, status change, merge |
| `/faculty` | Employee (faculty/staff) records | employee, posting, assignment view | Bearer | `employee.*` | create, post to department, assign offerings, workload view |
| `/organization` | Tenant structure | organization, campus, department, designation, room, holiday, settings, work-queue | Bearer | `org.*` GRANTED | CRUD structure, settings, queues |
| `/academics` | Calendar and curriculum | academic-year, term, program, cohort, cohort-period, section, course, course-offering, timetable-slot | Bearer | `academic.*` GRANTED | create term, publish offerings, generate registrations, lock term, timetable CRUD |
| `/attendance` | Sessions, marking, corrections, summaries, policies | class-session, attendance-record, revision, summary, policy | Bearer | `attendance.*` SELF/ASSIGNED/GRANTED | list my sessions, open/submit attendance, correct (revision), my summary, section/dept reports |
| `/exams` | Examination planning and registration | examination, exam-schedule, exam-registration, assessment, mark | Bearer | `exam.*`, `marks.*` | schedule, register, enter/lock marks |
| `/results` | Result processing and publishing | result, result-line, grade-scale, transcript | Bearer | `result.*` SELF/GRANTED | compute, publish, supersede, student view, transcript PDF |
| `/services` | Service request engine | service-type (+versions), request, step, approval, event | Bearer | `service.admin.*`, `request.*` SELF/ASSIGNED/GRANTED | list available, submit, track, approve/reject/return, cancel, publish a service version |
| `/tickets` | Helpdesk | category, ticket, message, assignment, feedback, escalation-rule, sla-policy | Bearer | `ticket.*` SELF/ASSIGNED/GRANTED | create, reply (public/internal), assign, resolve, reopen, feedback |
| `/notifications` | In-app inbox, preferences, push registration, templates (admin) | notification, preference, push-subscription, template | Bearer | own data; `notification.template.manage` | list/mark read, set preferences, register device |
| `/documents` | Files and generated documents | upload, file, link, generated-document, template, verify (public) | Bearer / public verify | derived from linked entity | request upload, complete, signed download, generate, verify |
| `/finance` *(later)* | Fees, invoices, payments, scholarships | fee-structure, invoice, payment, receipt, scholarship | Bearer; payment webhooks signed | `finance.*` SELF/GRANTED | view dues, pay (gateway), issue receipt, apply scholarship |
| `/ai` | Assistant sessions and tool gateway | conversation, message, confirmation | Bearer | `assistant.use` + per-tool | send message (stream), confirm proposal, list conversations |
| `/audit` | Read audit trail | audit-event, export | Bearer | `audit.event.read` scoped | search by student/actor/resource/date, export |
| `/reports` | Cross-domain reporting | report definition, run, export | Bearer | `report.*` scoped | run attendance/request/ticket reports, async export |
| `/platform` | Tenant provisioning (separate realm, separate host) | organization, domain, support-access | Platform admin + MFA | platform-only | create tenant, seed, suspend, grant support access |
| `/health`, `/ready`, `/metrics` | Ops | — | Internal | — | liveness/readiness |

Backend module → route mapping: `iam` (auth, users), `people` (students, faculty), `organization`, `academics`, `attendance`, `exams`, `results`, `services`, `helpdesk`, `notifications`, `documents`, `audit`, `ai`, `finance`, `reports`, `platform`; shared kernel: `tenancy`, `policy`, `events/outbox`, `sla`, `numbering`, `queues`, `storage`, `errors`.

---

## PART 15 — FRONTEND APPLICATION STRUCTURE

### 15.1 Options

| | One app, role-aware shells | Separate apps (student PWA / admin console / management) |
|---|---|---|
| Delivery speed | **Fastest**: one auth client, one design system, one deploy | 2–3 pipelines, duplicated plumbing |
| Bundle size for students | Fine with route-level code splitting + lint-enforced boundaries | Naturally minimal |
| PWA/offline scope | Scoped to student/faculty routes | Clean per-app manifest |
| Multi-role users (faculty who is HOD) | **Simple**: one login, switch shell/capabilities | Awkward cross-app SSO |
| Security surface | Admin routes in same origin (mitigate with server-side authz, no secrets in bundles) | Admin on separate origin/hostname |
| Future extraction | Easy if boundaries are enforced | n/a |

### 15.2 Recommendation: **one Next.js application with four role-aware shells** (monorepo-ready to split later)

```
apps/web
  (auth)        login, accept-invite, reset
  (student)     mobile-first shell: bottom tabs — Home · Attendance · Requests · Help · Profile   [PWA scope]
  (staff)       faculty/HOD/staff shell: mobile+tablet friendly — Today · Classes · Approvals · Students · Help
                department tabs appear by capability (HOD views), not by a separate route group
  (admin)       desktop-first console: sidebar — Organization · People · Academics · Services · Helpdesk · Reports · Settings · Audit
  (insights)    management analytics: dashboards, cohort/department views, exports (lazy-loaded; can become apps/console later)
```

Rules that make this work:
1. **Shell chosen by capabilities** from `/me`, with a persona switcher for multi-role users. HOD is a capability set inside `(staff)`, replacing v1's `(hod)` group.
2. **Import boundaries enforced by lint**: `(student)` may not import from `(admin)` / `(insights)`; shared code lives in `packages/ui`, `packages/schemas`, `packages/types`.
3. **Heavy libraries only in admin/insights** (charts, table grids, form builder, CSV importer) via dynamic import.
4. **Service worker only caches** student/staff read-mostly screens (timetable, attendance summary); authenticated API data is never cached across users or sessions; logout clears caches.
5. **Server authorization is the truth.** UI hiding is a convenience.
6. Management analytics reads **reporting endpoints**, not OLTP list endpoints.
7. Split trigger: if admin/insights deploy cadence or security posture diverges (e.g., an enterprise customer demands a separate admin origin), extract `(admin)` + `(insights)` to `apps/console` — no API changes required.

---

## PART 16 — IMPLEMENTATION PHASING

Order changed from v2: authorization, audit, files and outbox move into the foundation; **face attendance is deferred and isolated as an optional module (ADR-016)**; org/people split from academic structure; service requests precede tickets (tickets reuse the SLA kernel built there).

### Milestone 1 — Foundation, Identity & Isolation (≈6 wks) — **superseded by `11-readiness-and-milestone-1.md` §5**
Re-scoped in v3.1: kernel + IAM + organization + minimal programs + students/guardians/employees + documents + consents + notifications core + AI gateway skeleton + platform CLI, with security gates S-1…S-14 as merge blockers. 39 tables, ≈66 endpoints.

---

### Milestone 2 — Organization + People (≈3 wks)
- **Features**: rooms, employee postings, student identifiers; web push; invite flow refinements; students + identifiers + guardians; role assignment UI (with reasons, expiry); **import framework** (validate → preview → commit); duplicate detection.
- **Tables** (M1 already created org/people basics): student_identifiers, employee_postings, rooms, push_subscriptions, import_jobs, import_job_rows.
- **APIs**: `/organization`, `/users`, `/students` (profile/import), `/faculty`, `/notifications`.
- **UI**: admin: org structure, user list/detail, role assignment, CSV import wizard; student profile; notification bell.
- **Depends on**: M1.
- **Tests**: admission_number immutability, duplicate detection, role assignment scoping (department vs campus), import dry-run vs commit, invite email via SMTP sandbox.
- **Done**: admin imports 100 students + 20 faculty with error report; invites delivered; HOD assignment limits visibility to department (test).

### Milestone 3 — Academic Structure & Enrollment (≈4–5 wks)
- **Features**: academic years, terms (free codes, state machine), cohort periods, sections, courses, curriculum courses, elective groups with registration windows, course offerings (snapshots), faculty assignments, term enrollments, section memberships, course registrations (auto-from-section, elective choice, admin-assigned, backlog), timetable slots, holidays, promotion tool, setup checklist. Terminology via settings.
- **Tables**: academic_years, terms, cohort_periods, sections, courses, curriculum_courses, elective_groups, course_offerings, faculty_assignments, term_enrollments, section_memberships, course_registrations, timetable_slots, holidays.
- **APIs**: `/academics`, `/students` (enrollment endpoints), `/faculty` (assignments).
- **UI**: setup wizard, term board, section allocation, offerings grid, elective registration, assignment screen, student timeline, timetable viewer.
- **Depends on**: M2; walkthrough with the pilot's real curriculum (re-review gate).
- **Tests**: overlap exclusion constraints, section-change history, term lock, promotion without mutation, offering snapshot freeze, elective min/max/window validation, **real ASSIGNED resolver matrix (X-12)**, student-self RLS on new student tables.
- **Done**: pilot structure loaded for a full term; per-student course sets differ correctly; timeline matches "as of date" fixtures; all S-gates still green.

---

### Milestone 4 — Attendance (manual, policy-driven) (≈4 wks)
- **Features**: class sessions (from timetable, extras, cancel), faculty marking (PRESENT/ABSENT/LATE/EXCUSED) on mobile, submit/lock, revisions & corrections with reasons, configurable `attendance_policies` (resolution, pinning, re-pin & recompute), summaries job, warning thresholds → `attendance.low` events → in-app/push/email, student views, department/section reports, exports.
- **Tables**: class_sessions, attendance_records, attendance_record_revisions, attendance_policies, attendance_summaries.
- **APIs**: `/attendance`, `/reports` (attendance).
- **UI**: faculty today-list + roster; student attendance cards/detail; HOD at-risk; admin policy editor; correction UI.
- **Depends on**: M3, notifications; re-review with the pilot's attendance rules (R-3).
- **Tests**: roster snapshot equals registrations on date; substitute faculty authorization (X-12 real); policy resolution precedence; percentage math under different `status_treatment`; correction creates revision atomically; locked term rejects edits; concurrency on double submission; student-self RLS on attendance tables.
- **Done**: pilot faculty mark attendance for 2 weeks under the configured policy; student sees accurate %; disputed record shows full revision history; no silent overwrite possible (DB-tested).

---

### Milestone 5 — Service Request Engine (≈4 wks)
- **Features**: versioned service types, form schema validation, linear workflows, assignee resolvers, approvals, SLA kernel (timers + poller), work queues, fulfilment actions (document generation, attendance correction), generated documents + verification, seeded services (Bonafide, ID card, Attendance correction, General), student & staff UIs.
- **Tables**: service_types, service_type_versions, workflow_steps, service_requests, request_step_instances, request_approvals, request_events, work_queues, work_queue_members, sla_policies, sla_timers, document_templates, generated_documents.
- **APIs**: `/services`, `/documents`.
- **UI**: student request catalog/form/tracker; staff approvals inbox; admin service editor (JSON/basic form).
- **Depends on**: M1 files/outbox, M3, M4 (correction action).
- **Tests**: version pinning, assignee fallback, SLA breach via poller, idempotent fulfilment, approval authorization (IDOR), PDF generation, correction applies exactly once.
- **Done**: bonafide end-to-end with downloadable verified PDF; attendance correction via request updates attendance with revision.

### Milestone 6 — Ticketing (≈2.5 wks)
- **Features**: categories, tickets (student/department/internal), messages with internal notes, attachments, assignment & auto-assign, SLA reuse, escalation, resolve/reopen, feedback.
- **Tables**: ticket_categories, tickets, ticket_messages, ticket_assignments, ticket_participants, escalation_rules, ticket_escalations, ticket_feedback.
- **APIs**: `/tickets`.
- **UI**: student help tab; agent console; admin category/SLA setup.
- **Depends on**: M5 kernel.
- **Tests**: internal note leakage, reopen window, escalation rules, SLA pause/resume.
- **Done**: tickets flow with SLA timers and escalation in staging.

### Milestone 7 — Pilot Hardening & Deploy (≈3 wks)
- **Features**: security review (OWASP), backup + **restore drill**, rate limits, observability basics, PWA offline read caches, accessibility pass, data retention jobs, onboarding runbook, Docker prod compose (internal-only ports), load test at 500 concurrent, pilot go-live.
- **Tests**: e2e critical paths, restore from backup into clean env, pen-test checklist, RLS bypass attempts.
- **Done**: pilot college live; RPO/RTO documented and demonstrated.

### Post-pilot milestones (outlined)
| # | Milestone | Key content | Gate |
|---|---|---|---|
| 8 | Optional capture modules (QR first; biometric only after R-10) | QR: rotating server-validated codes with review; biometric: only after consent, retention, encryption, template storage, deletion, liveness, audit, opt-out and alternatives are separately specified (ADR-016, ADR-022) | Separate design + legal review |
| 9 | Exams & results | Examinations, schedules, registrations, assessments, marks + revisions, results (versioned), transcripts | Term/enrollment data stable |
| 10 | Student AI assistant | Tool gateway, 24-tool registry, RAG (pgvector), conversation logging, confirmation flow | M4–M6 APIs stable; red-team plan |
| 11 | Finance | Fee structures, invoices, payments (gateway webhooks), receipts, scholarships | Payment compliance review |
| 12 | Multi-campus UI, parent portal, analytics/insights, SSO/MFA | Surfaces on existing model | Second customer |

---

## PART 17 — ARCHITECTURAL DECISION RECORDS

> **v3.1:** ADRs now exist as files in `docs/decisions/` (ADR-001…ADR-022). Numbering changed from the table below: ADR-015 = deployment, ADR-016 = face attendance **deferred/isolated**, ADR-017 = academic structure, ADR-018 = attendance policy, ADR-019 = tenant context propagation, ADR-020 = minors & data minimisation, ADR-021 = concurrency & integrity, ADR-022 = optional capture modules. The files are authoritative; the summary table below is the original v3 draft.

| ADR | Decision | Context | Options | Recommended | Consequences |
|---|---|---|---|---|---|
| **001** Application architecture | Modular monolith (optional modules separate) | Small team, early product, clear domain seams | Microservices · Modular monolith · Serverless | **Modular monolith** with enforced module boundaries (no cross-module table access), domain events for coupling | Simple ops and transactions; discipline needed; extraction later via events/service interfaces |
| **002** Multi-tenancy | Tenant = organization; shared DB/schema; RLS | Start with one college, add more later | DB-per-tenant · Schema-per-tenant · Shared schema + `organization_id` | **Shared schema + org_id + RLS + CI proof** | Cheapest to run/migrate; a bug leaks data unless layers and tests hold; platform reporting needs aggregation jobs |
| **003** Identity model | `users` (account) vs `students`/`employees` (roles) with permanent `student_id` | Students must remain the same person across changes | Single table · Persons table · Account + role records | **Account + role records; facts reference `student_id`** | Clean history; extra joins; merge procedure needed |
| **004** Authentication | Short JWT + rotating refresh in `sessions`; argon2id; SSO-ready | Web + PWA, revocation needed | Server sessions · JWT only · JWT + refresh | **JWT (15 min, minimal claims) + refresh family with reuse detection** | Instant revoke via `authz_version`/session; refresh endpoint needs CSRF care; argon2id replaces bcrypt (v1) |
| **005** Authorization | RBAC + scoped assignments + scope modes (SELF/ASSIGNED/GRANTED) | Faculty by assignment, HOD by department, admin by campus/org | Plain RBAC · ABAC engine (OPA) · RBAC + scopes | **RBAC + scope modes, resolvers in code** | Understandable and fast; new scope kinds need resolver code; revisit OPA if policies become cross-domain |
| **006** Database & IDs | PostgreSQL 15+, Drizzle, UUIDv7, `varchar`+CHECK enums, versioned SQL migrations | Relational, history-heavy data | Prisma · Drizzle · raw SQL; v4 vs v7 | **Drizzle + reviewed SQL migrations; UUIDv7 in app** | Predictable SQL; exclusion constraints need hand-written SQL; no PG18 dependency |
| **007** Temporal modeling | Effective-dated membership rows + snapshots + revision tables | Historical accuracy of enrollments, faculty, attendance, results | Mutable columns · Event sourcing · System-versioned tables · Effective-dating | **Effective-dating + snapshots + targeted revisions** | Queries slightly more complex; strong reproducibility; "current" via views |
| **008** Audit | Central append-only, transactional, partitioned | Disputes, compliance | Async log · Per-table history · Central transactional | **Central transactional + domain revisions for attendance/marks** | Slight write overhead; strong evidence; partition maintenance |
| **009** Eventing | Transactional outbox → in-process bus/BullMQ | Decouple notifications, SLA, AI hooks | Direct calls · Broker (Kafka/Rabbit) · Outbox + Redis | **Outbox + BullMQ** | At-least-once semantics (idempotent handlers); no new infra |
| **010** Documents | Central `files`/`file_links`, quarantine + scan, signed URLs, classes | Many attachment kinds, sensitive ID docs | Per-module tables · Central | **Central** | One pipeline for ACL/retention/scan; link-derived ACL logic |
| **011** Service engine | Versioned config (forms + linear workflow) + coded fulfilment actions | Add services without redeploy; avoid workflow-platform sprawl | Hard-coded per service · BPMN engine · Config + hooks | **Config + hooks** | Fast new services; complex flows need code; clear boundary |
| **012** Tickets vs requests | Separate models, shared kernel (SLA, queues, files, events) | Different semantics, common infrastructure | Single generic "case" · Separate · Separate + kernel | **Separate + shared kernel** | Clear UX/data; link fields connect them |
| **013** AI tool architecture | In-process Tool Gateway, session-bound identity, allowlisted tools, two-phase writes | Prevent data exfiltration/prompt injection | LLM with API token · LLM with SQL · Gateway | **Gateway** (supersedes v1 §13.5 JWT-passthrough) | Strong boundary; each tool is deliberate work; faculty tools later |
| **014** Frontend | One Next.js app, role-aware shells, enforced boundaries, PWA | Small team; mixed personas; multi-role users | One app · Separate apps · Micro-frontends | **One app, extractable** | Fast delivery; needs lint/CI discipline |
| **015** Deployment | Docker-first; cloud primary; self-host supported later from same images | Hybrid requirement without doubling ops | Cloud only · Both from day 1 · Docker-first, cloud first | **Docker-first, cloud first; polish self-host after pilot** | Env-driven config now; installer later; no cloud-only APIs |
| **016** Biometric attendance | Face attendance deferred; isolated optional module | Biometrics are sensitive, legally risky | Build now · Later core · Later isolated | **Later, isolated, after R-10 prerequisites** | Lower pilot risk |

---

## ARCHITECTURE STATUS — superseded

The v3 status table and next-action are replaced by `11-readiness-and-milestone-1.md` (freeze candidates, remaining decisions, readiness scores, Milestone 1 specification).
