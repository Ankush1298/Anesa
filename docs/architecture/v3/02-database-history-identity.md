# Blueprint v3 — Parts 4–6: Database, Historical Data, Student Identity

Notation for column specs: `col type!` = NOT NULL, `col type?` = nullable. `FK→t` foreign key. `UQ` unique. `IDX` index. Enumerations are `varchar` + CHECK (not Postgres ENUM, which is painful to migrate); allowed values listed.

---

## PART 4 — DATABASE DESIGN

### 4.1 Global conventions (apply to every table unless stated)

| Rule | Detail |
|---|---|
| Primary key | `id uuid!` — **UUIDv7 generated in the app**. Never exposed sequentially. |
| Tenant | `organization_id uuid! FK→organizations` + RLS policy. Global tables: `organizations`, `permissions`, `organization_domains`, `platform_admins`. |
| Timestamps | `created_at timestamptz! default now()`, `updated_at timestamptz! default now()` (trigger-maintained). |
| Actor columns | `created_by uuid? FK→users`, `updated_by uuid? FK→users` on mutable business tables. Null = system. |
| Concurrency | `version int! default 1` on tables edited concurrently (class_sessions, service_requests, tickets, terms). Updates use `WHERE version = :v`. |
| Soft delete | Only `users`, `departments`, `courses`, `service_types`, `ticket_categories`, `files`, `guardians` get `deleted_at timestamptz?`. Everything historical (attendance, marks, results, enrollments, requests, tickets, audit, finance) is **never deleted**: lifecycle via `status`. Unique constraints on soft-deletable tables are partial: `WHERE deleted_at IS NULL`. |
| Effective dating | `valid_from date!`, `valid_to date?` (null = open). Overlap forbidden by `EXCLUDE USING gist` (extension `btree_gist`). `valid_to` inclusive. |
| Time | Instants are `timestamptz`. A class's calendar day is stored separately as `session_date date` in the campus timezone. |
| Money | `bigint` minor units + `currency char(3)`. |
| Indexes | Lead composite list indexes with `organization_id`. Every FK has an index. Partial indexes for "active/open" subsets. |
| Immutability | Append-only tables carry a trigger rejecting UPDATE/DELETE: `audit_events`, `attendance_record_revisions`, `mark_revisions`, `request_approvals`, `request_events`, `ticket_messages`. Published `results`/`result_lines` reject UPDATE (status transition to SUPERSEDED excepted). |
| Audit | Column "Audit" per table: **A0** none, **A1** `audit_events` row, **A2** audit row + mandatory reason + history table. |
| Naming | snake_case plural tables; FK `<entity>_id`; booleans `is_/has_`; dates `*_on`/`*_date`, instants `*_at`. |

### 4.2 Tenancy & organization

```
organizations            PK id | Audit A1 | no soft delete (status ARCHIVED)
  name varchar(255)!  slug varchar(63)! UQ  legal_name varchar(255)?
  status varchar(20)! [ACTIVE|SUSPENDED|ARCHIVED]
  default_timezone varchar(64)!  default_locale varchar(10)! default 'en'
  organization_group_id uuid? (future)
  RLS: id = app.org_id

organization_domains     PK id | FK organization_id
  hostname varchar(255)! UQ(global)  is_primary bool!  verified_at timestamptz?

organization_settings    typed key/value per tenant | A1 (CRITICAL keys A2)
  key varchar(100)! (registry in code: type, schema, default, sensitivity)  value jsonb!  updated_by!  version
  PK(organization_id, key). Keys used from M1:
    terminology                    {cohort:"Batch", section:"Section", ...}   display labels only
    academic.degree_levels         ["UG","PG","Diploma",...]
    identity.admission_number      {pattern: regex, example, generate?: {template:"{yyyy}{program}{seq:4}", sequence_scope:"program_year"}, mode: VALIDATE|GENERATE|BOTH}
    identity.age_of_majority       int (default 18; jurisdiction decision is the tenant's/legal's, not ours)
    identity.dob_required          bool
    guardian.notification_policy   NEVER | MINORS_ONLY | ALWAYS_WHEN_ENABLED
    guardian.academic_visibility   MINORS_ONLY | ALWAYS_WHEN_LINKED | NEVER   (adult students always need own consent)
    privacy.student_fields         {required:[...], optional:[...]}  -- data-minimisation register; nothing outside it is collectable
    security.password_policy / session_lifetimes
    retention.*                    per data class
    attendance.default_policy_id

campuses                 PK id | FK organization_id | A1
  name varchar(255)!  code varchar(20)!  timezone varchar(64)!
  address jsonb!  status varchar(20)! [ACTIVE|INACTIVE]
  UQ(organization_id, code)

departments              PK id | FK organization_id, campus_id→campuses, parent_department_id→departments? | A1
  name varchar(255)!  code varchar(20)!  kind varchar(20)! [ACADEMIC|ADMINISTRATIVE|SERVICE]
  status varchar(20)!  deleted_at?
  UQ(campus_id, code) WHERE deleted_at IS NULL    IDX(organization_id, campus_id)

designations             UQ(organization_id, code)  name!  category! [TEACHING|NON_TEACHING|ADMIN]
rooms                    FK campus_id | UQ(campus_id, code) | kind, capacity?
number_sequences         PK(organization_id, key, period) | next_value bigint!   (allocated with SELECT … FOR UPDATE)
```

### 4.3 Identity & access

