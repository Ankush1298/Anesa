Smart Campus OS — Security Architecture
Pre-implementation design for review. No application code. Not legal advice.
0. Scope, assumptions and how to read this
• This is a design-stage document. Scores in §23 rate the proposed design on paper; nothing here is verified until the tests in §21 exist and pass.
• Assumed reference stack (swap freely, the principles hold): PostgreSQL as primary store, S3-compatible private object storage, Redis-class cache and queue, a search engine (Postgres FTS first, OpenSearch later), an LLM provider behind our own gateway, and a web + mobile client.
• Global rules: deny by default, server is the only authority, every layer assumes the layer above it failed.
• Terminology: tenant = a college/organization that bought the product. Scope = a node in the tenant's org tree (campus, department, program, section). Principal = an authenticated human or service identity.
1. Security Architecture
1.1 Layered request path
Client (untrusted)
  -> Edge: TLS, WAF, bot/rate limits, request size limits
  -> API layer: authentication, builds immutable RequestContext
  -> Policy Enforcement Point: calls the single Policy Decision module
  -> Service layer: business rules, state machines, DTO projection
  -> Tenant-scoped repository (only door to the database)
  -> Database: Row-Level Security, composite FKs, constraints
  -> Audit stream (append-only) + detection
1.2 The RequestContext (the root of trust)
Built once per request, server-side, from the verified session, then frozen:
• tenant_id, principal_id, session_id, auth_strength (password / MFA / step-up), request_id, ip/device fingerprint.
• Roles and scope grants are loaded server-side (short-lived cache keyed by a permission-version counter), never read from client input or trusted from token claims alone.
• Every service and repository method takes the RequestContext as a mandatory first parameter. No context, no call. There is no "global" tenant variable.
1.3 Defense-in-depth control layers
Layer
Control
Stops
L1 Edge
WAF, rate limits, size limits, TLS 1.2+
Floods, malformed input, scraping
L2 Authn
Strong sessions, MFA, revocation
Stolen/guessed credentials
L3 Authz
Central policy: permission + scope + relationship
IDOR/BOLA, privilege escalation
L4 Repository
Tenant-scoped data access only, no raw SQL outside
A developer forgetting a filter
L5 Database
RLS, restricted roles, composite FKs
Cross-tenant reads/writes even with buggy app code
L6 Data
Field/envelope encryption, DTO projection
Over-exposure, DB-level snooping
L7 Detect
Audit, anomaly alerts, canaries
Slow/quiet abuse
L8 Verify
Continuous isolation tests in CI, pen tests
Regressions
1.4 Architectural rules (enforced by code review + CI lint)
1. One authorization module. Controllers/handlers never implement their own checks.
2. One database access path (tenant-scoped repositories). Raw SQL, ORMs used directly in handlers, and ad-hoc reporting connections are banned in application code.
3. Handlers return DTOs, never ORM entities.
4. Anything asynchronous (jobs, webhooks, AI tools, exports) re-establishes a RequestContext; it never inherits ambient state.
5. Security-relevant config (CORS, headers, cookie flags, role definitions) lives in versioned, reviewed code/config, not in dashboards.
2. Threat Model
2.1 Assets (ranked)
1. Student PII and academic records (identity documents, results, attendance, fees, disciplinary or medical-adjacent notes).
2. Tenant isolation guarantee itself (a single cross-tenant leak is existential for a SaaS).
3. Credentials, sessions, signing keys, KMS keys.
4. Financial records (fees, payment references).
5. Integrity of grades/attendance/fees (tampering is as damaging as leaking).
6. Availability during exam/result/fee windows.
2.2 Actors
Curious or malicious student; student with a stolen/shared device; faculty overreaching or compromised; staff with legitimate but over-broad access; compromised admin; external attacker (credential stuffing, phishing, API fuzzing); malicious tenant admin probing neighbors; our own developers/support (mistakes or insider risk); a prompt-injected AI agent; a vendor/integration compromise.
2.3 Trust boundaries
Browser/app ↔ edge; edge ↔ API; API ↔ database; API ↔ object storage; API ↔ queue/workers; API ↔ LLM provider; our platform ↔ tenant IdP (SSO); our platform ↔ SMS/email/WhatsApp providers; support staff ↔ production.
2.4 The 15 required failure scenarios
#
Attack
Impact
Prevention
Detection
Recovery
Automated test
1
Student edits a student ID in a request
Read/write another student's data
Self-service endpoints take no student ID (/me/...); ID-bearing endpoints run relationship check; RLS second layer
Spike of 403/404 on resource-ID routes per principal; denial audit
Revoke session, review audit trail, notify affected parties if any success
For every route with an ID: Student A calls with Student B's ID, expect uniform denial
2
Student guesses another student's UUID
Same as #1
UUIDs are non-guessable but never authorization; same checks as #1
Same; many distinct unknown IDs from one principal = enumeration alert
Same
Random and real foreign UUIDs return identical responses (no existence oracle)
3
Faculty modifies attendance for a class they don't teach
Integrity loss, academic fraud
Check teaching-assignment relationship for that section and date window; maker-checker for edits after lock
Audit diff on attendance changes; alert on edits outside assigned sections
Restore from audit before-state; investigate
Faculty A vs Faculty B's section: all write/read paths denied
4
Admin accesses another tenant
Catastrophic cross-tenant breach
Tenant derived from session only; RLS with fail-closed default; no tenant parameter accepted from client
Any query returning rows with foreign tenant = impossible by RLS; alert on RLS-denied writes
Incident response, tenant notification, key rotation if needed
Matrix test: every endpoint × every role in Tenant A against Tenant B resources
5
AI tries to fetch another student's records
PII exfiltration
AI has no DB access; tools are thin, run with the user's RequestContext, accept no identity parameters
Tool-call audit; denied-tool-call alerts; output scanner
Disable tool, revoke session, review transcripts
Prompt-injection suite asking for other students/tenants; tools must be unable to comply
6
RAG returns another college's document
Policy/doc leakage
Hard metadata filter by tenant/campus/dept/role inside the vector query, plus post-retrieval re-authorization
Retrieval logs show source doc IDs; cross-scope retrieval alert
Purge index entries, rebuild affected index
Seed two tenants with canary documents; query as each; canaries never cross
7
Cached response served to wrong user
Silent data leak
Tenant + principal/scope + permission-version in every key; never cache personalized data in shared/CDN caches; Vary/private headers
Canary values; cache-key linting
Flush namespace, bump permission version
Two users, same route, alternating requests; assert no cross-contamination
8
Background job processes wrong tenant
Cross-tenant write/notification
Job payload carries tenant_id + principal + resource IDs; worker re-validates, sets RLS context per job; no "all tenants" jobs without explicit platform-scope marker
Job audit; mismatched-tenant rejection counter
Replay from DLQ after fix; compensating corrections
Enqueue a job with mismatched tenant/resource; worker must reject
9
Signed document URL leaked
Unauthorized download until expiry
Short TTL (60–120 s), single-purpose, bound to object key; re-authorization on every issue; optional IP/session binding; no URL in logs
Access log anomalies, repeated downloads
Rotate object key / invalidate, review access log
Expired URL fails; URL for doc A cannot fetch doc B; issuance denied to non-owner
10
Staff account compromised
Bulk access within that staff scope
MFA/passkeys mandatory, scoped grants, export limits, step-up for bulk actions, session binding
Impossible-travel, bulk-read anomaly, off-hours access
Kill all sessions, rotate credentials, forensic audit review
Simulated bulk scraping triggers rate limits and alerts
11
Session token stolen
Account takeover
httpOnly/Secure/SameSite cookies, short access lifetime, refresh rotation with reuse detection, device binding signals
Refresh-token reuse detection, new device/geo alerts
Revoke session family, force re-auth
Reusing a rotated refresh token kills the whole family
12
Malicious file uploaded
Malware, stored XSS, parser exploits
Allowlist types by content sniffing, size caps, quarantine bucket + AV scan, re-encode where possible, serve from separate domain with Content-Disposition: attachment
Scan results, unusual MIME mismatches
Delete object, block hash, notify uploader's admin
Upload EICAR, polyglots, SVG-with-script, oversized files
13
Privilege escalation
Gains admin powers
Role/grant changes need role.assign in scope ≥ target scope, cannot grant more than you hold, maker-checker for admin roles
Audit on all grant changes, alerts for new admins
Revoke grants, review changes since
Low-privilege principal attempts every grant/role endpoint
14
Concurrent updates overwrite data
Lost marks/attendance, double payment
Optimistic locking (version column), idempotency keys, unique constraints, state machines, transactions
Conflict (409) rates, reconciliation jobs
Replay from audit before/after states
Parallel update race tests
15
Developer omits tenant filter
Cross-tenant read
RLS makes the omitted filter harmless; repositories inject scope; CI catalog test fails any table lacking RLS; static analysis bans raw queries
RLS-violation counters, query-log scanning in staging
Hotfix, review blast radius via audit
"Forgot-filter" test: deliberately run unscoped query as app role, must return zero foreign rows
3. Multi-Tenant Isolation Strategy
3.1 Options compared
Option
Isolation strength
Ops cost
Scale limits
Fit
A. Shared DB, shared schema, tenant_id + RLS
Good if RLS + constraints enforced; shared blast radius
Lowest
Very high with partitioning/sharding
Early product
B. Shared DB, schema per tenant
Better separation, easy per-tenant dump/restore
Migrations multiply by tenants; catalog bloat past a few thousand
Medium
Mid-size / special tenants
C. Database (or cluster) per tenant
Strongest, easiest residency and per-tenant keys
Highest cost and ops overhead
Per-tenant fleet management
Large, regulated, or residency-bound tenants
3.2 Recommendation
Start with A (shared schema + tenant_id + Postgres RLS + composite foreign keys), built so a tenant can be promoted to B or C without application changes. Reasons: lowest cost, one migration path, and RLS gives a database-enforced backstop. Design for promotion from day one:
• All data access goes through a tenant router that resolves tenant_id → connection target (a shared cluster today; a dedicated database later).
• No cross-tenant joins or foreign keys, ever. Platform-level data (billing, tenant registry) is in a separate logical store.
• IDs are globally unique (UUIDv7/ULID), so rows can move between databases without collisions.
• Per-tenant encryption keys (see §17) so a tenant can be cryptographically separated.
• Tenant export/import tooling is a first-class feature, which also supports offboarding and data-residency requests.
3.3 Evolution path
1. Phase 1: one cluster, shared schema, RLS, hash-partitioned large tables.
2. Phase 2: premium/regulated tenants move to dedicated databases (silo) behind the same router; the rest stay pooled.
3. Phase 3: cells: independent stacks (app + DB + cache + storage) each hosting a set of tenants, with regional placement. A failure or breach is contained to one cell.
3.4 Tenant context rules
• Tenant is derived from the authenticated session. A subdomain or header may be a hint; if it disagrees with the session, reject and audit.
• Never accept tenant_id in a request body, query string, or AI tool argument.
• Platform (vendor) staff are a separate identity realm with no implicit tenant access; access is break-glass (§6.4).
• Per-tenant quotas and rate limits to contain noisy-neighbor and abuse.
4. Student Data Isolation Strategy
4.1 Ownership chain
Every row has an explicit owner path, stored as columns (not inferred):
Student profile: Tenant -> Campus -> Student
Attendance:      Tenant -> Academic term -> Class section -> Enrollment(student) -> Attendance
Result:          Tenant -> Term -> Course offering -> Enrollment(student) -> Result
Fee:             Tenant -> Student -> Fee account -> Fee line / Payment
Document:        Tenant -> Student -> Document (+ classification)
Ticket:          Tenant -> Student(requester) -> Ticket -> Department(assignee)
Each row carries tenant_id and its direct owner FK (student_id or enrollment_id) with composite foreign keys (tenant_id, parent_id), so a child can never point at another tenant's parent.
4.2 Two kinds of endpoints
• Self endpoints: /me/attendance, /me/results. They take no student identifier. The student is derived from the session (principal -> student_id mapping stored server-side). IDOR is structurally impossible.
• Resource endpoints: /students/{id}/... for faculty/staff. These always run the full decision in §6.3. Students get no access to these routes at all, which is the strongest defense.
4.3 Student access matrix
Data
Student may
Student may not
Profile
Read own; edit a limited set (contact info, with verification)
Read others; edit academic/identity fields
Attendance, timetable, exams, results
Read own
Any other student; class-wide analytics beyond anonymized aggregates
Fees
Read own, pay own
Others' balances or receipts
Documents
Upload/read own
Others' documents; sensitive admin notes about self unless policy says so
Requests/tickets
Create and read own
Others', internal staff notes
Notifications
Own only
Others
4.4 Extra protections
• Second-layer RLS on highest-sensitivity tables (documents, fees, tickets): a policy that, when the session role is student, additionally requires student_id = current student. The app bug and the missing filter both fail closed.
• No existence oracle: unauthorized and nonexistent resources return the same response and timing.
• Staff views of student data use purpose-limited projections (a faculty member sees roll number, name, section attendance; not ID documents).
• Guardian/parent access (if added later) is a separate principal type with explicit, consented, revocable relationships.
5. Authentication Architecture
5.1 Credentials
• Passwords hashed with Argon2id (tuned memory/time cost, unique salt, optional server-side pepper in KMS/HSM). Never stored or logged in plaintext; breached-password screening on set/change.
• Prefer passkeys (WebAuthn) as a first-class factor; TOTP as the baseline second factor. SMS/WhatsApp OTP only as a weak fallback, never for staff/admin, and with SIM-swap awareness.
• Per-tenant SSO (OIDC/SAML) for colleges with an IdP, with just-in-time provisioning restricted to the tenant's verified domains.
5.2 Sessions and tokens
• Web: server-recognized session in an HttpOnly; Secure; SameSite=Lax/Strict cookie, short idle timeout and an absolute lifetime. Anti-CSRF token required for state-changing requests.
• Mobile/API: short-lived access token (5–10 min) + rotating refresh token with reuse detection: reuse revokes the whole session family.
• Tokens carry only identity (principal_id, tenant_id, session_id, expiry). Permissions are not trusted from the token. They are resolved server-side and invalidated by a per-principal permission version.
• Server-side session store enables instant revocation (logout everywhere, role change, password reset, suspected compromise).
• Device/session management UI: list sessions, revoke any, notify on new device.
5.3 Account lifecycle
• Verification: email verification mandatory; phone verification before using phone-based features. Re-verify on change, and notify the old address/number when contact details change.
• Password reset: single-use, short-lived, hashed-at-rest tokens; neutral responses (no account enumeration); resets revoke all sessions and require re-MFA; admin-initiated reset for staff requires a second approver.
• MFA policy: mandatory for all staff/faculty/admins; strongly encouraged and risk-triggered for students. Step-up authentication for sensitive actions: grade changes, bulk export, role changes, fee adjustments, document downloads in bulk.
• Recovery: recovery codes + identity-verified admin-assisted recovery with audit trail.
5.4 Abuse protection
• Rate limits and progressive delays on login, reset, OTP, and MFA endpoints, keyed by account and IP and device; CAPTCHA only after risk triggers.
• Credential-stuffing defenses: breached-password check, velocity rules, anomaly scoring (new device, geo-velocity, impossible travel).
• Uniform error messages and timing for unknown vs wrong credentials.
• Service-to-service identities use short-lived workload credentials (mTLS or signed tokens), never human sessions.
6. Authorization Architecture
6.1 Model: scoped RBAC + relationship checks
Authn -> Principal -> Tenant -> Grants (Role + Scope node) -> Permissions
      -> Resource scope check -> Relationship check -> ALLOW / DENY (+ audit)
