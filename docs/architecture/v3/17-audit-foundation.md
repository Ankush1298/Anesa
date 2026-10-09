# F1: Audit foundation (implementation note)

Implements ADR-008 and `03` §11 for the first MUST-audit mutations that exist today: role assignment grant
and revoke. Code: `database/migrations/0007_audit_events.sql`, `backend/src/shared/audit/*`,
`backend/src/shared/authorization/assignments.ts`. Nothing here adds a route, permission, viewer or job.

## Decisions (approved) and how they are implemented

| # | Decision | Implementation |
|---|---|---|
| 1 | Monthly range partitions, `PRIMARY KEY (id, occurred_at)` | `app.audit_events PARTITION BY RANGE (occurred_at)`, 27 partitions `audit_events_YYYY_MM`, 2026-10 … 2028-12, **UTC** month bounds (`+00`), so routing is independent of the session time zone |
| 2 | Documented fields | tenant (`organization_id`), actor (`actor_type`, `actor_user_id`, `on_behalf_of_user_id`), `session_id`, `request_id`, `ip`, `user_agent`, `action` (event type), `resource_type`, `resource_id`, `subject_student_id`, `campus_id`, `department_id`, `risk_tier`, `changes` (diff), `reason_code`, `reason_text`, `metadata`, `occurred_at` |
| 3 | 7-year retention is a **proposal** | Not implemented: no retention or deletion job exists. See "Retention" below. |
| 4 | Runtime has no SELECT/UPDATE/DELETE | `app_runtime` has `INSERT` on a fixed column list only (no SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES; `INSERT … RETURNING` is therefore refused). This is stricter than the "INSERT, SELECT" in `03` §11.2: a SELECT grant comes with the viewer, its permission and scoping. |
| 5 | Reason required for role grant/revoke | `normaliseReason`: trimmed, 5–500 characters, at least one letter or digit; validated before any database work |
| 6 | Request metadata passed in, `TrustedContext` unchanged | `recordAudit(tx, ctx, event, meta)`; `meta = {requestId, sessionId, ip, userAgent}` is supplied by the calling route/service (none exists yet for role changes) |
| 7 | Same transaction; audit failure fails the change | `recordAudit` uses the caller's `TenantTx`; any failure throws and `withTenant` rolls back |
| 8 | Sensitive keys rejected | `findAuditMetadataProblem` on `changes` and `metadata` (see below) |

## Table design (0007)
* `organization_id` FK to `organizations`; **no other FKs** (audit rows must outlive users/sessions/students and
  never block their lifecycle; ids are opaque references).
* `occurred_at` defaults to `clock_timestamp()` (database clock). `app_runtime` has **no INSERT privilege on that
  column**, so the application cannot back-date or forge time.
* RLS enabled **and forced** on the parent and on every partition. Only an INSERT policy exists: tenant =
  `current_tenant_id()`, `context_ok()`, `actor_type = 'USER'`, `actor_user_id = current_user_id()` and
  `on_behalf_of_user_id IS NULL`. The actor therefore cannot be forged and non-user actors/impersonation are not
  available to the runtime (loosen only by a reviewed migration when those features exist).
* Append-only: trigger `audit_events_immutable` rejects UPDATE and DELETE for **every** role including the owner
  and superuser (inherited by every partition; moving a row between partitions is an UPDATE and is rejected).
  Maintenance (DETACH/DROP of aged partitions) is owner DDL, not row mutation.
* CHECK constraints bound the shape: action `module.resource.action`, resource type, tier 1–3, reason length,
  user agent ≤ 256, `changes`/`metadata` JSON objects ≤ 16 KB.
* `request_id` is a random v4 UUID (Fastify) and so is the one `*_id` column that is not the `uuid_v7` domain;
  `schema-linter.test.ts` carries a narrow, documented exemption for exactly that column.

## Partition coverage and out-of-range behaviour (fail closed)
There is **no DEFAULT partition**. If `occurred_at` falls outside the provisioned months PostgreSQL rejects the
row (`23514`, "no partition of relation found for row"). Because the audit insert shares the business
transaction, the business change rolls back as well: the application returns `AUDIT_WRITE_FAILED` (500, generic
message, no database detail). Nothing is silently dropped and nothing is parked in an unmonitored catch-all
(a default partition also blocks creating a later partition that overlaps rows inside it).

