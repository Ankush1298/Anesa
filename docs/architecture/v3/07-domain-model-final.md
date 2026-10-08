# Blueprint v3.1 — Final Domain Model

Entity-level detail (purpose, fields, ownership, lifecycle, constraints, audit) is in `01` Part 3 (updated in v3.1: §3.5 academic structure, §3.7 attendance). Column-level detail is in `02` Part 4. This document is the **final map**: bounded contexts, dependency rules, the complete entity inventory by milestone, and validation of the configurable academic model against real-world structures.

---

## 1. Bounded contexts and module dependency rules

```
                         ┌──────────────── shared kernel ────────────────┐
                         │ tenancy · db(withTenant) · policy · audit ·    │
                         │ events/outbox · jobs · cache · storage ·       │
                         │ numbering · sla · errors · settings            │
                         └───────────────────────────────────────────────┘
 iam ──► organization ──► people ──► academics ──► enrollment ──► attendance ──► (exams, results)
  │                          │             │            │              │
  └──────────────────────────┴─────────────┴────────────┴──────────────┴──► notifications (via events only)
 services (requests)  ·  helpdesk (tickets)  ·  documents  ·  ai (gateway)  ·  finance (later)
 optional, later:  capture-qr  ·  biometrics        (depend on attendance's public interface; attendance never depends on them)
```

Rules (enforced by `dependency-cruiser`):
1. A module may call another module only through its **public service interface** (`index.ts` exports); never its repositories or tables.
2. Arrows above point from dependent to dependency; no cycles. `attendance` depends on `enrollment` (registrations) and `academics`; **nothing in core depends on `biometrics` or `capture-*`**.
3. Cross-module reactions use **domain events** (outbox), not direct calls (notifications, SLA start, summary recompute).
4. `notifications`, `audit`, `documents` are leaf services used by everyone; they know nothing about business modules (they receive IDs/events).
5. `ai` may call only application services registered as tools.

---

## 2. Complete entity inventory (final names)

M = milestone in which the table is created.

| Context | Entities (tables) | M |
|---|---|---|
| Platform / tenancy | organizations, organization_domains, organization_settings, number_sequences, platform_admins, platform_support_grants | 1 |
| Identity & access | users, external_identities, sessions, password_reset_tokens, invite_tokens, roles, permissions, role_permissions, role_assignments, role_grant_rules, consents | 1 |
| Organization | campuses, departments, designations, rooms | 1 (rooms 3) |
| People | students, student_identifiers, guardians, student_guardians, employees, employee_postings | 1 (identifiers/postings 2) |
| Programs (minimal in M1) | period_types, programs, cohorts, student_programs | 1 |
| Academic calendar & structure | academic_years, terms, cohort_periods, sections, courses, curriculum_courses, elective_groups, course_offerings, faculty_assignments, timetable_slots, holidays | 3 |
| Enrollment | term_enrollments, section_memberships, course_registrations | 3 |
| Attendance | class_sessions, attendance_records, attendance_record_revisions, attendance_policies, attendance_summaries | 4 |
| Service engine | service_types, service_type_versions, workflow_steps, service_requests, request_step_instances, request_approvals, request_events, document_templates, generated_documents | 5 |
| Support | work_queues, work_queue_members, sla_policies, sla_timers (5); ticket_categories, tickets, ticket_messages, ticket_assignments, ticket_participants, escalation_rules, ticket_escalations, ticket_feedback | 5 / 6 |
| Documents | files, file_links, retention_policies | 1 |
| Notifications | outbox_events, notification_templates, notifications, notification_deliveries, notification_preferences, push_subscriptions | 1 (core, in-app, email) / 2 (push) |
| Audit | audit_events | 1 |
| Imports | import_jobs, import_job_rows | 2 |
| AI | ai_conversations, ai_messages, ai_tool_calls, kb_documents, kb_chunks | tool gateway code in 1 (no tables); tables in AI milestone |
| Exams / results | examinations, exam_schedules, exam_registrations, assessments, marks, mark_revisions, grade_scales, results, result_lines | post-pilot |
| Finance | fee_structures, fee_components, student_fee_assignments, invoices, invoice_lines, payments, receipts, scholarships, scholarship_awards, refunds, credit_notes | post-pilot |
| Optional modules (own migrations, own schema) | capture_qr_*; biometrics_* (consent-specific, template storage, liveness, logs) | decided separately |

Notes
- `students.id` is the identity key; `student_programs` (M1) carries campus/department scope; term-level history arrives with M3 without altering M1 tables.
- Soft-delete only where listed in `02` §4.1.

---

## 3. Final academic model (configurable)

