# Blueprint v3 — Parts 7–13: Authorization, Service Engine, Tickets, AI, Audit, Files, Notifications

> **v3.1:** Part 7 is refined and superseded in detail by `06-authorization-model-final.md` (authorization path, resolvers, grant rules, minors); Part 10's boundary rules are extended there (§8) and tested per `09` §7; tenant propagation for jobs/cache/search is in `05`. Notification channels for the pilot are in-app, push (M2) and email; SMS/WhatsApp are future providers. Face/biometric items below refer to an optional future module only (ADR-016).

---

## PART 7 — AUTHORIZATION MODEL

### 7.1 What we need

| Component | Needed? | Form |
|---|---|---|
| Roles | Yes | Data (`roles`); system roles seeded, custom roles schema-ready |
| Permissions | Yes | Catalog **defined in code** (`module.resource.action`), seeded to `permissions` |
| Role → permission | Yes | `role_permissions` with a **`scope_mode`** |
| Role assignments | Yes | `role_assignments` (user, role, **scope_type + scope id**, validity dates) |
| Tenant scope | Implicit | From session + RLS. Not a table, not an assignment |
| Campus scope | Yes | `scope_type = CAMPUS` on assignments |
| Department scope | Yes | `scope_type = DEPARTMENT` on assignments |
| Resource scopes (course, section, student) | **No table** | Derived at check time from relationship data: `faculty_assignments`, `section_memberships`, `student_guardians`, ownership columns |
| Deny rules | No | Additive only; simpler to reason about and audit |

### 7.2 Permission naming

`<module>.<resource>.<action>` — e.g. `attendance.session.mark`, `attendance.record.read`, `attendance.record.correct`, `student.profile.read`, `student.profile.read_sensitive`, `request.step.approve`, `ticket.message.add_internal`. Sensitivity tier (NORMAL / SENSITIVE / CRITICAL) is a catalog attribute; CRITICAL permissions require a reason on use and always emit audit.

### 7.3 Scope modes (the key idea)

Each `role_permissions` row states *how* the permission is scoped:

| scope_mode | Meaning | Resolved from |
|---|---|---|
| **SELF** | Only the actor's own data | `resource.student_id == actor.student_id` (or guardian link with `can_view_academics`) |
| **ASSIGNED** | Only resources the actor is assigned to *on the relevant date* | `faculty_assignments` (offering/section), queue membership, request step assignee |
| **GRANTED** | Anything inside the scope of one of the actor's role assignments | `role_assignments.scope_type/scope_id` ∩ resource's `campus_id` / `department_id` / org |

Examples:

| Role | Permission | scope_mode | Effective access |
|---|---|---|---|
| STUDENT | `attendance.record.read` | SELF | Own attendance |
| FACULTY | `attendance.session.mark` | ASSIGNED | Sessions of offerings where they hold a valid assignment on `session_date` |
| FACULTY | `attendance.record.read` | ASSIGNED | Same offerings |
| HOD | `attendance.record.read` | GRANTED | Everything in the department of their DEPARTMENT-scoped assignment |
| CAMPUS_ADMIN | `attendance.record.read` | GRANTED | Their campus |
| COLLEGE_ADMIN | `attendance.record.read` | GRANTED | ORGANIZATION-scoped assignment → entire college |
| STUDENT | `request.create` | SELF | Create for self |
| REGISTRAR | `student.profile.read` | GRANTED | Organization scope |

### 7.4 System roles (seed)

STUDENT, GUARDIAN (schema-ready), FACULTY, STAFF, HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR, EXAM_CONTROLLER, FINANCE_OFFICER, SUPPORT_AGENT, PLACEMENT/LIBRARIAN (later). Platform admin is **not** a tenant role.

Implicit role assignment: creating a `students` row grants STUDENT (ORGANIZATION scope but SELF mode); creating an `employees` row of type FACULTY grants FACULTY. Position-based roles (HOD, admin) are explicit, dated assignments.

### 7.5 Evaluation algorithm

```
can(actor, permission, resource?) :
  1. actor.session valid; actor.org == resource.org (also guaranteed by RLS)
  2. grants = effectiveGrants(actor)   -- cached per (user_id, authz_version): [(permission, scope_mode, scope?)]
  3. for each grant matching permission:
       SELF     -> resource.student_id == actor.student_id  (or guardian link)
       ASSIGNED -> exists valid assignment/queue/step linking actor to resource at resource date
       GRANTED  -> resource.{campus,department} within grant.scope
     any match => ALLOW
  4. else DENY (return 404 for existence-sensitive resources, 403 otherwise)
```