```
users                    PK id | FK organization_id | Audit A2 (email/phone/status) | soft delete deleted_at
  email citext?  email_verified_at?  phone varchar(20)?  phone_verified_at?
  password_hash varchar(255)?      -- argon2id (change from bcrypt; see ADR-004)
  first_name varchar(100)!  middle_name?  last_name?  display_name varchar(200)!
  date_of_birth date?  gender varchar(20)?  locale varchar(10)?  avatar_file_id? FK→files
  status varchar(20)! [INVITED|ACTIVE|SUSPENDED|DEACTIVATED|ANONYMIZED]
  authz_version int! default 1     -- bumped on any role/assignment change
  failed_login_count smallint!  locked_until timestamptz?  last_login_at?
  UQ(organization_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL
  IDX(organization_id, status)   GIN trigram on display_name

external_identities      FK user_id | provider!, subject! | UQ(provider, subject) | A1

sessions                 FK user_id | A1 (create/revoke)
  refresh_family_id uuid!  token_hash char(64)! UQ  prev_token_hash char(64)?  -- reuse detection
  user_agent text?  ip inet?  device_label?  impersonated_by uuid?
  created_at!  last_used_at!  expires_at!  absolute_expires_at!  revoked_at?  revoked_reason?
  IDX(user_id) WHERE revoked_at IS NULL

password_reset_tokens    token_hash UQ, expires_at, used_at   (purge after 30 days)

roles                    FK organization_id? (null = system) | A1
  code varchar(60)!  name!  kind [SYSTEM|CUSTOM]!   UQ(coalesce(organization_id,zero), code)
permissions              PK code varchar(100)  module!  description  sensitivity [NORMAL|SENSITIVE|CRITICAL]!   -- seeded from code
role_permissions         PK(role_id, permission_code) | scope_mode varchar(10)! [SELF|ASSIGNED|GRANTED]

role_assignments         PK id | FK user_id, role_id | A2
  scope_type varchar(15)! [ORGANIZATION|CAMPUS|DEPARTMENT]
  campus_id? FK  department_id? FK     CHECK matches scope_type
  valid_from date!  valid_to date?  status [ACTIVE|REVOKED|EXPIRED]!
  granted_by uuid!  grant_reason text?  revoked_by?  revoked_at?
  UQ(user_id, role_id, scope_type, coalesce(campus_id), coalesce(department_id)) WHERE status='ACTIVE'
  IDX(user_id, status)   IDX(organization_id, department_id) WHERE status='ACTIVE'

consents                 FK user_id (subject) | A2 | never deleted
  consent_type varchar(40)! (registry in code; M1: DATA_PROCESSING, COMMUNICATIONS_EMAIL, COMMUNICATIONS_PUSH; later: SMS, WHATSAPP, and module-defined types such as BIOMETRIC_* )
  policy_version varchar(20)!  status [GRANTED|WITHDRAWN]!  granted_at!  withdrawn_at?
  ip inet?  method varchar(20)!  granted_by_user_id!  -- the subject, or a guardian acting for a minor
  guardian_id uuid?  policy_text_hash char(64)!
  IDX(user_id, consent_type, status)
```

### 4.4 People

```
students                 PK id (permanent student key) | FK organization_id, user_id UQ | A2
  admission_number varchar(50)!  admission_date date!
  registration_number varchar(50)?     -- university/board number, set-once
  status varchar(20)! [ADMITTED|ACTIVE|ON_LEAVE|SUSPENDED|DISCONTINUED|GRADUATED|TRANSFERRED_OUT]
  status_changed_at!  merged_into_student_id uuid? FK→students
  UQ(organization_id, admission_number)
  UQ(organization_id, registration_number) WHERE registration_number IS NOT NULL
  Trigger: admission_number immutable once set (admin correction via audited function)
  IDX(organization_id, status)

student_identifiers      FK student_id | A1
  id_type varchar(40)! [UNIVERSITY_PRN|APAAR|LIBRARY_CARD|HOSTEL_ID|OTHER]  value varchar(100)!
  issuer?  valid_from?  valid_to?    UQ(organization_id, id_type, value)

guardians                full_name!, phone!, email?, user_id? FK (guardian login is post-pilot) | deleted_at | A1
                         Data minimisation: name + one phone is the required minimum; everything else optional per `privacy.student_fields`.
student_guardians        FK student_id, guardian_id | relation!, is_primary bool!, is_legal_guardian bool!,
                         can_give_consent bool! (may consent on behalf of a minor), is_emergency_contact bool!,
                         can_view_academics bool!, can_receive_notifications bool!, valid_from date!, valid_to date? | A2
                         UQ(student_id, guardian_id)   partial UQ(student_id) WHERE is_primary AND valid_to IS NULL
                         Effective access is computed, not stored: see 06 §6 "Minors and guardians".
users.date_of_birth      optional unless org setting `identity.dob_required`. "Is minor" is NEVER stored; it is computed from
                         DOB, `identity.age_of_majority` and the evaluation date. Unknown DOB + dob_required=false → treated as ADULT
                         for policy purposes unless the tenant sets `identity.unknown_dob_policy = TREAT_AS_MINOR`.

employees                PK id | FK user_id UQ | A2
  employee_code varchar(50)!  employee_type [FACULTY|STAFF|ADMIN|VISITING]!
  joining_date date!  leaving_date?  status [ACTIVE|ON_LEAVE|SEPARATED]!   UQ(organization_id, employee_code)
employee_postings        FK employee_id, department_id, designation_id? | valid_from!, valid_to?, is_primary | A1
                         EXCLUDE no overlap per (employee_id, department_id)
                         IDX(department_id, valid_to) -- "who is in this department now"
```