• Permission: resource.action (e.g., attendance.read, marks.write, fee.adjust).
• Role: a named bundle of permissions.
• Grant: (principal, role, scope_node); the scope is a node in the org tree: tenant › campus › department › program › section. A grant covers its node and descendants.
• Relationship edges: enrolled_in, teaches_section, advises, heads_department, owns (self). These cover cases roles can't express ("faculty only for their sections").
• Roles never mean "global". There is no unscoped admin.
6.2 Policy engine
A single in-process policy module for v1 (pure, side-effect-free, exhaustively unit-tested). Keep its interface compatible with a dedicated engine (OPA/Cedar/OpenFGA-style) if relationship graphs grow. Policies are code-reviewed, versioned, and every deny/allow can be explained with a reason code.
6.3 Decision algorithm (every request)
1. Session valid, not revoked, MFA/step-up level sufficient for this action?
2. Principal's tenant_id equals the resource's tenant_id? (Hard stop otherwise.)
3. Does the principal hold a permission for this action?
4. Does a grant's scope node contain the resource's scope (campus/department/section)?
5. If the policy is relationship-based, does the relationship edge exist and is it active (term dates, not revoked)?
6. Is the resource in an allowed state for this action (e.g., marks locked, attendance window closed)?
7. Are there separation-of-duties conflicts (creator ≠ approver)?
8. Allow, or deny with reason; write audit for sensitive actions and all denials on protected resources.
6.4 Role examples
Role
Example permissions
Scope
Relationship condition
Student
read own attendance/results/fees/docs, create tickets
self
principal == student
Faculty
attendance.read/write, marks.write (draft)
assigned sections
teaches_section active this term
HOD
read department attendance/marks summaries, approve marks
department
heads_department
Department Admin
manage dept timetable, sections, staff assignments
department
none beyond scope
Finance Staff
fee.read, fee.adjust (with approval)
campus/tenant
cannot read marks/docs
Exam Staff
exam.manage, result.publish (maker-checker)
tenant/campus
cannot adjust fees
College Admin
users, roles (bounded), configuration
tenant (or campus)
cannot exceed own granted permissions
Platform Super Admin (vendor)
operate platform, no tenant data by default
platform realm
break-glass, time-boxed, customer-approved, fully audited, read-only unless justified
Rules: a principal can grant only what they hold, within their own scope; admin roles require a second approver; permission changes are immediate (permission-version bump) and audited.
6.5 List and search queries
For lists, the authorization layer compiles the principal's grants/relationships into a scope filter applied inside the query (not post-filtering rows in memory), so pagination, counts and totals can't leak unauthorized rows.
7. Database Security
7.1 Defense stack
• Every tenant-owned table has tenant_id NOT NULL as the leading column of its primary/unique indexes.
• Row-Level Security enabled and forced on all such tables. The policy compares tenant_id to a transaction-local setting populated from the RequestContext. If the setting is absent the policy returns no rows (fail closed).
• The application connects as a non-owner, non-superuser role without BYPASSRLS. Migrations use a separate privileged role that the running app never holds.
• Composite foreign keys (tenant_id, id) everywhere: a row cannot reference another tenant's row.
• Composite unique constraints (tenant_id, natural_key) (e.g., roll number unique per tenant, not globally).
• Connection pooling: set tenant context per transaction and reset on release, so a pooled connection can never carry a previous tenant's context. Test explicitly under the pooler.
• Separate DB roles: app_runtime, app_worker, migrator, readonly_analytics (on a replica, RLS still enforced or tenant-scoped views), support_breakglass (time-boxed, audited, off by default).
• Column-level protection: highly sensitive fields (government ID numbers, medical-adjacent notes) use application-layer envelope encryption and restricted column privileges.
• Query guardrails: statement timeouts, row limits, no wildcard exports from the runtime role.
• pgaudit-style logging for DDL and privileged access; schema changes via reviewed migrations only.
7.2 Mechanisms that prevent accidental cross-tenant queries
1. Repositories require a RequestContext and inject tenant scope automatically.
2. RLS returns nothing if the app forgets context or sets the wrong one.
3. Composite FKs block cross-tenant references on write.
4. CI catalog test fails the build if any table with tenant_id lacks RLS enabled/forced and a policy, or any tenant table lacks the column.
5. Lint/static analysis rejects raw SQL and unscoped ORM access outside the repository package.
6. Staging runs a tenant-canary suite (known sentinel rows in two tenants) after every deploy.
7.3 Performance note
RLS cost is manageable with tenant_id-leading indexes and hash/range partitioning for big tables (attendance, notifications, audit). Benchmark policies early; avoid policies that call heavy functions per row.
8. API Security
8.1 Object-level authorization (IDOR/BOLA)
Vulnerable pattern: GET /students/{id}/attendance checks only "is logged in" or "has attendance.read" and returns the record for any {id}. Also vulnerable: trusting a studentId in a POST body; trusting tenantId from the client; checking permission type but not the specific resource; filtering results in the UI.
Secure pattern:
1. Authenticate, build RequestContext (tenant, principal) from the session.
2. Load the resource within the tenant scope (RLS + repository) so a foreign ID looks nonexistent.
3. Run the policy decision on this resource (scope + relationship + state).
4. Return a DTO. Deny uniformly (same status/body/timing for "not found" and "not yours").
5. Audit the decision when the resource is sensitive.
For writes: re-check on the current state inside the transaction (avoid TOCTOU), use optimistic locking, and never trust client-supplied ownership fields (they are ignored/overwritten server-side).
8.2 Controls checklist
Area
Design
Input validation
Schema validation at the edge of every handler: types, lengths, enums, allowlists; reject unknown fields (mass-assignment protection)
Output filtering
Explicit response DTOs/projections per role; sensitive fields opt-in, never opt-out
Authz middleware
Every route declares its required permission + resource policy; a route with no declaration fails the build/boot
Rate limiting
Per IP, per principal, per tenant, per route class (stricter on auth, exports, search, AI)
Size/complexity limits
Max body size, max page size (e.g., 100), max filters, query/expansion depth limits, export row caps with async + approval
Pagination
Cursor-based, opaque, signed cursors bound to principal and query
CORS
Strict allowlist of known origins, no wildcard with credentials
CSRF
Cookie sessions: SameSite + anti-CSRF token + Origin checks; bearer-token APIs are CSRF-immune by design
Secure headers
HSTS, CSP (no inline script), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame protections, Cache-Control: no-store on sensitive responses
Versioning
/v1/..., deprecation policy; old versions get the same security fixes or are retired
Errors
Generic client errors with request ID; no stack traces, SQL, or internal IDs; same shape for deny/not-found
Abuse detection
Enumeration detection, scraping heuristics, anomalous export/read volume, auto-throttle then alert
Frontend trust
Frontend authorization is UX only. Hide buttons for convenience, but every action is re-authorized server-side. The client only renders what the server already authorized and shaped, and keeps no secrets or permission truth in local storage
9. File Security
9.1 Flow
Authenticated request -> authorization on THIS document -> short-lived signed URL -> private object storage
• Buckets are private, block all public access, and are partitioned by tenant (tenant/{tenantId}/... prefix or per-tenant bucket for silo tenants). Object keys are random (not names or roll numbers).
• Upload: client asks the API for an upload grant (authorized, size/type-bound, single-use, short TTL) and uploads to a quarantine bucket. Nothing is readable by anyone until scanning and validation pass, then it is promoted to the main bucket.
• Download: API re-checks authorization, issues a signed URL valid for roughly 60–120 seconds, bound to one object, Content-Disposition: attachment, served from a separate cookieless domain so uploaded content can never run in the app's origin. Signed URLs are never logged, stored, or emailed.
• Validation: allowlist by detected content (magic bytes), not extension or client MIME; size caps per category; page/pixel limits; strip metadata (EXIF) from images; re-encode or flatten PDFs/images where practical; block executables, macros and active content; SVG disallowed or sanitized.
• Malware scanning: every upload scanned before release; failed files are deleted and the hash blocklisted; periodic rescans with updated signatures.
• Metadata lives in the database (owner, tenant, classification, checksum, scan status, retention class, uploader, timestamps), never in the object key.
• Encryption: server-side encryption with per-tenant keys (envelope, see §17). Optional client-supplied-key-style isolation for silo tenants.
• Retention: classification-driven retention and legal hold; deletion removes object, versions, derived thumbnails/text, and search/RAG entries.
• Access logging: every issue-and-download event is audited (actor, document, purpose, result). Bulk or unusual document access triggers alerts.
• Assignment and exam files follow the same pipeline but with time-window rules (e.g., exam paper unreadable before release time).
10. Cache Security
• Key design: v{schemaVersion}:t:{tenantId}:{scope}:{resource}:{id}:{variant} with scope being u:{principalId} for personalized data. Example: t:{tenantId}:s:{studentId}:attendance:{term}. Never a bare ID.
• Role/permission-dependent responses include a permission version in the key (pv:{n}) so a role change instantly makes old entries unreachable.
• Never cache authorization decisions beyond seconds, tokens, OTPs, signed URLs or raw documents. Cache data, and apply authorization before serving (a cache hit does not skip the policy check).
• Shared/CDN caching only for public content; every authenticated response sends Cache-Control: private, no-store unless explicitly classified safe, with correct Vary headers.
• Cache namespaces per tenant enable per-tenant flush; Redis ACLs/separate instances for sessions vs data; TLS and auth on the cache; no cache exposed outside the private network.
• Invalidation: write-through events invalidate by tenant+resource key; TTLs short for sensitive data; bulk invalidation via namespace/version bump; stampede protection that never shares a single in-flight result across principals.
• Tests: two-principal/two-tenant interleaved request suites and sentinel values; lint rule rejecting cache calls with keys not built via the key builder.
11. Search Security
• Search is a data store with its own authorization problem, not a shortcut around authorization.
• Phase 1 (recommended): Postgres full-text search inside the same RLS + scope-filter path, so results inherit the same protections.
• When using OpenSearch/Elasticsearch: per-tenant indexes (or routing + mandatory tenant filter) with the filter injected by a server-side search service, never from client query text; document-level security tags (tenant, campus, department, visibility, owner); clients never query the engine directly; the engine is network-isolated.
• Authorize before return: the search service builds the principal's scope filter and applies it inside the query, then re-verifies hits against the authorization layer before returning DTOs (guards against stale indexes after permission changes).
• Suggestions/autocomplete, facet counts, "did you mean" and result totals can leak existence, so they must obey the same filters.
• Deleted, anonymized, or permission-changed data is removed/updated in the index through the same event pipeline; indexes carry a rebuild path.
• Admin search is scoped like any other grant, with query logging and export limits.
12. Background Job Security
12.1 Safe job payload
• Required fields: tenant_id, initiated_by (principal or system identity), job_type, resource_ids, idempotency_key, schema_version, issued_at, expires_at, and a signature (HMAC) from the enqueuer.
• The payload never contains PII or secrets beyond IDs; workers fetch data themselves.
• Workers re-validate: signature, expiry, that every resource belongs to tenant_id, and that the initiating principal (or system policy) is still permitted.
• Workers set the RLS tenant context per job and clear it afterward; they use the app_worker DB role (RLS enforced, no bypass).
• Platform-wide jobs (e.g., retention sweeps) are explicitly marked, iterate tenants one at a time in isolated contexts, and are separately reviewed.
• Queues: per-tenant fairness and rate caps; dead-letter queues are access-controlled, since they hold payloads; retries are idempotent; poisoned messages cannot cross tenants.
• Reports/exports: generated in tenant-scoped storage, delivered through the signed-URL flow, expire automatically, require step-up for large/bulk exports, and are audited.
• AI jobs run with the initiating user's context and restricted tools (see §14).
13. Notification Security
• Recipient resolution is server-side: notifications reference a principal_id and the content comes from that principal's authorized data. Recipient address/number is looked up at send time from verified contact records, never copied into the job at creation.
• Verify ownership before send: contact must be verified, belong to the same tenant, and have no pending change/cooldown. Recently changed email/phone triggers a hold or a message to the old contact.
• Minimal content: notifications (especially SMS/WhatsApp/push) carry no sensitive details (no marks, balances, ticket contents). They say "you have a new update" and deep-link to the authenticated app. Lock-screen previews can be seen by others on shared devices.
• Shared devices / multiple accounts: push tokens are bound to a principal+device and unregistered on logout; sign-out clears tokens; re-registration requires a fresh login.
• Old/recycled phone numbers: periodic re-verification, bounce/opt-out handling, and OTP/phone-based messages are never the only recovery path for privileged users.
• Third-party providers (email/SMS/WhatsApp) are processors: DPAs, minimal data shared, tenant-level sender identities, webhooks authenticated and replay-protected.
• Templates are fixed and reviewed; user-supplied text is escaped and length-limited; links are signed, single-purpose and expiring; no PII in URLs.
• Rate limits and idempotency prevent spam floods and duplicate sends; per-recipient send logs support audit and abuse investigations.
14. AI Security
14.1 Principle
The model is an untrusted reasoning component that proposes actions. It is never an authority, and it never holds credentials or database access.
User -> AI Gateway -> LLM (untrusted) -> proposed tool call
     -> Tool Gateway (validates schema, injects RequestContext)
     -> Authorization -> Business logic -> Database (RLS)
     -> result DTO (filtered) -> LLM -> response filter -> User