- **Lists** use `scopeFilter(actor, permission)` which returns a repository predicate (own student_id, assigned offering ids, department ids, campus ids). Authorization is applied in the query, not after fetching.
- **Cache**: Redis key `authz:{user_id}:{authz_version}`; any role/assignment change bumps `users.authz_version` (and invalidates). Assignments with `valid_to` are resolved by date at read time; a nightly job expires them and bumps versions.
- **Token**: JWT contains only `sub, org, sid, authz_ver, exp`. If `authz_ver` in the token is older than the DB, the API simply recomputes — no forced logout needed.
- **Sensitive fields**: `student.profile.read` returns a basic DTO; `student.profile.read_sensitive` adds guardian contacts, address, ID documents, medical.
- **Temporary delegation**: new dated `role_assignments` with `grant_reason`; auto-expire.
- **Elevated actions**: CRITICAL permissions (term lock override, mark edit after lock, role grant) require `reason` and optionally a second approver (`request_approvals` pattern).
- **Platform support access**: separate realm; time-boxed, tenant-approved, audited as `PLATFORM_SUPPORT`.
- **AI**: effective grants = user's grants ∩ tool's declared permission, with scope_mode forced to SELF for the student assistant (Part 10).

### 7.6 Technical placement

`PolicyEngine` in the shared kernel; each module registers `permission → scope resolvers` (e.g. attendance registers how to find the offering for a session). Routes declare `requires('attendance.session.mark')`; services call `policy.assert(actor, perm, resource)` for object-level checks. Both are required — route-level only is insufficient (IDOR).

---

## PART 8 — SERVICE REQUEST ENGINE

### 8.1 Where to draw the line

Admins configure: **forms, approval steps, who approves, SLAs, notifications, document templates, eligibility.**
Developers write: **new side-effects** ("fulfilment actions") such as *generate bonafide PDF*, *apply attendance correction*, *issue ID card record*. Actions are a small registry of audited, idempotent functions. This gives a new service without code in 90% of cases and avoids building a generic workflow/BPMN platform.

**Out of scope on purpose**: loops, parallel branches, scripting, arbitrary expressions, cross-request orchestration. If a service needs those, it becomes a coded module that still uses the same `service_requests` envelope.

### 8.2 Model

| Concept | Entity | Notes |
|---|---|---|
| ServiceType | `service_types` | Stable identity (code, audience, active) |
| Definition | `service_type_versions` | **Immutable once published.** Holds `form_schema`, `eligibility`, SLA, `fulfilment_action`, document template |
| Workflow / WorkflowStep | `workflow_steps` | Linear ordered steps; optional `condition` to skip a step (simple field comparison) |
| Request | `service_requests` | Pins `version_id` at submission; edits to the service never alter in-flight requests |
| RequestField | `form_schema` (definition) + `form_data` JSONB (values) | A separate row-per-field table is rejected: more joins, no benefit until reporting demands it. Fields flagged `report: true` can later be promoted to columns/generated indexes. |
| Assignment | `request_step_instances` (+ `assignment_basis` JSON explaining why this user) | Assignee resolved when the step activates |
| Approval | `request_approvals` | Append-only decisions |
| Status | `service_requests.status`, `request_step_instances.status` | State machine below |
| SLA | `sla_timers` (kind STEP) | Shared with tickets |
| Notification | Domain events to the outbox (`request.submitted`, `request.step_assigned`, …) | Templates per event |
| Audit | `audit_events` + `request_events` timeline | |

### 8.3 Form schema (admin-configurable)

Supported field types (closed set): text, textarea, number, date, select, multiselect, checkbox, file, student-course-picker, session-picker (for attendance correction), read-only info text. Per field: key, label, required, validation (min/max/regex), help text, visibility (`requester`/`staff`), `report` flag. Validated server-side with a schema compiled to Zod at publish time. The admin UI is a form builder that writes this JSON.

### 8.4 Step assignment kinds

| assignee_kind | Example |
|---|---|
| `ROLE_IN_SCOPE` | role HOD within the *student's department* |
| `RELATION` | `STUDENT_HOD`, `COURSE_FACULTY`, `SESSION_FACULTY` (faculty of the disputed session), `CLASS_COORDINATOR` — resolved by registered resolvers |
| `USER` | A specific person (e.g., Registrar) |
| `QUEUE` | A `work_queue`; any member may claim |