### 4.5 Academic calendar & structure (configurable — v3.1)

Nothing below hard-codes the number of years, periods, terms or electives. Terminology ("Semester", "Trimester", "Year", "Batch") is display configuration: `period_types.label` and the `terminology` org setting.

```
period_types             org-configurable kinds of study period | A1
  code varchar(30)!  label varchar(50)!  label_plural varchar(50)!      -- e.g. SEMESTER/"Semester", YEAR/"Year", TRIMESTER/"Trimester"
  UQ(organization_id, code)    (seeded defaults: SEMESTER, TRIMESTER, YEAR; admins can add)

academic_years           UQ(organization_id, label) | label varchar(20)! ("2026-27")
  start_date!  end_date!  status [PLANNED|ACTIVE|CLOSED]!  CHECK end_date > start_date  EXCLUDE overlap | A1

terms                    calendar window of teaching at a campus | FK campus_id, academic_year_id | A2 on status → LOCKED | version
  code varchar(30)!  name!                      -- free: ODD, EVEN, T1, SUMMER, ANNUAL …
  start_date!  end_date!  status [PLANNED|ACTIVE|CLOSED|LOCKED]!  attendance_edit_until date?  locked_at?  locked_by?
  UQ(campus_id, academic_year_id, code)    IDX(organization_id, status)
  Annual systems: one term per year. Trimester systems: three. Semester: two (+ optional summer).
  Semantics: ACTIVE = teaching; CLOSED = admin corrections only; LOCKED = nothing changes without an A2 override

programs                 FK department_id, period_type_id | UQ(organization_id, code) | A1
  name!  code!  degree_level varchar(30)!   (allowed values come from org setting `academic.degree_levels`)
  duration_periods smallint!      -- number of study periods in the programme (8 semesters, 3 years, 9 trimesters …)
  periods_per_year smallint?      -- informational, used by promotion tooling
  default_regulation varchar(30)? -- which curriculum_courses regulation applies to new cohorts
  status!

cohorts                  FK program_id | UQ(program_id, admission_year, intake_code) | A1     -- UI label "Batch"/"Cohort"
  admission_year smallint!  intake_code varchar(10)! default 'MAIN'  name!  regulation varchar(30)?
  expected_graduation_year?  status [ACTIVE|GRADUATED|CLOSED]!

cohort_periods           FK cohort_id, term_id | UQ(cohort_id, term_id) UQ(cohort_id, period_no) | A1
  period_no smallint!  status!   IDX(term_id)       -- "this cohort's 3rd study period runs in this term"
  period_no must be within 1..programs.duration_periods unless flagged `is_extension` (extra year/backlog period)

sections                 FK cohort_period_id | UQ(cohort_period_id, name) | name varchar(50)!  capacity smallint?  status!

courses                  UQ(organization_id, code) WHERE deleted_at IS NULL | owning_department_id? FK
  code varchar(30)!  title varchar(255)!  credits numeric(4,1)!
  course_type [THEORY|PRACTICAL|THEORY_PRACTICAL|PROJECT|INTERNSHIP|SEMINAR|AUDIT|OTHER]!
  tracks_attendance bool! default true     -- internships/projects may opt out
  status!  deleted_at?

curriculum_courses       what a programme prescribes | FK program_id, course_id | A1
  regulation varchar(30)!  period_no smallint!  category [CORE|ELECTIVE|OPTIONAL|LAB|PROJECT|INTERNSHIP]!
  elective_group_code varchar(30)?   UQ(program_id, regulation, period_no, course_id)
  Drives auto-registration of CORE courses; ELECTIVE/OPTIONAL are registered by choice.

elective_groups          FK cohort_period_id | "choose min..max from this basket" | A1
  code!  name!  min_select smallint!  max_select smallint!  opens_at timestamptz?  closes_at timestamptz?  status [PLANNED|OPEN|CLOSED]!
  UQ(cohort_period_id, code)

course_offerings         FK campus_id, term_id, course_id, section_id?, cohort_period_id?, elective_group_id?, attendance_policy_id? | A1 | version
  offering_kind [CORE|ELECTIVE|OPEN_ELECTIVE|OPTIONAL|LAB_GROUP|PROJECT|INTERNSHIP]!  group_label varchar(30)?
  code_snapshot!  title_snapshot!  credits_snapshot!      -- frozen when status → PUBLISHED
  tracks_attendance bool!   attendance_policy_id uuid?     -- resolved & pinned at PUBLISH (Part 7 of attendance policy resolution)
  registration_policy [AUTO_FROM_SECTION|MANUAL|ELECTIVE_CHOICE|ADMIN_ASSIGNED]!  capacity?
  status [DRAFT|PUBLISHED|CLOSED|CANCELLED]!
  UQ(term_id, course_id, coalesce(section_id), coalesce(group_label))
  IDX(organization_id, term_id, status)   IDX(section_id)   IDX(elective_group_id)
```

Course registration is deliberately separate from term enrollment (§4.6): two students in the same section can hold different course sets (electives, labs by group, backlog papers, projects, internships, optional courses).

### 4.6 Enrollment (history-bearing)