14.2 Controls
• Identity is injected, not chosen. Tools accept no user_id, student_id, tenant_id, or arbitrary query parameters. The tool gateway binds them from the session. "Show attendance of student X" is simply not an expressible call for a student principal.
• Narrow, typed tools (e.g., get_my_attendance(term)), strict JSON-schema validation, allowlisted per role; no generic SQL, shell, URL-fetch, or file-system tools. Tools call the same service layer as the API, so all authorization applies.
• Least privilege per session: the AI inherits at most the user's permissions, usually less. Staff-facing AI tools are separate and scoped by grants.
• Read vs write: tools are read-only by default. Write actions produce a proposal that the user explicitly confirms in the UI (out-of-band from the model) and then execute through the normal workflow with step-up auth where needed. Marks/fees/roles are never changeable by AI.
• Prompt injection (direct): system prompts carry no secrets; user text is treated as data; safety does not depend on the model refusing, because capability is bounded by tools and authorization.
• Indirect injection (poisoned documents, tickets, emails, web pages the AI reads): untrusted content is delimited and labeled as data; retrieved/ingested content cannot grant or change tools, identity, or instructions; high-risk tool calls triggered right after untrusted content require user confirmation.
• Exfiltration: no outbound network tools; render model output as text/safe markdown (block image/link auto-fetch that can carry data in URLs); output scanning for PII patterns, other-user identifiers and secrets; response DTOs only include fields the principal may see.
• Rate and budget limits per user/tenant (tokens, tool calls, depth, loops); hard cap on tool-call chains.
• Provider hygiene: contractually no training on tenant data, minimal data sent, region and retention controls, redaction of identifiers where possible, provider keys in KMS-backed secret storage and never exposed to clients.
• Logging: record prompts, tool calls (arguments, authorization decision, result metadata) and refusals under an audit policy with PII minimization and restricted access.
• Evaluation: a standing red-team suite (§21) gating releases and model/prompt changes.
15. RAG / Knowledge Base Security
• Ingestion-time labeling: every chunk stores tenant_id, campus_id, department_id, audience (student / faculty / staff / admin), classification, source_doc_id, version, effective_dates. Unlabeled content is rejected, not defaulted to public.
• Isolation: per-tenant index/namespace (or collection). Cross-tenant retrieval is structurally impossible if the query targets only the principal's namespace.
• Authorization before retrieval: the retrieval service builds the metadata filter from the RequestContext (tenant + campus + department + role/audience + permission) and applies it inside the vector/hybrid query, never as a post-filter on top-k (which leaks via ranking and wastes recall).
• Re-authorization after retrieval: verify each source document is still accessible (document deleted/reclassified/permission changed) before its chunks reach the model.
• Shared platform content (generic help) lives in a separate, explicitly public namespace; tenant content never merges into it.
• Private staff or admin material is a different audience class and, ideally, a different index from student-facing knowledge.
• Student-private data is not embedded into shared indexes. Personal records (marks, fees) are served by authorized tools at query time, not through retrieval.
• Ingestion safety: scan documents, strip hidden text and instructions, and treat all content as untrusted when prompting (§14 indirect injection).
• Lifecycle: deletion/retention events delete vectors and cached chunks; embeddings are treated as personal data when derived from it.
• Citations show only accessible sources; answers that would require inaccessible documents say so without revealing them.
• Tests: canary documents per tenant/audience; every role queries for them; only the correct audience ever retrieves them.
16. Audit Architecture
• What: auth/security events, role and permission changes, grade/attendance/fee/result changes, document issue and access, service-request/ticket actions, admin actions, exports, AI tool calls, break-glass access, configuration changes, and access denials on protected resources. Reads of sensitive student data are audited at appropriate granularity (e.g., each document access; sampled/aggregated for routine lists).
• Record: event_id, timestamp (UTC), tenant_id, actor (principal + type), on-behalf-of, action, resource type + id, outcome, request_id, session_id, IP/device (appropriately minimized), reason/context, before/after (field-level for sensitive fields, hashed or masked where raw values aren't required).
• Immutability: append-only audit table (no UPDATE/DELETE grants for any app role), shipped in near-real time to a separate account/store with WORM/object-lock retention and hash chaining (each entry includes the previous entry's hash) to make tampering detectable.
• Tenant access to audit logs: college admins can view their tenant's audit trail through scoped, authorized APIs; platform engineers cannot read tenant audit content without break-glass.
• Do not log: passwords, tokens, signed URLs, full document contents, OTPs, full national ID numbers, raw AI prompts containing personal data (store references or redacted forms).
• Detection: rules and anomaly alerts (bulk reads, off-hours admin activity, repeated denials, role changes, new-device admin logins, large exports) feed an on-call process; alert tests run regularly.
• Retention: defined per event class, aligned with privacy policy and legal requirements.
17. Encryption Strategy
Area
Strategy
In transit
TLS 1.2+ (prefer 1.3) everywhere, including internal service-to-service; HSTS; mTLS or signed workload identity between services; encrypted DB connections with certificate verification
Database at rest
Volume/storage encryption with managed keys; application-layer envelope encryption for the most sensitive fields (government IDs, medical-adjacent notes, financial identifiers)
Object storage
Server-side encryption; per-tenant data keys wrapped by a KMS key; key policies restrict use to the storage service role
Backups
Encrypted with separate keys from production; stored in an isolated account; access restricted and audited
Secrets
Stored in a managed secret store/KMS; none in source, images, or client bundles; short-lived credentials via workload identity; secret scanning in CI and pre-commit
Signing keys
Session/JWT/URL signing keys in KMS/HSM where feasible, with key IDs (kid) to support rotation
Passwords
Argon2id (§5)
Key hierarchy
Root key (KMS/HSM) → per-tenant key-encryption key → data keys per dataset/object. Enables crypto-shredding for tenant offboarding
Rotation
Automatic periodic rotation of KMS keys; data-key re-wrap procedures; signing keys rotated with overlap; immediate rotation runbook for suspected compromise; credentials for AI/SMS/email providers on a rotation schedule
Access
Separation between who can use keys and who can administer them; key usage logged and alerted
18. Privacy Architecture
18.1 Design principles
• Data minimization: collect only fields with a documented purpose; every field in the data model carries a classification and purpose tag.
• Classification: Public · Internal · Confidential (grades, attendance, fees) · Restricted (ID documents, government identifiers, medical-adjacent or disciplinary notes, minors' data, authentication secrets). Classification drives encryption, access scope, logging, retention, AI/RAG eligibility and export rules.
• Purpose limitation: data collected for academics is not reused for analytics, marketing, model training or third-party sharing without a lawful basis and tenant authorization. Analytics use pseudonymized or aggregated data with minimum-group-size thresholds.
• Roles: in most deployments the college is the controller/fiduciary and we are the processor. Contracts (DPAs), sub-processor lists and breach-notification terms must reflect that, and the product must give tenants the tooling to meet their own obligations.
• Consent and notices: consent capture, versioning and withdrawal where consent is the basis; special handling for minors (students under 18) including guardian consent flows where the jurisdiction requires them.
• Data subject operations: access/export, correction, erasure/anonymization, restriction, and grievance handling, executed per tenant policy and audited. Erasure must propagate to backups (by expiry), search indexes, caches, embeddings, derived files and logs.
• Retention and archival: per-data-class retention schedules; alumni data archived to cheaper, more restricted storage; legal-hold support; automated deletion with verification reports.
• Pseudonymization in non-production: production data never used in dev/test; synthetic or irreversibly masked data only.
• Transparency: user-facing privacy settings and an access history ("who viewed my document") where appropriate.
• Data residency: tenant region pinned at onboarding; cell/region architecture (§3.3) supports it; cross-border transfers (including AI provider calls) are explicit and documented.
18.2 Compliance considerations to investigate (not claims of compliance)
Which of these apply depends on where each tenant and its students are located. Obtain qualified legal advice per market before launch.
• India: Digital Personal Data Protection Act, 2023 and its rules (consent, children's data and verifiable parental consent, fiduciary duties, breach notification, cross-border rules); IT Act and its security/incident-reporting directions (e.g., CERT-In); any sector or university-regulator requirements.
• US: FERPA (education records, "school official" processor arrangements), state student-privacy laws, COPPA where under-13 users are possible.
• EU/UK: GDPR/UK GDPR (lawful basis, DPIAs for large-scale processing of children's data, DPAs, international transfer mechanisms, breach reporting windows).
• Other regions: PDPA-style regimes (Singapore, Thailand, others), Gulf-state and African data-protection laws, data-localization rules.
• Assurance frameworks customers will ask for: ISO/IEC 27001 and 27701, SOC 2 Type II, OWASP ASVS and API Security Top 10 alignment, regular third-party penetration tests, and an AI risk-management approach (e.g., ISO 42001 / NIST AI RMF) given the AI features.
• Payment data: if cards are handled, PCI DSS scope should be minimized by using a hosted payment provider and never storing card data.
19. Data Integrity Strategy
Risk
Mechanism
Conflicting/duplicate records
Unique constraints scoped by tenant ((tenant_id, enrollment_id, class_date, period) for attendance), foreign keys, check constraints, NOT NULL, enumerated types
Partial updates
Transactions for multi-row operations (results publish, fee posting); consistent isolation level chosen per workflow
Two staff edit attendance/marks at once
Optimistic locking with a version column; stale update returns 409 with a diff for resolution; marks edits are append-only revisions with current pointer
Two admins overwrite sensitive changes
Same versioning plus change requests with approval (maker-checker); diff view; audit before/after
Duplicate payment / double submit
Idempotency keys persisted with a unique constraint; payment-provider reference unique per tenant; webhook handlers idempotent and signature-verified; reconciliation job compares ledger vs provider
Illegal workflow transitions
State machines (attendance: open → submitted → locked; results: draft → verified → published → amended; ticket and service-request lifecycles) enforced in the service layer and by DB constraints/triggers where cheap
Financial correctness
Append-only ledger for fees/payments (corrections are new entries, never edits); balances derived; reconciliation reports
Race conditions in capacity/slots
Row locks or constraint-based reservations
Time-based correctness
Terms, locks and windows defined in data; server time only; timezone-explicit UTC storage
Data validation
Domain validation in one place (service layer) plus DB constraints as the last line
Silent corruption
Checksums on documents, periodic integrity jobs (orphan detection, cross-table invariants), alerts on invariant violations
20. Backup and Disaster Recovery
• Backups: automated full + continuous WAL archiving for point-in-time recovery; object storage versioning with delete protection/object lock; configuration and infrastructure-as-code versioned.
• Targets (initial proposal, to be validated with customers): RPO ≤ 5 minutes for core academic/fee data; RTO ≤ 4 hours for the platform; tighter objectives for exam/result windows via pre-scaled capacity and runbooks.
• Encryption and isolation: backups encrypted with dedicated keys; stored in a separate account/region with separate credentials; production roles cannot delete or modify backups (ransomware resistance); restore requires break-glass with two approvals and is audited.
• Tenant-aware restore: in the shared-schema model a single-tenant restore means restoring to an isolated environment and extracting that tenant's rows, so build and rehearse this tooling early. Silo tenants get native per-tenant restore. Restored data is subject to the same access controls and never mounted into a shared environment unscrubbed.
• Deleted-data discipline: erasure requests are honored in backups by retention expiry plus a documented re-deletion step after any restore.
• Restore testing: automated restore-and-verify at least monthly (checksums, invariant checks, tenant-canary verification), plus a full DR game day at least twice a year; results tracked.
• DR design: multi-AZ by default; cross-region replica or warm standby for the data tier; documented failover/failback runbooks; DNS/traffic failover tested; dependency inventory (KMS, IdP, queue, email/SMS providers) with fallback plans.
• Incident response: documented plan with severity levels, tenant-notification templates, legal/regulatory notification timelines, forensics preservation, and post-incident reviews.
21. Security Testing Strategy
21.1 Test pyramid
Layer
What
When
Static analysis
SAST, dependency/SCA scanning, secret scanning, IaC scanning, container scanning, lint rules for banned patterns (raw SQL, uncached-key builders, undeclared routes)
Every commit
Unit tests of policy
Exhaustive allow/deny tables for the policy module (role × scope × relationship × state)
Every commit
Authorization matrix tests
Generated from the route registry: for every route × every role × own/foreign tenant/foreign scope resource, assert expected allow/deny
Every PR
Isolation tests
See §21.2
Every PR + nightly + post-deploy
DAST / API fuzzing
Schema-driven fuzzing, injection (SQLi, XSS, command), SSRF, XXE, deserialization
Nightly in staging
Auth/session tests
Brute force, lockout, token expiry, refresh reuse, revocation, fixation, CSRF, password reset flows, MFA bypass attempts
Every PR (core) + nightly
File-upload attacks
EICAR, polyglots, SVG scripts, zip bombs, path traversal, oversize, content-type mismatch
Every PR touching uploads
Rate limit / abuse
Verify limits trigger and are scoped correctly (not bypassable by header spoofing)
Nightly
AI/RAG red team
Prompt-injection corpus (direct and indirect), tool-abuse attempts, cross-tenant retrieval, exfiltration via markdown/links, jailbreaks; scored pass/fail gates
Every prompt/model/tool change + weekly
Concurrency/integrity
Parallel update races, double-submit, idempotency
Every PR touching writes
Performance/DoS
Load tests with tenant-fairness checks
Pre-release
Manual
Independent penetration test before first customer data and annually; threat-model review for each major feature; bug bounty/vulnerability disclosure later
Scheduled
21.2 Mandatory isolation tests (CI-blocking)
Seed two tenants (A and B), each with multiple campuses, departments, students, faculty, finance/exam staff and admins, plus sentinel data in every table and canary documents in files, caches, search and RAG.
1. Student A → Student B (same tenant): for every API route and every data type, Student A attempts to read/write Student B's resource using B's real ID, a random UUID, and a mutated ID. Expect uniform denial and zero bytes of B's data in responses, errors, headers, timing-insensitive fields, cached output, notifications, files, search results and AI answers.
2. Tenant A → Tenant B: every role in A (student through College Admin) attempts every route against B's resources, with B's tenant ID injected in body, query, header and AI tool arguments. Expect denial; DB-level test: connect as the app role with A's context and run SELECT * on every tenant table; assert zero B rows. Also with no context: assert zero rows.
3. Scope tests: Faculty of Section 1 vs Section 2; Dept Admin of Dept X vs Dept Y; Campus Admin 1 vs Campus 2; Finance vs Exam privilege boundaries.
4. Forgot-the-filter test: a test-only unscoped query path proves RLS alone blocks cross-tenant reads/writes.
5. Pooling test: interleave tenants on the same pooled connection; assert no context bleed.
6. Cache, search, RAG, job, notification and file tests: same two-tenant canary pattern at each layer.
7. Stale session/permission tests: after role removal or logout, old tokens and cached permissions stop working within the defined window.
These run on every pull request, block merge on failure, and also run nightly and after each deployment as production-safe synthetic checks against dedicated test tenants.
21.3 Metrics
Route coverage by authz-matrix (target 100%), mutation testing on policy code, time to fix by severity, escaped defects, red-team pass rate.
22. Security Threat Matrix
Severity = impact × likelihood without controls; Residual = after the proposed design is correctly implemented.
#
Threat
Severity (raw)
Primary controls (layers)
Residual risk
1
Student ID tampering
Critical
Self endpoints, policy, RLS tier-2, uniform denial
Low
2
UUID guessing
High
Policy (UUID ≠ authz), RLS
Low
3
Faculty out-of-scope attendance edit
High
Relationship check, state locks, audit
Low–Med (legit-but-wrong edits)
4
Admin cross-tenant access
Critical
Session tenant, RLS, composite FKs, tests
Low
5
AI retrieves another student's data
Critical
No DB access, identity injection, narrow tools
Low–Med (model manipulation within own data)
6
RAG cross-college leakage
Critical
Namespaces, in-query filters, re-auth
Low
7
Cache cross-contamination
High
Key design, no shared caching of personal data
Low
8
Job wrong-tenant processing
High
Signed payloads, per-job RLS context
Low
9
Signed URL leak
Medium
Short TTL, object-bound, logging
Medium (window of exposure)
10
Staff account compromise
High
MFA/passkeys, scoped grants, anomaly detection, step-up
Medium
11
Session theft
High
Cookie flags, rotation, reuse detection
Medium
12
Malicious upload
High
Quarantine, scan, isolated domain
Low–Med
13
Privilege escalation
Critical
Bounded granting, maker-checker
Low
14
Concurrent overwrite / double payment
Medium–High
Versioning, idempotency, ledger
Low
15
Missing tenant filter
Critical
RLS, repositories, CI catalog test
Low
16
Insider / vendor staff access
High
Break-glass, no default tenant access, audit
Medium
17
Third-party/provider compromise (SMS, email, LLM)
Medium–High
Minimal data, DPAs, key isolation
Medium
18
Ransomware / backup destruction
High
Isolated, immutable backups
Low–Med
19
Supply-chain compromise
High
SCA, pinned deps, signed builds
Medium
20
DoS during exam/result windows
Medium
Rate limits, autoscaling, queueing, CDN for static
Medium
23. Security Scorecard
How to read: scores rate the proposed design assuming it is implemented as specified. No code exists yet, so nothing is verified, and ratings below 8 carry remediation plans (§24 R-items). I'd treat these as targets to earn, not facts.
Area
Score
Why
Remediation (if < 8)
Authentication
8
Passkeys/MFA, rotation with reuse detection, step-up
Needs an external review of recovery flows (R9)
Authorization
9
Central scoped policy, relationship checks, route registry
Policy complexity must stay manageable; keep tests exhaustive
Tenant isolation
8
Four independent layers; shared-schema blast radius remains
Silo path for sensitive tenants (R1)
Student data isolation
9
Self endpoints, tier-2 RLS, uniform denial

Database security
8
RLS forced, restricted roles, composite FKs
Pooler and migration-role behavior must be proven (R2)
API security
8
Declared routes, DTOs, limits
Requires gateway and fuzzing in place (R3)
File security
8
Quarantine, signed URLs, separate domain
Scanner selection and operational ownership (R4)
Cache security
8
Namespaced keys, no shared personal caching
Key-builder lint must exist (R5)
Search security
8
Authorized-in-query plus re-verification
Start with Postgres FTS to limit surface
AI security
7
Bounded by architecture, but prompt injection cannot be eliminated, only contained
Read-only default, confirmations, red-team gates, per-role tool allowlists, AI disabled per tenant by default (R6)
Auditability
8
Immutable, hash-chained, separate store

Data integrity
8
Constraints, ledger, idempotency, state machines

Privacy
7
Strong technical foundation but compliance depends on jurisdiction and legal review
Legal review per launch market, DPIA, DPA templates, consent/minors design (R7)
Backup/recovery
7
Sound design, unproven restores; single-tenant restore is awkward in shared schema
Build tenant-extract restore tooling, rehearse game days before launch (R8)
Security testing
7
Strategy is complete, but no tests, pipeline, or pen test exist yet
Build the isolation harness before feature code (R10)
Scalability
7
RLS overhead and shared-DB limits manageable but unproven
Early load tests, partitioning, tenant router, cell plan (R1, R11)
24. Required Architectural Changes Before Implementation
ID
Change
Addresses
R1
Implement a tenant router abstraction and global IDs from day one; define criteria and process for promoting a tenant to a dedicated DB; sketch the cell model
Tenant isolation, scalability
R2
Spike: prove RLS + connection pooler + per-transaction context + migration role separation, including failure behavior (missing context → zero rows) and RLS benchmarks on representative volumes
Database
R3
Route registry requiring a declared permission + resource policy per route; boot/CI failure on undeclared routes; adopt schema-driven API fuzzing
API
R4
Choose and operate the upload pipeline (quarantine bucket, scanner, separate download domain) before any document feature ships
Files
R5
Mandatory cache key builder and lint; no direct cache access
Cache
R6
Define the AI tool gateway (identity injection, allowlists, confirmation UX, logging) and a red-team harness; AI off by default per tenant; no AI write tools in v1
AI
R7
Privacy workstream: data inventory and classification, retention schedule, consent and minors design, DPA/sub-processor list, legal review per target geography
Privacy
R8
Backup/DR build: PITR, isolated backup account, tenant-extract restore tool, monthly restore tests
Recovery
R9
Independent review of auth recovery, SSO provisioning and support-staff access (break-glass) design
Authentication
R10
Security test harness first: two-tenant seed data, isolation suite, authz matrix generator, CI gates, in place before building feature modules
Testing
R11
Load and DoS planning for exam/result/fee peaks; per-tenant quotas
Scalability
R12
Separate platform (vendor) identity realm and admin plane from tenant realms
Isolation, insider risk
R13
Environments: no production data in non-production; separate cloud accounts for prod, staging, backups and audit
Data protection
R14
Secure SDLC: mandatory reviews on auth/policy/migration changes, signed builds, dependency pinning, incident-response runbook
Supply chain, operations
25. Security Definition of Done
25.1 Architecture review gate (before implementation starts)
[ ] Threat model reviewed and signed off by security and engineering leads
[ ] Tenancy strategy, router abstraction and promotion path accepted (R1)
[ ] RLS/pooler spike passed (R2)
[ ] Authorization model and role/scope catalog approved, with an exhaustive policy test table
[ ] AI tool-gateway and RAG filtering design approved (R6)
[ ] Privacy/classification inventory started; legal review scheduled for target markets (R7)
[ ] Test harness plan with two-tenant canaries approved (R10)
[ ] All scorecard items below 8 have an owner, plan and date
25.2 Per-feature Definition of Done
A feature is not done until all of these are true:
1. Every new table has tenant_id, composite FKs, scoped unique constraints, RLS enabled and forced, data classification, retention class.
2. Every new route is in the route registry with permission, resource policy, DTO, rate-limit class and audit setting.
3. Self/resource endpoint split respected; no client-supplied identity, tenant or ownership fields are trusted.
4. Authz matrix and isolation tests (student↔student, tenant↔tenant, scope) generated and passing, including cache, search, file, job, notification and AI/RAG paths where touched.
5. Responses use DTOs and contain no unnecessary sensitive fields; errors uniform.
6. Audit events defined and verified; no sensitive data in logs.
7. Concurrency and idempotency behavior defined and tested for all writes.
8. Threat-model delta reviewed; security review completed for auth, policy, file, AI or payment changes.
9. SAST/SCA/secret/IaC scans clean; no unresolved high or critical findings.
10. Privacy review: purpose, minimization, retention, deletion path (including index/cache/embedding cleanup).
11. Monitoring and alerts added; runbook updated.
25.3 Release gate
• Full isolation and red-team suites green on the release candidate
• Independent penetration test completed with no open high/critical findings (before first real customer data)
• Restore test passed within the last 30 days; DR game day completed
• Secrets rotated since the last environment promotion; no shared credentials
• Incident-response contacts, tenant-notification templates and on-call rota confirmed
Final rules: never trust the client; never trust an identifier; never trust the AI; never assume tenant context is correct; never assume a role alone is sufficient; always verify ownership and scope server-side; protect data at multiple layers.