If a relation resolves to nobody, the step falls back to the configured queue or the department admin and logs the reason in `assignment_basis`.

### 8.5 Lifecycle

```
DRAFT → SUBMITTED → IN_PROGRESS ─┬→ APPROVED → FULFILLED   (fulfilment action ran successfully)
                                 ├→ REJECTED
                                 └→ RETURNED → (requester edits) → IN_PROGRESS
any non-final → CANCELLED (requester, until first approval) | EXPIRED (no response by requester after return)
```
Step: WAITING → ACTIVE → APPROVED/REJECTED/RETURNED/SKIPPED. A returned step creates a new `attempt`.

### 8.6 Fulfilment actions (registry)

| Action code | Effect | Idempotency |
|---|---|---|
| `DOCUMENT_GENERATE` | Render template → `generated_documents` + `files` | by request id |
| `ATTENDANCE_APPLY_CORRECTION` | Calls attendance service to create a revision linked to the request | by (request id, record id) |
| `RECORD_ONLY` | Mark request fulfilled; no side-effect (ID card issued manually) | — |
| `WEBHOOK` *(later)* | POST to an integration | by request id |

Actions run in a worker with retries; failure leaves the request in APPROVED with a visible "fulfilment failed" state and an alert — it never silently pretends to be done.

### 8.7 Admin configuration path (eventual)

Admin → Services → New service → form builder → add steps (pick assignee kind) → set SLA → pick fulfilment action/template → **Preview** (test submission) → **Publish** (creates a new immutable version). Old in-flight requests continue on their pinned version. MVP ships with seeded types (BONAFIDE, ID_CARD, ATTENDANCE_CORRECTION, GENERAL) editable via JSON/admin form; the visual builder is Milestone-5b.

### 8.8 Numbering and idempotency

`ref_no = SR-{yy}-{seq:06}` from `number_sequences` (per org per year). `Idempotency-Key` prevents duplicate submissions (also used by the AI path).

---

## PART 9 — TICKETING

### 9.1 Tickets vs service requests

| | Service request | Ticket |
|---|---|---|
| Nature | Formal request for a specific outcome ("issue me X") | Problem, question, complaint |
| Input | Structured form per type | Free text + attachments |
| Flow | Predefined approval steps | Conversation + assignment |
| Result | Decision + often an artifact | Resolution + feedback |
| Who acts | Approvers by step | Agents from a queue |
| Closure | Terminal outcome | Resolved → Closed; can reopen |

They share **infrastructure**, not tables: `work_queues` (inboxes), `sla_policies/sla_timers`, `files/file_links`, outbox events, `audit_events`, assignment/auto-assign logic, and the policy engine. They link: a ticket may `linked_request_id` ("my bonafide is stuck"), and rejected requests can be disputed by opening a ticket pre-filled from the request.

### 9.2 Model summary

- `tickets` — `kind`: STUDENT (requester is a student), DEPARTMENT (requester acts for a department: `requester_department_id`), INTERNAL (staff-to-staff, e.g., IT/maintenance). `about_student_id` when a staff member raises a ticket about a student.
- `ticket_messages` — append-only; `visibility` PUBLIC (requester sees) vs INTERNAL (agents only); attachments via `file_links` with the same visibility.
- `ticket_assignments` — history of assignee/queue changes with reason.
- `ticket_participants` — watchers/CC.
- `ticket_categories` — routing: default queue, default priority, SLA policy, audience.
- `escalation_rules` + `ticket_escalations`.
- `ticket_feedback`.

### 9.3 Behaviour

- **Create** → category determines queue → queue auto-assign (`ROUND_ROBIN` / `LEAST_LOAD` / `NONE`) → SLA timers start (first response, resolution).
- **Response SLA** stops when an agent posts a PUBLIC message. **Resolution SLA** pauses in `PENDING_REQUESTER` / `ON_HOLD`.
- **Escalation**: poller finds breached/near-breach timers → applies matching `escalation_rules` (reassign to queue, notify HOD/admin, raise priority) → records `ticket_escalations`. Reopen count threshold flags for manager review.
- **Resolution**: agent sets `resolution_code` + summary; status RESOLVED; requester notified; auto-close after N days of silence.
- **Reopening**: requester may reopen until `reopen_allowed_until` (default 7 days after resolution): status → IN_PROGRESS, `reopen_count++`, SLA resolution timer restarts. After the window, a new ticket is created with `parent_ticket_id`.
- **Feedback**: after CLOSED, one rating per ticket; attributed to the resolver at resolution time (stored via `resolved_by`).
- **Privacy**: INTERNAL notes never in requester APIs; AI tools can only read PUBLIC messages.