Operational consequence (**deliberate and documented**): when the last provisioned month is reached, every
audited operation (today: role grant/revoke) starts failing until a partition exists. Runbook:
1. Add the next months with a **new** append-only migration `CREATE TABLE app.audit_events_YYYY_MM PARTITION OF
   app.audit_events FOR VALUES FROM ('YYYY-MM-01 00:00:00+00') TO ('<next month> 00:00:00+00')` followed by
   `ENABLE`/`FORCE ROW LEVEL SECURITY` (the static migration test and schema linter enforce this), at least 3
   months before the last partition ends.
2. A tripwire test in `security-db/audit-events.test.ts` fails once the last provisioned partition is less than
   3 months ahead, so the problem surfaces in CI long before production.
3. No scheduler is built in F1; automating partition creation is a separate decision.

## Helper contract (`backend/src/shared/audit`)
* The only writer of `app.audit_events` (a static test enforces it). It has no read path.
* Tenant and actor come from the `TrustedContext` only and are re-checked by RLS; an event object cannot carry
  them; `occurred_at` is never sent.
* It persists only the fields above, never a request body. Validation (action format, ids are UUIDv7, ip, request
  id, reason length, size) happens before any SQL and fails as `AUDIT_INVALID` (a programming error).
* Sensitive keys are rejected anywhere in `changes`/`metadata` (nested objects and arrays), matched on the
  normalised key as a substring: `password, passwd, passphrase, secret, token, credential, apikey, privatekey,
  authorization, cookie, csrf, totp, recoverycode, sessionid`. Non-plain objects, functions, NaN, depth > 6 and
  > 500 nodes are refused. The offending **path** is reported, never the value. Free-text `reason_text` cannot
  be inspected: callers must not put secrets in a reason.
* Role grant/revoke store: status old→new, target user id, role code, scope type/id (and `campus_id` /
  `department_id` for scoped assignments). No names, e-mail addresses or student data.

## Retention (proposal, not implemented)
ADR-008 and `03` §11.2 propose 7 years, configurable per organisation and never below any statutory minimum, with
partitions older than 1 year detached to cold storage. **This is a proposal pending legal/privacy confirmation**
(R-6). F1 implements no retention, deletion, archival or export job. `ip`, `user_agent` and `reason_text` are
personal data: the confirmation must cover them (ADR-020).

## Transaction and error behaviour (verified)
`Database.withTenant` runs `BEGIN`, sets the context, runs the work, then `COMMIT`, all inside one `try`; any
error, **including one raised by the audit insert (inside the work) or by a commit-time constraint**, reaches the
`catch`, which issues `ROLLBACK` and rethrows. The connection is only discarded if the rollback itself fails.
`recordAudit` converts every database failure into the generic `AUDIT_WRITE_FAILED`.

## Test-list changes (explicit lists, none weakened)
* `roles-and-privileges.test.ts`: `APP_TABLES` gains `audit_events`; the equality check now uses
  `relkind IN ('r','p') AND NOT relispartition` (covers the partitioned parent too); partitions are asserted
  one by one in `audit-events.test.ts` (owner, RLS forced, trigger, zero grants).
* `schema-linter.test.ts`: immutable-trigger list gains `audit_events` (partition children excluded, checked
  elsewhere); the `uuid_v7` check exempts only `audit_events*.request_id`.
* `authorization-rls.test.ts`: the function inventory gains `reject_audit_mutation`.
* `migrations.test.ts`: version lists gain `0007`.
* `static-architecture.test.ts`: the "every CREATE TABLE app.* has ENABLE+FORCE" regex now accepts digits in
  table names, which **strengthens** it (every partition must now carry both statements).
* `assignments.test.ts`: call sites adapted to the new signatures through thin wrappers; no assertion changed.

## Platform notes and limits
* Verified on the repository's embedded PostgreSQL 16.14 (macOS arm64). CI uses `postgres:16-alpine`; the features
  used (declarative range partitioning, partitioned indexes, row triggers on partitioned tables, FORCE RLS, column
  privileges) are standard in 16 but **have not been run against that image from this workstation** (no Docker).
* No viewer, SELECT grant, denial auditing, export, retention job, partition scheduler or outbox (all later).
* No `audit_events` rows exist for any operation other than role grant/revoke, and no route calls them yet.
* `session_id` / `request_id` / `ip` / `user_agent` are optional and are only populated once a route passes them.