```
student_programs         FK student_id, program_id, cohort_id, campus_id, department_id | A2
  start_date date!  end_date date?  status [ACTIVE|COMPLETED|TRANSFERRED_OUT|DISCONTINUED|ON_LEAVE]!
  entry_type [REGULAR|LATERAL|TRANSFER_IN|READMISSION]!  previous_student_program_id? FK→self  exit_reason?
  UQ(student_id) WHERE status='ACTIVE'    IDX(organization_id, department_id, status)  IDX(cohort_id)
  department_id/campus_id are frozen copies at the time the row was opened.

term_enrollments         FK student_id, student_program_id, cohort_period_id, term_id | A2
  period_no smallint!  status [REGISTERED|ACTIVE|WITHDRAWN|DETAINED|PROMOTED|COMPLETED|ON_LEAVE]!
  enrollment_type [REGULAR|REPEAT|BACKLOG|SUMMER]!  roll_number varchar(30)?  registered_at!
  UQ(student_id, cohort_period_id)    UQ(cohort_period_id, roll_number) WHERE roll_number IS NOT NULL
  IDX(cohort_period_id, status)   IDX(term_id)

section_memberships      FK term_enrollment_id, student_id, section_id | A2
  valid_from date!  valid_to date?  change_reason varchar(100)?  changed_by uuid!
  EXCLUDE no overlap per term_enrollment_id    IDX(section_id) WHERE valid_to IS NULL

course_registrations     FK term_enrollment_id, student_id, course_offering_id | A1
  status [PENDING_APPROVAL|REGISTERED|REJECTED|DROPPED|WITHDRAWN|COMPLETED]!  valid_from date!  valid_to date?
  source [AUTO_SECTION|MANUAL|ELECTIVE_CHOICE|ADMIN]!  registration_kind [REGULAR|BACKLOG|IMPROVEMENT|AUDIT|EXEMPTED]!
  elective_group_id uuid? FK  -- registration validated against group min/max/window at write time
  UQ(student_id, course_offering_id) WHERE valid_to IS NULL
  IDX(course_offering_id) WHERE valid_to IS NULL   IDX(student_id, valid_from)

faculty_assignments      FK course_offering_id, employee_id | A2
  role [PRIMARY|CO_INSTRUCTOR|LAB_INSTRUCTOR|SUBSTITUTE]!  valid_from date!  valid_to date?
  EXCLUDE (course_offering_id WITH =, daterange WITH &&) WHERE role='PRIMARY'
  IDX(employee_id, valid_to)
```

### 4.7 Timetable, sessions, attendance (face/biometrics removed from core — v3.1)

```
timetable_slots          FK course_offering_id, room_id?, faculty_assignment_id? | A1
  weekday smallint! (ISO 1–7)  start_time time!  end_time time!  effective_from date!  effective_to date?
  EXCLUDE no overlap (room_id, weekday, time range, date range)

class_sessions           FK campus_id, course_offering_id, timetable_slot_id?, room_id?, conducted_by_employee_id | A1 | version
  session_date date! (campus-local)  starts_at timestamptz!  ends_at timestamptz!
  kind [REGULAR|EXTRA|MAKEUP]!  topic text?
  status [SCHEDULED|CONDUCTED|CANCELLED]!  cancel_reason?
  attendance_state [NOT_STARTED|OPEN|SUBMITTED|LOCKED]!
  attendance_submitted_at?  attendance_submitted_by?  locked_at?
  UQ(course_offering_id, starts_at)
  IDX(organization_id, course_offering_id, starts_at)  IDX(conducted_by_employee_id, starts_at)
  IDX(organization_id, campus_id, session_date)

attendance_records       FK class_session_id, student_id, course_registration_id, course_offering_id | A2 | never deleted | version
  session_date date!   status [PRESENT|ABSENT|LATE|EXCUSED]!     -- EXCUSED = approved absence / approved leave
  source [MANUAL|IMPORT|CORRECTION|SYSTEM|QR]!                   -- extensible CHECK; QR/biometric sources are added by later modules
  marked_by_user_id!  marked_at!  revision_no int! default 1  remarks text?
  excused_by_request_id uuid?     -- service_request that authorised EXCUSED (leave/medical); no FK to other modules' internals beyond this id
  capture_session_id uuid?        -- opaque reference written by an optional capture module; NO foreign key, NO dependency
  UQ(class_session_id, student_id)
  IDX(student_id, session_date)   IDX(course_offering_id, student_id)   IDX(class_session_id)
  Composite FK (organization_id, class_session_id) (high-risk cross-tenant join).
  Writes only via the attendance service: INSERT at submission; UPDATE only paired with a revision row in the same tx.
  Row Level Security adds the student backstop (see 05-tenant-isolation-model.md §5).

attendance_record_revisions   append-only | A2
  attendance_record_id!, revision_no!, status_before?, status_after!, source!, changed_by_user_id!, changed_at!
  reason_code varchar(40)! [FACULTY_ERROR|STUDENT_DISPUTE|MEDICAL|DUTY_LEAVE|SYSTEM_RECOMPUTE|OTHER]
  reason_text?  approved_by_user_id?  service_request_id?    UQ(attendance_record_id, revision_no)

attendance_policies      configurable rule sets | A2 | versioned, never edited in place once ACTIVE
  name!  status [DRAFT|ACTIVE|RETIRED]!  version_no int!  priority smallint! default 0
  scope (all nullable = wildcard; all null = organization default):
    campus_id?  department_id?  program_id?  course_id?  course_offering_id?  term_id?  period_no smallint?
  rules jsonb! validated against a versioned JSON schema:
    { "schema": 1,
      "min_percentage": <0..100>,
      "warning_thresholds": [<descending percentages>],
      "status_treatment": { "PRESENT":{"num":1,"den":1}, "LATE":{"num":1,"den":1},
                            "ABSENT":{"num":0,"den":1},  "EXCUSED":{"num":0,"den":0} },
      "edit_window_days": <int>, "correction_requires_approval": <bool> }
  effective_from date!  effective_to date?
  EXCLUDE: no two ACTIVE policies with identical scope overlap in time
  Resolution (most specific wins): offering > course > program+period > program > term > department > campus > org default;
  ties → higher `priority`, then newer `version_no`. The result is PINNED on course_offerings.attendance_policy_id at publish.
  Changing a policy never silently re-grades history: admin runs an audited "re-pin & recompute" for chosen offerings.

attendance_summaries     PK(student_id, course_offering_id) | rebuildable | A0
  held_count, present_count, late_count, excused_count, absent_count smallint!
  numerator numeric(8,2)!  denominator numeric(8,2)!  percentage numeric(5,2)?  as_of_date!  computed_at!
  policy_id uuid!  policy_version int!  eligibility_state [OK|WARNING|SHORTFALL|NOT_APPLICABLE]!  warning_level smallint!
  IDX(course_offering_id, percentage)   IDX(organization_id, eligibility_state)
  Event `attendance.low` is emitted (once per student × offering × level) when warning_level increases or SHORTFALL begins.

leave_records            RESERVED (post-pilot): approved leave/medical periods that auto-mark EXCUSED. Until then EXCUSED is set
                         by faculty/admin with a reason, or by an approved ATTENDANCE_CORRECTION / LEAVE service request.
```