---

## PART 10 — AI DATA BOUNDARIES

### 10.1 Boundary

```
Student ─► Chat UI ─► AI Orchestrator (LLM + prompts, no DB access)
                         │ tool call (name + validated args)
                         ▼
                  Tool Gateway  ── resolves ActorContext from SESSION (never from model args)
                         │        ── checks tool allowlist for role, rate/budget limits
                         │        ── validates input (Zod), applies PolicyEngine (SELF scope)
                         ▼
                  Application services (same ones the REST API uses)
                         ▼
                  Business logic ─► Repositories ─► Postgres (RLS)
```

Rules:
1. **The model never supplies identity.** No tool accepts `student_id`, `user_id`, `organization_id`. Context is injected by the gateway from the authenticated session.
2. **Tools are an allowlist registry**, each wrapping one application-service method with an explicit output DTO designed for the LLM (minimal fields, no internal IDs unless needed for follow-up, no staff-only data).
3. **Two-phase writes.** Write tools are split into `prepare_*` (validates, returns a proposal and a confirmation token bound to the payload hash) and `submit_*` (executes only when the **UI** sends the user's confirm action referencing that token). The model cannot confirm on the user's behalf.
4. **Tool output is untrusted data** (prompt-injection risk from ticket text, policy docs). Wrapped as data; instructions in it are ignored; a write tool cannot be called in the same turn as untrusted free text without fresh user confirmation.
5. **No direct SQL, no list-all tools, no search over people.** There is no `get_all_students` or `search_students` in the student assistant registry — such tools do not exist.
6. **Audit**: every tool call records `ai_tool_calls` (tool, args hash/redacted args, outcome, conversation id) and writes `audit_events` with `actor_type = AI`, `on_behalf_of_user_id = student's user`.
7. **Limits**: per-user rate limit, per-conversation tool-call cap, daily token budget per org, 30-minute idle expiry; refusal path hands off to `escalate_to_human`.
8. **RAG**: `kb_documents` carry `organization_id` and `audience` (STUDENT/STAFF/ALL); retrieval filters by org + audience **before** ranking; no student data is embedded.
9. **Provider**: no training on data; DPA in place; PII minimized in prompts (first name only; no phone/email).
10. **Role split**: Student assistant (Phase 1 of AI) = SELF scope only. Faculty/HOD assistants are separate registries added later with ASSIGNED/GRANTED scope and their own risk review.

Risk levels: **L0** public info · **L1** own non-sensitive read · **L2** own sensitive read (results, fees, documents) · **L3** own reversible write (draft/submit request, ticket message) · **L4** staff scoped read · **L5** staff write / irreversible.

### 10.2 First 24 tools (student assistant registry)

All require: authenticated student session + `assistant.use` permission. "Scope" is always the caller's own data unless noted. Audit column: **Log** = `ai_tool_calls` + standard audit; **Log+** = also stores confirmation event.

| # | Tool | Purpose | Input | Output | R/W | Scope | Audit | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | `search_policies` | Answer from college policy/FAQ docs | `query` | top-k passages + doc titles | R | org docs, audience STUDENT/ALL | Log | L0 |
| 2 | `get_academic_calendar` | Dates, holidays, exam windows | `from?`, `to?` | events | R | campus calendar | Log | L0 |
| 3 | `get_my_profile_summary` | Name, program, cohort, semester, section | — | summary | R | SELF | Log | L1 |
| 4 | `get_my_courses` | Current registered courses + faculty | `term?` | list | R | SELF | Log | L1 |
| 5 | `get_my_timetable` | Today/this week schedule | `range: today|week` | slots | R | SELF | Log | L1 |
| 6 | `get_my_attendance_summary` | Overall + per-course % | `term?` | list with % and threshold | R | SELF | Log | L1 |
| 7 | `get_my_attendance_by_course` | Session-wise history | `course_ref`, `range?` | sessions + status | R | SELF | Log | L1 |
| 8 | `calculate_attendance_target` | Classes needed to reach threshold | `course_ref`, `target%?` | computed number | R | SELF | Log | L1 |
| 9 | `list_service_types` | Services available to me | `query?` | codes + names | R | audience filter | Log | L0 |
| 10 | `get_service_type_details` | Fields, steps, SLA of a service | `service_code` | form fields summary, SLA | R | published version | Log | L0 |
| 11 | `prepare_service_request` | Validate draft and show summary | `service_code`, `fields` | proposal + `confirm_token` | R (draft) | SELF | Log | L2 |
| 12 | `submit_service_request` | Submit after user confirmation | `confirm_token` | ref_no + status | **W** | SELF | **Log+** | L3 |
| 13 | `get_my_requests` | List my requests | `status?` | list | R | SELF | Log | L1 |
| 14 | `get_request_status` | Detail + visible timeline (no staff notes) | `ref_no` | status, current step, ETA | R | own request | Log | L1 |
| 15 | `cancel_my_request` | Cancel before first approval | `ref_no` (+ confirm) | result | **W** | own request | **Log+** | L3 |
| 16 | `get_my_tickets` | List tickets | `status?` | list | R | SELF | Log | L1 |
| 17 | `get_ticket_thread` | PUBLIC messages only | `ticket_no` | messages | R | own ticket | Log | L1 |
| 18 | `prepare_ticket` | Draft a ticket and summary | `category`, `subject`, `description` | proposal + token | R (draft) | SELF | Log | L2 |
| 19 | `submit_ticket` | Create after confirmation | `confirm_token` | ticket_no | **W** | SELF | **Log+** | L3 |
| 20 | `add_ticket_message` | Add reply (after confirmation) | `ticket_no`, `body`, `confirm_token` | ok | **W** | own ticket | **Log+** | L3 |
| 21 | `escalate_to_human` | Open ticket with conversation summary | `reason` | ticket_no | **W** | SELF | **Log+** | L3 |
| 22 | `get_my_notifications` | Recent notifications | `unread_only?` | list | R | SELF | Log | L1 |
| 23 | `get_my_documents` | List issued documents and status | `type?` | list (no URLs) | R | SELF | Log | L2 |
| 24 | `get_document_download_link` | Short-lived link to a document | `document_id` | signed URL (≤5 min) | R | own docs | Log | L2 |

Added when their modules ship: `get_my_exam_schedule` (L1), `get_my_results` (L2), `get_my_fee_dues` (L2), `get_my_fee_receipts` (L2).
Not in the student registry, ever: any tool that takes a student identifier, lists people, reads internal notes, marks attendance, edits marks, or changes roles.

---

## PART 11 — AUDIT SYSTEM

### 11.1 Design

One central, append-only `audit_events` table (monthly partitions), written by a single `audit.record(ctx, event)` call inside the **same transaction** as the business change for every MUST-audit operation. Low-value or read-access events may be queued asynchronously (explicit exception, not default).

| Question | Field(s) |
|---|---|
| Who | `actor_type`, `actor_user_id`, `on_behalf_of_user_id` (AI, impersonation), `session_id` |
| What | `action` (e.g. `attendance.record.correct`), `resource_type`, `resource_id`, `subject_student_id` |
| When | `occurred_at` (server clock) |
| From where | `ip`, `user_agent`, `request_id` (correlates with logs/traces) |
| What changed | `changes` JSONB field-level diff `{field:{old,new}}`; sensitive values masked |
| Old / new | inside `changes` (full-snapshot for create/delete) |
| Why | `reason_code` (enumerated) + `reason_text`; linked `service_request_id` in `metadata` when an approval authorized it |
| Scope | `campus_id`, `department_id` (so audit viewers are scoped like everyone else) |
| Weight | `risk_tier` 1–3 (3 = exceptional: needs review) |

### 11.2 Protections

- App DB role has `INSERT, SELECT` only on `audit_events`; trigger rejects UPDATE/DELETE; partition detach/archival performed by a separate maintenance role.
- Daily job exports the previous day's partition digest (hash) to object storage (tamper evidence now; full hash-chaining later if a customer requires it).
- Retention 7 years (configurable per org, never below statutory); older than 1 year moved to compressed cold storage via partition detach.
- Access to the audit log is itself a permission (`audit.event.read`), scoped by campus/department, and reading it for a specific student is audited (`audit.read`).

### 11.3 MUST-audit operations

| Domain | Operation | Tier | Reason required |
|---|---|---|---|
| Attendance | Submit session attendance; **any modification after submission**; bulk import; lock/unlock | 1 / **2** / 2 / 3 | Modification: yes |
| Marks | Enter; **change**; publish; unlock after lock | 1 / **2** / 2 / 3 | Change/unlock: yes |
| Results | Publish; supersede (revaluation); withhold | 3 | Yes |
| Fees | Invoice create/void; payment recorded/reversed; waiver/scholarship award; refund | 3 | Yes (void, waiver, refund) |
| Approvals | Every approve/reject/return/delegate | 2 | Reject/return: comment |
| Users & roles | Create/invite; email/phone/status change; role assignment/revocation; password reset by admin; session revoke | 2–3 | Role changes: yes |
| Student data | Create; admission/registration number correction; status change; program transfer; section change; guardian change; merge | 2–3 | Yes for corrections/merge |
| Terms | Activate; close; lock; unlock override | 3 | Yes |
| AI | Every tool call (`actor_type=AI`); write confirmations | 1–2 | n/a |
| Service requests | Submit, assign, step decision, cancel, fulfilment success/failure, config publish | 1–2 | Cancel/reject: comment |
| Tickets | Create, assign, escalate, resolve, reopen, internal-note redaction | 1 | Redaction: yes |
| Files | Upload of sensitive class; **read of sensitive files**; delete/purge; legal-hold changes | 2 | Delete: yes |
| Biometric modules *(only if ever built; ADR-016)* | Consent grant/withdraw; enrol; revoke; template deletion; recognition log access | 3 | n/a |
| Security | Login success/failure/lockout, MFA events, token reuse detected, permission denied on CRITICAL | 1–3 | n/a |
| Platform | Support access grants, impersonation, tenant suspension, config flag changes | 3 | Yes |

---

## PART 12 — FILE / DOCUMENT ARCHITECTURE

### 12.1 Storage strategy

- Object storage via one S3 client; endpoint decides R2 / MinIO / S3. Buckets by **storage class**: `general` (ticket/request attachments, avatars), `sensitive` (ID documents, student certificates), `generated` (system-produced PDFs). Separate credentials and encryption keys per bucket; `sensitive` has the tightest IAM.
- Metadata lives in `files` + `file_links` (Part 4.11). The bucket holds bytes only.
- Sources: student documents, ID proofs, assignment files (post-pilot), exam documents, ticket/request attachments, generated certificates.

### 12.2 Key naming

`{organization_id}/{storage_class}/{yyyy}/{file_id}` — opaque; **no filename, student name, admission number or other PII in keys**. Original filename kept only in `files.original_name` and used in `Content-Disposition` at download.

### 12.3 Upload flow

1. Client asks `POST /documents/uploads` with declared name, size, mime, intended link (entity + purpose).
2. API authorizes ("may this actor attach a file to that entity?"), enforces size/type allowlist for that purpose, creates `files(status=PENDING_UPLOAD)`, returns a presigned PUT to a **quarantine prefix** (size and content-type conditions baked in).
3. Client uploads directly; calls `POST /documents/uploads/{id}/complete`.
4. Worker: verifies size/hash, sniffs real MIME (magic bytes), runs **ClamAV** (container in self-host; same in cloud), strips image EXIF, checks PDFs for active content; moves object to final prefix; sets `AVAILABLE` (or `QUARANTINED` + alert).
5. `file_links` created; file is invisible to everyone but the uploader until AVAILABLE.
Small files (<5 MB) may be proxied through the API with the same pipeline.

### 12.4 Access control and signed URLs

- A file has no ACL of its own: **access derives from its links**. To read file F the actor must be allowed to read at least one linked entity under the link's `visibility` (e.g. ticket PUBLIC attachment → ticket participants; STAFF_ONLY → agents). Orphan files are readable only by uploader/admin.
- Endpoint returns a **presigned GET** (default 60–300 s; max 15 min) with `response-content-disposition` and `response-content-type` fixed; never a permanent URL. Downloading `RESTRICTED` class files writes an audit event (`file.read`).
- Generated certificates additionally have a public **verification endpoint** (`/verify/{code}`) returning validity and issued-to initials only — not the document.

### 12.5 Metadata (what we store)

Declared + detected MIME, size, SHA-256, classification (INTERNAL / CONFIDENTIAL / RESTRICTED), uploader, scan result/time, retention date, legal-hold flag, status, timestamps, links. Virus-scan verdict and detected-type mismatch are first-class statuses.

### 12.6 Retention and deletion

| Class | Default retention | Deletion |
|---|---|---|
| Ticket/request attachments | 2 years after closure | soft-delete → purge after grace |
| Student identity documents | duration of enrolment + legal period (org-configurable, typically 7 y) | purge on expiry unless legal hold |
| Generated certificates | Retain record + file for life of the student record (re-issuable) | revoke (`generated_documents.revoked_at`), never silent delete |
| Avatars | until replaced | purge old |

Delete = `status DELETED` (invisible) → purge job after grace period removes the object and sets `PURGED`; blocked while `legal_hold`. Backups retain purged data until rotation — documented in the privacy notice.

### 12.7 Tenant isolation

Prefix includes `organization_id`; API verifies `files.organization_id = actor.org` (RLS); cloud IAM policies can be limited per prefix; enterprise/self-host option: bucket-per-org. Presigned URLs are generated only after the application check, so guessing keys is useless.

---

## PART 13 — NOTIFICATION ARCHITECTURE

### 13.1 Decoupling

```
Module (attendance, requests, tickets…)
   └─ emits DOMAIN EVENT in the same tx → outbox_events  (IDs only; no recipients, no text)
Outbox relay (worker) → Event bus (in-process now, Redis/BullMQ queue)
Notification module subscribes by event_type:
   1. Notification rule (code registry): audience resolver + category + default channels + mandatory flag
   2. Resolve recipients (from IDs; applies policy so only permitted users are notified)
   3. Render NotificationTemplate (org override → system default; locale; versioned)
   4. Check NotificationPreference + consent (SMS/WhatsApp require consent) + quiet hours
   5. Create `notifications` (in-app) and `notification_deliveries` rows per channel
   6. Channel workers send via ChannelProvider interface; update delivery status
```

Modules never import a provider, never know about channels, and never build message text. Adding a channel = a provider class + templates + preference row; no module changes.

### 13.2 Entities

| Entity | Purpose | Key fields |
|---|---|---|
| **NotificationEvent** (`outbox_events` + code catalog) | What happened | event_type, aggregate, payload IDs, occurred_at, dedup_key. Catalog in code: category, audience resolver, mandatory?, default channels |
| **NotificationTemplate** | Content per event/channel/locale | org_id? (null = system), event_type, channel, locale, subject?, body (with whitelisted variables), version, status |
| **Notification** | In-app inbox item | recipient_user_id, category, title, body, action_url, entity ref, read_at, created_at (hard-delete after 180 d) |
| **NotificationDelivery** | One attempt stream per channel | notification_id, channel, provider, status [QUEUED|SENT|DELIVERED|FAILED|SUPPRESSED], attempts, provider_message_id, error_code, timestamps; `SUPPRESSED` records why (preference, no consent, quiet hours) |
| **NotificationPreference** | User choices | (user, category, channel, enabled). Mandatory categories (security, request decisions) cannot be disabled for in-app/email |
| **PushSubscription** | Web-push/device tokens | user, endpoint/token, keys, UA, last_used_at, revoked_at |

### 13.3 Channels

| Channel | Provider interface | Notes |
|---|---|---|
| In-app | built-in — **pilot channel** | Primary; also drives unread badge |
| Email | `EmailProvider` (SMTP) — **pilot channel** | Bounce/complaint handling suppresses address |
| Web push / mobile push | `PushProvider` (Web Push now, M2; FCM/APNs later) — **pilot channel** | iOS PWA limits → fallback to in-app + email |
| SMS | `SmsProvider` — *future provider, interface only* | India: DLT-registered templates; consent + cost caps; critical alerts only |
| WhatsApp | `WhatsAppProvider` — *future provider, interface only* | Pre-approved templates, explicit opt-in |

### 13.4 Reliability

At-least-once delivery with dedup keys; per-channel retry with backoff and dead-letter; outbox relay is idempotent; delivery status is queryable for support ("did the student get it?"). In-app notification is created even if external channels fail.

### 13.5 Examples of events (initial catalog)

`attendance.session_submitted`, `attendance.low`, `attendance.record_corrected`, `request.submitted`, `request.step_assigned`, `request.returned`, `request.decided`, `request.fulfilled`, `request.sla_breached`, `ticket.created`, `ticket.assigned`, `ticket.message_added`, `ticket.resolved`, `ticket.escalated`, `account.invited`, `account.password_reset`, `security.new_login`, `consent.changed`.