```
Organization
 ├─ period_types (Semester | Trimester | Year | custom)       ← terminology, not logic
 ├─ AcademicYear ──► Term (per campus; free code)             ← calendar windows, any number per year
 └─ Department ──► Program (period_type, duration_periods)
                     ├─ curriculum_courses (regulation, period_no, category)   ← what is prescribed
                     └─ Cohort/Batch (intake)
                           └─ CohortPeriod (period_no ↔ Term)                  ← "this cohort's Nth period runs in that term"
                                 ├─ Section
                                 └─ ElectiveGroup (min..max, window)
 Course (catalog) ──► CourseOffering (term, [section|group|open], elective_group, attendance_policy pinned)
 Student ──► StudentProgram ──► TermEnrollment (cohort_period, roll no) ──► SectionMembership (dated)
                                          └──► CourseRegistration (student × offering, kind, status)   ← SEPARATE from enrollment
```

### 3.1 Validation against three real structures

| Structure | Configuration | Check |
|---|---|---|
| **4-year B.Tech, semesters, electives & labs, backlog** | period_type SEMESTER; program duration_periods = 8; terms ODD/EVEN per campus per year; cohort 2026 → cohort_periods (sem1→ODD 26-27, sem2→EVEN 26-27 …); sections A/B; curriculum_courses CORE per period; elective_groups "Professional Elective I" (1..1); labs as `LAB_GROUP` offerings with `group_label` and explicit registrations; backlog paper = `registration_kind=BACKLOG` registration of an earlier-period offering within a later `term_enrollment` | Two students in Section A hold different electives/labs; a backlog paper attaches to the current enrollment without changing the cohort |
| **3-year B.A., annual system** | period_type YEAR; duration_periods = 3; one term per academic year (`ANNUAL`); cohort_periods one per year; optional papers as `OPTIONAL` category; no sections or one | No semester assumption anywhere; "Year 2" is `period_no=2` labelled via period type |
| **2-year MBA, trimesters, internship, project** | period_type TRIMESTER; duration_periods = 6; three terms per year; internship `course_type=INTERNSHIP`, `tracks_attendance=false`, credits only; project registered as `PROJECT` offering without timetable slots | Attendance engine skips non-tracked offerings; registration and (later) results still work |
| Repeat / detention | Student gets a new `term_enrollment` on a later cohort's `cohort_period` with `enrollment_type=REPEAT` | History preserved; no student duplication |
| Mid-programme transfer (department) | New `student_programs` row (`TRANSFER_IN`) | Identity unchanged |

Remaining modelling limits (accepted): joint/dual degrees (one active `student_programs` per student in v1 of the model), programs whose study period changes type mid-way, and cross-campus course sharing beyond shared catalog offerings — each can be added without rewriting existing tables.

### 3.2 Course registration rules (final)

- `AUTO_FROM_SECTION`: when an offering is published, registrations are generated for current section members (CORE).
- `ELECTIVE_CHOICE`: student (or admin on their behalf) registers within `elective_groups.opens_at..closes_at`; validated against min/max and capacity; optional admin approval (`PENDING_APPROVAL`).
- `ADMIN_ASSIGNED`: projects, internships, lab groups, exemptions.
- Dropping/withdrawing closes the registration (`valid_to`), never deletes. A registration open on `session_date` defines who is on that session's roster.

---

## 4. Final attendance model

- **Statuses (v1 engine)**: PRESENT, ABSENT, LATE, EXCUSED (approved absence).
- **Policy**: `attendance_policies` (versioned JSON rules, scope wildcards) resolved most-specific-wins and pinned to the offering at publish. Rules: `min_percentage`, `warning_thresholds[]`, `status_treatment` (numerator/denominator weights per status), `edit_window_days`, `correction_requires_approval`.
- **Examples (all pure configuration)**:
  - Org default: 75%, warnings at 80/76, LATE counts as PRESENT, EXCUSED excluded from denominator.
  - Program override (Nursing): 85%, LATE counts 0.5.
  - Course override (Clinical Lab): 100% of sessions, EXCUSED counts as present.
  - Semester override: relaxed 70% for the first period.
- **Leave/medical adjustment**: initial implementation = EXCUSED status set via an approved leave/medical service request (`excused_by_request_id`) or admin action with reason. A `leave_records` table that auto-excuses date ranges is reserved.
- **Corrections**: revision rows with reason, approver, request link; original value always recoverable; term lock blocks edits.
- **Events**: `attendance.session_submitted`, `attendance.low` (warning/shortfall level change), `attendance.record_corrected`.
- **Optional capture modules** (QR, biometric) write through `attendance.markFromCapture()` which applies the same validation, revision and audit rules; they are absent from the core schema and build.

---

## 5. Final student identity (confirmed)

Internal `students.id` (UUIDv7, immutable) ≠ admission number (tenant-unique, format validated/generated per `identity.admission_number` setting) ≠ roll number (`term_enrollments`, per period) ≠ email/phone (account attributes, changeable, verified). Academic facts never reference email, phone, roll number, section or admission number. See `02` Part 6.

---

## 6. Notification model (confirmed)

Modules emit domain events through the outbox; the notification module maps event → audience → channels (in-app, push, email) via a `ChannelProvider` registry. SMS/WhatsApp are additional providers later. Example: `attendance.low` → in-app (always) + push + email subject to preferences/consent; guardian copy only if `guardian.notification_policy` and link flags allow, with minimal content. No business module imports a provider.