Not in the attendance core (separate optional modules, built later, depending on `attendance` — never the reverse): rotating-code/QR capture, face/biometric capture. See ADR-016 and ADR-022.

### 4.8 Examination & results (post-pilot; critical constraints only)

```
examinations         FK campus_id, term_id | kind [INTERNAL|MIDTERM|END_SEM|SUPPLEMENTARY|REVALUATION]! status! | A1
exam_schedules       FK examination_id, course_id, course_offering_id? | starts_at!, ends_at!, max_marks numeric(6,2)!, pass_marks? | UQ(examination_id, course_id, starts_at)
exam_registrations   FK exam_schedule_id, student_id, course_registration_id? | status!, eligibility_snapshot jsonb!, hall_ticket_no? | UQ(exam_schedule_id, student_id)
assessments          FK course_offering_id, exam_schedule_id? | name!, kind!, max_marks numeric(6,2)!, weightage numeric(5,2)!, status [DRAFT|OPEN|LOCKED|PUBLISHED]!
marks                FK assessment_id, student_id, course_registration_id | marks_obtained numeric(6,2)?, status [ENTERED|ABSENT|EXEMPT|WITHHELD|MALPRACTICE]!, revision_no | UQ(assessment_id, student_id) | A2
mark_revisions       append-only, same shape as attendance_record_revisions
grade_scales         scale jsonb!, effective_term_id! | versioned
results              FK student_id, term_enrollment_id, examination_id?, supersedes_result_id? | version int!, status [DRAFT|PUBLISHED|WITHHELD|SUPERSEDED]!, sgpa?, cgpa?, outcome?, published_at?, published_by? | UQ(term_enrollment_id, examination_id, version) | A2
result_lines         FK result_id, course_registration_id | course_code!, course_title!, credits!, marks?, grade?, grade_points?, pass_status! -- snapshots; immutable once result PUBLISHED
```

### 4.9 Service requests

```
service_types           UQ(organization_id, code) WHERE deleted_at IS NULL | name!, audience [STUDENT|EMPLOYEE|BOTH]!, status!, current_version_id? | A1
service_type_versions   FK service_type_id | version_no int!, status [DRAFT|PUBLISHED|RETIRED]!, form_schema jsonb!, eligibility jsonb?,
                        sla_minutes int?, fulfilment_action varchar(60)?, fulfilment_config jsonb?, document_template_id?, published_at?, published_by?
                        UQ(service_type_id, version_no); partial UQ(service_type_id) WHERE status='PUBLISHED'; PUBLISHED rows frozen | A2
workflow_steps          FK version_id | seq smallint!, name!, step_type [APPROVAL|REVIEW|FULFILMENT|NOTIFY]!,
                        assignee_kind [ROLE_IN_SCOPE|RELATION|USER|QUEUE]!, assignee_role_id?, assignee_relation varchar(40)?, assignee_user_id?, queue_id?,
                        sla_minutes?, allow_return bool!, on_reject [REJECT_REQUEST|RETURN_TO_REQUESTER]!, condition jsonb?  | UQ(version_id, seq)

service_requests        FK service_type_id, version_id, requester_user_id, subject_student_id?, campus_id, department_id? | A1 | version
  ref_no varchar(40)!  status [DRAFT|SUBMITTED|IN_PROGRESS|RETURNED|APPROVED|REJECTED|FULFILLED|CANCELLED|EXPIRED]!
  form_data jsonb!  current_step_seq smallint?  source [WEB|AI|ADMIN]!  idempotency_key varchar(64)?
  submitted_at?  due_at?  completed_at?  outcome varchar(30)?
  UQ(organization_id, ref_no)   UQ(organization_id, requester_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  IDX(organization_id, status, due_at)   IDX(requester_user_id, created_at DESC)   IDX(organization_id, campus_id, department_id, status)
request_step_instances  FK request_id, workflow_step_id | seq!, attempt smallint! default 1, status [WAITING|ACTIVE|APPROVED|REJECTED|RETURNED|SKIPPED|CANCELLED]!,
                        assigned_user_id?, assigned_queue_id?, assignment_basis jsonb!, activated_at?, completed_at?, due_at?
                        UQ(request_id, seq, attempt)   IDX(assigned_user_id) WHERE status='ACTIVE'   IDX(assigned_queue_id) WHERE status='ACTIVE'
request_approvals       append-only | step_instance_id, actor_user_id, decision [APPROVE|REJECT|RETURN|DELEGATE]!, comment?, delegated_to?, decided_at! | A2
request_events          append-only timeline | request_id, event_type!, actor_type!, actor_user_id?, visibility [REQUESTER_VISIBLE|STAFF_ONLY]!, body?, data jsonb?
```

