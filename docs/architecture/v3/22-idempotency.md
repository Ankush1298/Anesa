# 22 — Shared idempotency mechanism (Students slice, Phase 2)

Status: implemented by migration `0018_idempotency_keys.sql` and `backend/src/shared/idempotency/`. First consumer: `POST /api/v1/students` ([21-students.md](21-students.md)). Specification baseline: `04` §14 (the `Idempotency-Key` convention). No other route was changed; reuse is by calling `runIdempotent` from a service.

## 1. What it guarantees

A client that repeats a mutating request with the same `Idempotency-Key` (a lost response, a retry after a timeout) gets the **original successful response** and the business write does **not** run twice. A request that fails changes nothing and leaves nothing behind, so it can simply be retried.

| Situation | Result |
|---|---|
| Header missing | `428 IDEMPOTENCY_KEY_REQUIRED` |
| Header malformed (not 16–128 chars of `A-Za-z0-9_-`, empty, repeated) | `400 VALIDATION_ERROR` |
| First request with the key | business work runs; the 2xx response is stored |
| Same key, same canonical request | stored response replayed (`Idempotent-Replayed: true` set by the route), work **not** run |
| Same key, different canonical request or operation | `422 IDEMPOTENCY_KEY_REUSED`; the stored record is untouched |
| Same key while another request with that key is still running | the second waits for the first to end, then behaves as one of the rows above |
| Waiting longer than the database `lock_timeout` | `409 IDEMPOTENCY_IN_PROGRESS` (retry-safe) |
| Statement timeout, or a lock timeout inside the business work | `503 DATABASE_BUSY` (retry-safe; the transaction rolled back) |
| Key older than 24 hours | the record is expired and is replaced by the new request |

Only **2xx** results are stored. 4xx/5xx are never cached.

## 2. Identity, fingerprint and storage

`app.idempotency_keys` (0018): primary key `(organization_id, user_id, key)`.

- **Tenant and principal scoped.** The tenant and the user come from the `TrustedContext`, never from the request. Another user of the same tenant, or another tenant, using the same key string gets an independent record and can never read this one: a tenant policy plus a `RESTRICTIVE` `user_id = app.current_user_id()` policy, `FORCE ROW LEVEL SECURITY`, and a composite foreign key `(organization_id, user_id) → app.users`.
- **Canonical fingerprint.** `request_hash = SHA-256(canonicalJson({operation, request}))`, 64 lowercase hex characters (checked by the table). `canonicalJson` sorts object keys at every depth. `request` is the **normalised** request chosen by the caller (for students: lower-cased `userId`, trimmed `reason`), so equivalent requests hash equally. `operation` (`"POST /api/v1/students"`) is stored and compared too. Operation names are `"<METHOD> <route template>"` constants exported by the owning service: `POST /api/v1/students` (`CREATE_STUDENT_OPERATION`) and `POST /api/v1/students/:id/programs` (`OPEN_STUDENT_PROGRAM_OPERATION`); a path parameter that scopes the request (the student id) belongs in the hashed `request`, not in the operation.
- **Stored response.** `response_status` (200–299) and `response_body` (jsonb, ≤ 16 KiB, enforced by the service) are set together or not at all (check constraint).
- **Expiry.** `expires_at = now() + 24 hours` (`IDEMPOTENCY_TTL_HOURS`).
- **Privileges.** `app_runtime` has `SELECT`, `INSERT` and `UPDATE` on exactly `operation, request_hash, response_status, response_body, created_at, expires_at`. The identity columns are fixed; there is **no `DELETE`**.

## 3. Protocol (one transaction with the business write)

`runIdempotent(tx, ctx, {key, operation, request}, work)` runs inside `Database.withTenant`, **after** authentication, authorization and request validation (a replay never bypasses them):

1. `INSERT … ON CONFLICT (organization_id, user_id, key) DO NOTHING RETURNING key`. This is the serialisation point. A concurrent request with the same key blocks on the primary-key index until the first transaction ends: if it committed, the insert does nothing and the stored response is replayed; if it rolled back, this insert wins. The claim itself takes no advisory lock; a consumer that serialises on a per-resource lock (`StudentService.create` takes the per-person lock first, `21-students.md` §6) takes it BEFORE the claim, so two requests with one key for one account queue on that lock and the second then replays.
2. Claimed: run `work()` in the same transaction, then `UPDATE` the claim with the response. A throw from `work` aborts the transaction, so the claim disappears with it: **a failure is never cached**.
3. Not claimed: read the row. Expired ⇒ `UPDATE … WHERE … AND expires_at <= now()` replaces it in place; two racing replacements cannot both win (the loser blocks on the row lock, re-checks the predicate against the winner's new value, updates nothing and re-reads the winner's claim). Not expired ⇒ compare operation and hash (422 on mismatch) and replay.
4. A committed claim always carries a response, because claim and response are written in one transaction; a row without one is reported as a server error (a bug, never a client condition).

**Timeouts.** The SQL guard of `TenantTx` forbids `SET`, `set_config` and `pg_sleep`, so timeouts cannot be set per statement. They come from the runtime role (`lock_timeout = 10s`, `statement_timeout = 30s`, `tools/db/bootstrap.ts`). The module maps `55P03`/`57014` to the fixed answers in §1.

## 4. Verified by

`tests/unit/idempotency.test.ts` (key validation, canonical hashing, timeout mapping with a stubbed transaction), `tests/integration/idempotency.test.ts` (replay, 422, tenant/principal scope, failure not cached, expiry replacement, concurrent same-key requests with deterministic gates, six simultaneous identical requests, mixed bodies, expired-record races including a waiter with a different body, lock-timeout (409) and statement-timeout (503) mapping with test-only connection options, and a single-connection pool proving the connection is clean and reusable after a timeout), `tests/integration/student-atomicity.test.ts` (a real audit-write failure rolls back the student, the claim and the audit row; the same key then succeeds), `tests/security-db/idempotency-keys.test.ts` (row security, least privilege, constraints), `tests/security/idempotency-static.test.ts`, and the HTTP-level cases in `tests/integration/student-routes.test.ts`.

## 5. Limitations and deviations (stated, not hidden)

1. **No purge job.** Expired rows stay until a later platform job deletes them (the app role has no `DELETE`; an `expires_at` index exists for it). They are replaced on reuse.
2. **Replay returns the stored body verbatim**, including identifiers created by the original request. It does not re-run authorization against current data; the caller must be authorized *now* (the service checks permission before the lookup), and the key is scoped to the principal that created it.
3. **Only 2xx is cached**, only status and body (no headers other than the route's own `Idempotent-Replayed`). `Content-Type` is the route's.
4. **Key format is a choice**, not taken from a document: 16–128 URL-safe characters. Loosening later is safe; tightening is not.
5. **The 24-hour lifetime is measured from the claim**, and a replay does not extend it.
6. **Waiting is bounded by the role's `lock_timeout` (10 s)**; a request that waits longer gets 409 and should retry.
7. **Transaction isolation**: correct under `READ COMMITTED` (the `Database.withTenant` default), like the person-record guard.
8. **Not retrofitted** to any existing route (employees, organization, academics): out of scope for this phase.