### 4.10 Tickets & shared SLA

```
work_queues             FK campus_id?, department_id? | name!, kind [DEPARTMENT|TEAM|ROLE]!, auto_assign [NONE|ROUND_ROBIN|LEAST_LOAD]! | A1
work_queue_members      PK(queue_id, user_id) | member_role [LEAD|MEMBER]!, is_active bool!
ticket_categories       FK default_queue_id, sla_policy_id? | name!, audience [STUDENT|DEPARTMENT|INTERNAL|ALL]!, default_priority!, deleted_at?
tickets                 FK category_id, requester_user_id, requester_department_id?, about_student_id?, queue_id?, assignee_user_id?, parent_ticket_id?, linked_request_id?, campus_id, department_id? | A1 | version
  ticket_no varchar(40)!  kind [STUDENT|DEPARTMENT|INTERNAL]!  subject varchar(255)!  description text!
  priority [LOW|MEDIUM|HIGH|URGENT]!  status [OPEN|IN_PROGRESS|PENDING_REQUESTER|ON_HOLD|RESOLVED|CLOSED|CANCELLED]!
  source [WEB|AI|ADMIN|EMAIL]!  first_response_at?  resolved_at?  resolved_by?  closed_at?
  resolution_code varchar(40)?  resolution_summary text?  reopen_count smallint! default 0  reopen_allowed_until timestamptz?
  UQ(organization_id, ticket_no)
  IDX(organization_id, status, priority)  IDX(queue_id, status)  IDX(assignee_user_id, status)  IDX(requester_user_id, created_at DESC)
ticket_messages         append-only | ticket_id, author_user_id, visibility [PUBLIC|INTERNAL]!, body text!, source!, created_at   IDX(ticket_id, created_at)
ticket_assignments      ticket_id, assignee_user_id?, queue_id?, assigned_by?, assigned_at!, unassigned_at?, reason [MANUAL|AUTO_RULE|ESCALATION|REASSIGN]!
ticket_participants     PK(ticket_id, user_id) | role [WATCHER|CC]!
escalation_rules        FK category_id? | trigger [FIRST_RESPONSE_BREACH|RESOLUTION_BREACH|REOPEN_COUNT]!, after_minutes?, action [REASSIGN_QUEUE|NOTIFY_ROLE|RAISE_PRIORITY]!, target jsonb!
ticket_escalations      ticket_id, rule_id, triggered_at!, outcome jsonb
ticket_feedback         UQ(ticket_id) | rating smallint! CHECK 1..5, comment?
sla_policies            name!, first_response_minutes?, resolution_minutes?, pause_on_statuses text[]!, business_calendar_id? | A1
sla_timers              subject_type [TICKET|REQUEST_STEP]!, subject_id!, timer_kind [FIRST_RESPONSE|RESOLUTION|STEP]!,
                        started_at!, due_at!, paused_at?, paused_seconds int!, stopped_at?, breached_at?, escalation_level smallint!,
                        status [RUNNING|PAUSED|MET|BREACHED|CANCELLED]!
                        UQ(subject_type, subject_id, timer_kind)   IDX(due_at) WHERE status='RUNNING'   -- poller scans this
```

### 4.11 Files, audit, notifications, AI

```
files                   FK uploaded_by | A1 (sensitive access logged too)
  storage_class [GENERAL|SENSITIVE|GENERATED]!  storage_key text!  original_name varchar(255)!  declared_mime?  detected_mime?
  size_bytes bigint?  sha256 char(64)?  status [PENDING_UPLOAD|SCANNING|AVAILABLE|QUARANTINED|DELETED|PURGED]!
  classification [INTERNAL|CONFIDENTIAL|RESTRICTED]!  scan_result?  scanned_at?  retention_until date?  legal_hold bool!  deleted_at?  purged_at?
  UQ(storage_class, storage_key)   IDX(organization_id, status)  IDX(retention_until) WHERE status='DELETED'
file_links              FK file_id | entity_type varchar(60)!, entity_id uuid!, purpose varchar(40)!, visibility [OWNER_VISIBLE|STAFF_ONLY]!
                        UQ(file_id, entity_type, entity_id, purpose)   IDX(entity_type, entity_id)

audit_events            PARTITION BY RANGE (occurred_at) monthly | PK(id, occurred_at) | append-only | org-scoped, RLS read for audit viewers
  occurred_at timestamptz!  actor_type [USER|SYSTEM|AI|PLATFORM_SUPPORT]!  actor_user_id?  on_behalf_of_user_id?  session_id?  request_id uuid?
  ip inet?  user_agent text?  action varchar(100)!  resource_type varchar(60)!  resource_id uuid?
  subject_student_id uuid?  campus_id?  department_id?  risk_tier smallint! [1|2|3]
  changes jsonb? ({field:{old,new}}, sensitive fields masked)  reason_code varchar(40)?  reason_text?  metadata jsonb?
  IDX(organization_id, occurred_at DESC)  IDX(resource_type, resource_id)  IDX(subject_student_id, occurred_at DESC)  IDX(actor_user_id, occurred_at DESC)

outbox_events           org-scoped | event_type!, aggregate_type!, aggregate_id!, payload jsonb! (IDs only), occurred_at!, available_at!, processed_at?, attempts smallint!, last_error?, dedup_key? UQ
                        IDX(available_at) WHERE processed_at IS NULL
notification_templates, notifications, notification_deliveries, notification_preferences, push_subscriptions → Part 13
ai_conversations, ai_messages, ai_tool_calls, kb_documents, kb_chunks(vector) → Part 10
import_jobs / import_job_rows → type, status [DRAFT|VALIDATED|COMMITTED|FAILED]!, file_id, summary jsonb; rows: row_no, raw jsonb, status, errors jsonb
```

### 4.12 Cross-cutting requirements checklist

| Concern | How the schema satisfies it |
|---|---|
| Tenant isolation | `organization_id` + RLS everywhere; composite FKs on attendance/marks; nightly orphan-link check |
| Student identity | `students.id` is the only student FK in academic tables; `user_id` never used for facts |
| Enrollment | Four layers, effective-dated |
| Academic year / semester / section | `academic_years` → `terms` → `cohort_periods` → `sections`; membership effective-dated |
| Subject | `courses` catalog; `course_offerings` with snapshots |
| Class sessions | Own table, actual teacher, campus-local date, state machine |
| Attendance | Roster snapshot rows + revisions + summaries |
| Exams / results | Versioned results with snapshotted lines |
| Service requests | Versioned definitions pinned per request |
| Tickets | Separate model; shared SLA, queues, files |

---

## PART 5 — HISTORICAL DATA

### 5.1 Principles

1. **Facts reference stable entities, not mutable attributes.** An attendance row points to a *session* and a *registration*; it does not point to "the student's current section".
2. **Memberships are rows with dates, not columns.** Section, posting, faculty assignment, role assignment: `valid_from / valid_to`, no overlap constraint.
3. **Anything that appears on an official document is snapshotted at publication** (course code/title/credits on offerings and result lines; student name/program on generated documents).
4. **State changes on high-value records create revision rows** (attendance, marks), in the same transaction.
5. **"Current" is a query**, not a column: `WHERE valid_to IS NULL` or `status='ACTIVE'`, exposed through views (`v_student_current`).
6. **Closed periods are locked** by `terms.status`. After LOCKED, changes need a high-privilege A2 override with reason.

### 5.2 Worked example — 2025–26 → 2026–27

```
Student S (students.id = s1)  ── student_programs: BTCS / cohort 2025 / dept CSE / campus Main (ACTIVE)

2025-26 ODD  (terms T1)  ─ cohort_periods (cohort2025, T1, sem 1) ─ sections A,B
   term_enrollments(s1, bt1, roll 07, REGULAR→COMPLETED)
   section_memberships(s1, Sec A, 2025-07-15 → open)
   course_registrations(s1 × offerings: MATH-I/A, PHY/A, …)
2025-26 EVEN (T2)   term_enrollments(s1, bt2 = sem 2) …  sections re-shuffled: s1 → Sec B (new membership row under new term_enrollment)
2026-27 ODD  (T3)   term_enrollments(s1, bt3 = sem 3)  roll_number changes (08→21)
2026-27 EVEN (T4)   sem 4 …
```
Every number shown on a past transcript is reproducible because: roll number lives on `term_enrollments`, courses are snapshotted on the offering, faculty on `faculty_assignments` + `class_sessions.conducted_by`, section on `section_memberships`.

### 5.3 Scenario handling

| Concern | Model | Behaviour |
|---|---|---|
| **Academic years** | `academic_years` + per-campus `terms` with status machine | A year/term is never edited retroactively; adjusting dates after ACTIVE requires admin override (A2). `is_current` is derived from `status='ACTIVE'` and dates. |
| **Enrollment history** | `student_programs` → `term_enrollments` → `course_registrations` | Nothing is overwritten on promotion; promotion creates the next `term_enrollment` and marks the previous `PROMOTED`. Repeater/backlog: new `term_enrollment` with `enrollment_type = REPEAT/BACKLOG` against a later cohort-period. |
| **Section changes (mid-term)** | Close the open `section_memberships` row (`valid_to = d-1`), open a new one (`valid_from = d`). Registrations for section-bound offerings: close old (`valid_to`) and open new. | Attendance before `d` stays with the old offering's sessions; after `d`, new offering's sessions. Eligibility % for the term sums both offerings' sessions during the student's registration windows (rule: a session counts iff the registration was open on `session_date`). |
| **Department transfers** | Close the `student_programs` row (`TRANSFERRED_OUT`), open a new one in the new program with `entry_type = TRANSFER_IN`, `previous_student_program_id` set. `student_id` is unchanged. | History shows the full path; reports "by department as of date X" use `student_programs.department_id` valid on X. Credit carry-over is an admin decision recorded as course registrations with `registration_kind = EXEMPTED` (added when finance/exam phase needs it). |
| **Employee department change** | New `employee_postings` row; old closed. | HOD role assignment is separate and also dated. |
| **Subject (course) changes** | Catalog edits don't touch published offerings (snapshots). New syllabus = new course code or new version row of CurriculumCourse (regulation_year). | Old transcripts still show old title/credits. |
| **Faculty changes** | Close/open `faculty_assignments`. A one-off substitute: `class_sessions.conducted_by_employee_id` differs from the primary. | "Who taught session X" = `conducted_by`. "Who was responsible for the offering in March" = assignment valid on that date. Permissions for marking follow the *assignment valid on the session date*; a substitute is granted a SUBSTITUTE assignment for that date. |
| **Attendance history** | `attendance_records` (current value) + `attendance_record_revisions` (every change with reason and approver) | A correction creates revision N+1 and updates the record in one transaction; summaries are recomputed; the original value is always recoverable. Sessions after term lock are read-only. |
| **Result history** | `results` are versioned; `result_lines` snapshot course data; `marks` have `mark_revisions` | Publishing freezes version N. Revaluation creates version N+1 (`supersedes_result_id`); N becomes `SUPERSEDED` but is never edited. Transcripts specify "as published on" a version. |
| **Roles/permissions** | `role_assignments` with `valid_*` and status | "Who had access to X on date D" answerable from assignments + audit. |

### 5.4 As-of query pattern (conceptual)

- Current section of student S: `section_memberships WHERE student_id = S AND valid_from <= today AND (valid_to IS NULL OR valid_to >= today)`.
- Section on 2026-03-10: same with that date.
- Attendance eligibility for term: count `attendance_records` joined to `course_registrations` for the student's term enrollment where `session_date` within the registration window.
- Department strength on date D: `student_programs` with `start_date <= D AND (end_date IS NULL OR end_date >= D)` grouped by `department_id`.

### 5.5 Things we deliberately do not do

- No temporal-table extensions or system-versioned tables — explicit tables are easier to query and explain.
- No event sourcing. Revisions on attendance/marks/results only.
- No retroactive "fix" of past terms without an audited override.

---

## PART 6 — STUDENT IDENTITY

### 6.1 Identifier policy

| Identifier | Stored on | Permanent? | Unique scope | May change? | Notes |
|---|---|---|---|---|---|
| **Internal student ID** (`students.id`, UUIDv7) | `students` | **Yes — forever** | Global | Never | The only key used in academic facts and FKs. Never shown to users; never reused (even after merge). |
| **Admission number** | `students.admission_number` | **Yes** | Per org | Only by audited admin correction (typo) | Institutional permanent ID assigned at admission; printed on documents; safe human lookup key. Format configurable per org; allocated via `number_sequences`. |
| **Registration number** (university/board) | `students.registration_number` | Set-once, may be absent until issued | Per org when present | Admin correction only | Issued by affiliating university; often arrives months after admission. |
| **Roll number** | `term_enrollments.roll_number` | **No** | Per cohort-period | Yes, every term | Class-level label. Never a key. History preserved by term. |
| **Other IDs** (PRN, APAAR/ABC ID, library card, hostel ID) | `student_identifiers` | Per issuer | Per org per type | Per issuer rules | Extendable without schema change. |
| **Email** (login) | `users.email` | No | Per org | Yes, with verification | Credential, not identity. Changing it never touches `students`. Previous values kept in `audit_events`. |
| **Institutional email** | `student_identifiers` type `INSTITUTIONAL_EMAIL` or `users.email` if used for login | No | Per org | Yes | Optional. |
| **Phone** | `users.phone` | No | **Not unique** | Yes, with verification | Siblings/parents share numbers; never a key. |

### 6.2 Why a student is never "a different person"

- All academic tables carry `student_id`. Section, semester, roll number, email, phone, even department are *attributes of enrollment rows* or the account, not of the identity.
- `users.id` (login) and `students.id` (identity) are separate: re-issuing an account (lost email, SSO migration, new institutional email) re-points `students.user_id` through an audited admin action; no academic row changes.
- **Duplicate prevention**: at admission and import, a match check (normalized name + DOB + guardian phone, and exact admission number) warns before creating a second record.
- **Merging duplicates**: admin-only audited operation that sets `merged_into_student_id` on the duplicate and moves non-conflicting child rows; the old ID remains resolvable (redirect), never reused.
- **Re-admission / lateral entry / transfer-in**: same `student_id`, new `student_programs` row.
- **Graduation**: `status = GRADUATED`; the record is retained for verification, transcripts, and certificate re-issue.
- **Erasure/anonymization** (DPDP-style request): `users` PII fields are overwritten and `status = ANONYMIZED`; `students` rows and academic facts remain keyed by `student_id` because retention of academic records is a legal duty; any biometric data held by an optional biometrics module is deleted; files marked for purge unless legal hold.

### 6.3 Student lifecycle

`ADMITTED → ACTIVE ⇄ ON_LEAVE → GRADUATED` · exits: `DISCONTINUED`, `TRANSFERRED_OUT`. Every transition is an A2 audit event with reason; status changes close open registrations/memberships as appropriate (via a domain service, not ad hoc updates).

### 6.4 Login identifier

Student logs in with email **or** admission number (resolved server-side within the tenant). This means a student without a working email can still be onboarded (invited by phone/OTP in a later milestone) without compromising the identity model.
