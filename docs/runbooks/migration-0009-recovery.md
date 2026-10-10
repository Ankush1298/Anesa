# Migration 0009: forward-fix and recovery design (F2.10)

Recovery plan for `database/migrations/0009_role_scope_integrity_contract.sql`, the gated contract migration of the
academic-structure rollout. It extends `docs/runbooks/academic-structure-rollout.md` (section 9.1 lists what was
carried over into it) and answers one question: **what do we know, observe, decide and refuse to do when 0009 does
not go to plan?**

**Status of this document.** Design for review. **Documentation only.** Nothing in it has been run against production
or any persistent database; no migration was run against a persistent or production database, and `pnpm dev:db` was not used.
Disposable-database testing and experiments did occur on throw-away databases (section 10). Facts are labelled with how
they were established (section 2). Every SQL statement here is **read-only**.

**Baseline when written** (before the F2.11 commits): `main` = `origin/main` = `85a9e12` (F2.9; CI run 38057283314 green).
`0008` and `0009` are unmodified since `a1a6d3f`. SHA-256 of the files at this baseline (the runner stores the same value in
`platform.schema_migrations.checksum`):
`0008` = `9c046975bc7d4903654778e75b26329af83bcfdf4a174aeff09ad147c4b1ca8d`,
`0009` = `0448b8fb9750c09db2c697c35ae8e923f9abd91339a14335a02eb942742c4e87`.

**Roles used below.** _Operator_ runs commands. _Approver_ owns the change window. _Database owner_ (DBO) owns the data
and any action on sessions, data repair or restore. Where this document says "DBO decision", the operator must not act
without it.

---

## 1. Ground rules (hard prohibitions)

These hold in every scenario. A proposed step that breaks one is rejected, not weighed.

1. **No constraint is dropped or relaxed** to make an application work again: not `ra_scope_integrity_ck`, not the
   composite foreign keys, and `ra_scope_id_check` is not re-added.
2. **Row level security is never disabled or weakened**: no `NO FORCE`, `DISABLE ROW LEVEL SECURITY`, policy removal or
   widening, `BYPASSRLS` for `app_runtime`, or wider runtime grants, on any tenant table. The only `NO FORCE` in the
   repository is inside 0009's own transaction, where it is rolled back or restored and verified before `COMMIT`.
3. **Nothing weakens tenant isolation.** Cross-tenant evidence (a role assignment that references another
   organisation's campus or department) is a security incident, not a data-cleanup task (scenario 3).
4. **`platform.schema_migrations` is not edited.** No scenario below needs it, and this plan contains no ledger edit. A
   ledger that disagrees with the schema is a finding to escalate (scenario 6), not something to adjust.
5. **An applied migration file is never edited.** The runner treats that as checksum drift and refuses to run.
6. **A failed client command is not evidence of rollback** (section 3). Establish the outcome from the database.
7. **No down migration exists** for 0008 or 0009. Do not write "reverse" SQL during an incident.
8. **Decisions are recorded** (section 8) before the next action.

---

## 2. What is established

Evidence labels: **[code]** read in the repository; **[probe]** executed without a database; **[exp]** executed against
a throw-away embedded PostgreSQL 16.14 (macOS arm64) with the repository's own runner and test-harness modules, in
temp directories deleted afterwards; **[test]** covered by the committed disposable-database tests; **[PG]**
PostgreSQL documented behaviour, **not** re-verified here; **[unverified]** a stated assumption.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                | Evidence                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| F1  | A migration runs as four separate awaited round-trips: `BEGIN`; the whole file as one multi-statement query; `INSERT` of the ledger row; `COMMIT`. The ledger row and the DDL are in one transaction: they commit or vanish together. `COMMIT` is not sent until the first three have been answered.                                                                                | [code] `migrate.ts`       |
| F2  | On any error the runner sends `ROLLBACK` and rethrows. If `ROLLBACK` itself fails (dead connection), **its error replaces the original one**; the original cause is lost. The `finally` that releases the advisory lock can fail and mask in the same way.                                                                                                                          | [code]                    |
| F3  | A run applies every pending migration of its plan in order, each in its own transaction. If a later one fails, earlier ones **stay committed**, and the thrown error does not say so (`result.applied` is only returned on success). Observed at baseline `85a9e12` (before the phase rule): `0007` database, `--allow-contract 0009`, injected failure in 0009 → the only message was the injected one; the ledger held `0001`–`0008`. That exact command is now refused (F4). For ordinary migrations (or on an empty ledger), any run with several pending migrations commits them one by one in the same way. | [code] [exp E6]           |
| F4  | The contract gate only checks that the operator named `0009`. With ledger `0001`–`0007` and `--allow-contract 0009` the plan is **`0008` then `0009` back-to-back**; at `0001`–`0008` it is `0009`; at `0001`–`0009` it is empty (a re-run is a no-op). The "deploy and drain between 0008 and 0009" step is procedural, not enforced. **Update (F2.11, `planMigrations` in `migrate.ts`):** the description above is the baseline `85a9e12`; on a non-empty ledger where earlier migrations are pending (e.g. ledger `0007`), naming `0009` is now refused by the planner before any migration SQL is sent, enforcing separate invocations (see H1). At ledger `0008`, `0009` is the first migration to run in that invocation, so it is permitted. An empty ledger (brand-new database) is still built in one pass. That exemption was tried against a truncated or missing ledger on a populated database, a schema built by only some migrations, and a lone pre-existing table: each stopped at the first conflicting object and 0009 was not applied (design doc 18; `migration-contract.test.ts`). | [probe] [exp E1] [test] |
| F5  | The runner holds a **session-level advisory lock** (key `727301001`) for the whole run, taken with `pg_advisory_lock` and **no timeout**. `app_migrator` has no timeouts set by bootstrap. A second run, or an orphaned one, makes the next run wait indefinitely.                                                                                                                  | [code]                    |
| F6  | Everything 0009 does is transactional DDL/DML (`SET LOCAL`, `LOCK`, `ALTER TABLE`, `DO`, `UPDATE`, `CREATE OR REPLACE FUNCTION`, `REVOKE`, `ADD/DROP CONSTRAINT`). No `CONCURRENTLY`, no sequence, no `BEGIN`/`COMMIT` in the file (static test). All effects, including the three `NO FORCE`/`FORCE` toggles, roll back together.                                              | [code] [test]             |
| F7  | Injecting an error at three points inside the real 0009 text (after backfill, after guard replacement, after the constraint swap) and rolling back restores a byte-identical schema state, row data, FORCE RLS flags, ledger and `lock_timeout`; the migration then applies cleanly.                                                                                                | [test] `migration-contract` |
| F8  | 0009 order: `SET LOCAL lock_timeout='5s'` → `LOCK` three tables `ACCESS EXCLUSIVE` → `NO FORCE` ×3 → preflight (read-only, per-category counts, raises before any change) → backfill (2 `UPDATE`s) → verification → guard replaced → `ra_scope_id_check` dropped, `ra_scope_integrity_ck` added → `FORCE` ×3 → verified. Locks are held to `COMMIT`. There is no `statement_timeout` in the file. | [code]                    |
| F9  | Neither migration is idempotent: 0008 uses plain `CREATE TABLE`/`ADD CONSTRAINT`; 0009 uses `DROP CONSTRAINT`/`ADD CONSTRAINT` without `IF [NOT] EXISTS`. Re-running on a state that already contains those effects normally fails and rolls back. `CREATE OR REPLACE FUNCTION` is the exception, so a state where only the guard was replaced could converge. Not enumerated exhaustively. | [code] reasoning          |
| F10 | **The runner trusts the ledger and never inspects the schema.** With the ledger at `0009` but the strict constraint dropped by hand, a re-run applied nothing and reported success.                                                                                                                                                                                                  | [exp E1]                  |
| F11 | If the client dies while a statement runs, the server backend **keeps running the statement** (default `client_connection_check_interval = 0`) and holds all its locks: the three `ACCESS EXCLUSIVE` table locks and the advisory lock were observed granted. A competing session got `55P03` on both the advisory lock and a plain `SELECT` until the statement ended; then the open transaction was rolled back. With `client_connection_check_interval = '1s'` set on the dying session the backend was gone within 1 s. `pg_cancel_backend` on the orphan released it. A long `pg_sleep` stood in for the real statements. Platform dependent. | [exp E2, E7]              |
| F12 | A transaction in which the server has reported an error cannot commit; `COMMIT` on it rolls back. Connection loss before `COMMIT` was sent cannot commit (F1). Only a loss between sending `COMMIT` and receiving the answer leaves the outcome unknown.                                                                                                                            | [code] F1, [PG]           |
| F13 | After a crash, uncommitted transactions are rolled back. Committed ones are durable under default `fsync`/`synchronous_commit`; after a failover to an asynchronous replica, the last commits can be missing on the new primary.                                                                                                                                                    | [PG]                      |
| F14 | A half-open TCP connection (network partition, no reset) may not be noticed by the server for a long time, so an orphan can outlive the client by much longer than in F11.                                                                                                                                                                                                          | [PG] `tcp_keepalives_*`   |
| F15 | `app_runtime` defaults: `statement_timeout` 30 s, `lock_timeout` 10 s, `idle_in_transaction_session_timeout` 30 s. These bound one statement and idle transactions, **not** a transaction's total duration. Other roles (scripts, admin tools) have none by default.                                                                                                                | [code] `bootstrap.ts`     |
| F16 | After 0009, `engine.ts` still reads only `scope_type`/`scope_id`. Nothing in `backend/src` reads `campus_id`/`department_id` of a role assignment or `role_assignments.version`. Writers: `RoleAssignmentService.grant` (writes both typed columns), `revoke` (status only), the dev seed (ORGANIZATION only, valid under the new check), test fixtures (write both). So the **only runtime behaviour change from 0009 is on the write side**: an insert of a CAMPUS/DEPARTMENT row without its typed column fails with SQLSTATE `23514`. | [code]                    |
| F17 | The backfill bumps `version` by 1 and sets `updated_at` on every CAMPUS/DEPARTMENT row that lacked its typed column, writes **no audit event**, and does not touch ORGANIZATION rows. Those rows are identifiable afterwards: `updated_at` equals the 0009 ledger `applied_at` (both are the transaction start time). Observed on a throw-away database; a later update of the same row hides it. | [exp E8]                  |
| F18 | **Not covered by any test:** connection loss or process death during a migration, an uncertain `COMMIT`, a live legacy writer racing 0009, restore. Safe termination around `COMMIT` rests on documented PostgreSQL semantics [PG], not experimental verification across all failure modes.                                                                                                                                                                                            | [test] review             |

---

## 3. What a failed command proves

Use this before drawing any conclusion from what the operator saw.

| What the operator saw                                                                    | What it proves                                                                                                                                                  | What it does **not** prove                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Exit `0`, `applied [0009]`                                                               | The server acknowledged `COMMIT`.                                                                                                                               | That the application works, or that replicas have it.                             |
| Non-zero exit with a **server error** (SQLSTATE such as `55P03`, `40P01`, `23xxx`, `P0001`) | The migration SQL failed, so that transaction cannot commit (F12). Locks may be held until the session ends.                                                    | That earlier migrations of the same run did not commit (F3).                      |
| Non-zero exit with a **connection error** (`Connection terminated`, `ECONNRESET`, timeout) | Nothing about the outcome. It may be the masked result of a failed `ROLLBACK` (F2).                                                                              | Rollback. Commit. Anything.                                                       |
| Process killed (`SIGKILL`, `Ctrl+C`, container eviction, host loss)                     | The client is gone. If `COMMIT` was not sent, the transaction cannot commit (F12), but the backend may still hold locks and run (F11, F14).                    | That the database is quiet.                                                       |
| The command **hangs**                                                                    | It is waiting: on the advisory lock (another or orphaned run, F5), on a table lock (0008 has no bound; 0009 waits at most 5 s), or inside a long statement.     | That it is making progress or has failed.                                         |
| Usage error or `allow-contract ... no contract migration with that exact version`        | Nothing ran (decided before any change).                                                                                                                         | Anything about earlier runs.                                                      |

---

## 4. Observation set (read-only)

Gather these **before acting**, from a separate administrative session on the **primary** (check O5 first). The
SQL blocks below (O1-O5 and the scenario 5 query) were extracted from this file and executed **verbatim** on a
throw-away PostgreSQL 16.14 in the states they describe (S0, S1, S2, and an orphaned backend), and returned the shapes
described. They have **not** been run on your server.

> RLS: `app.role_assignments`, `app.campuses` and `app.departments` are `FORCE ROW LEVEL SECURITY` with policies
> `TO app_runtime`. O1-O5 read catalogs and statistics only and are not affected. **Row counts (O6) need a role that
> bypasses RLS** (rollout runbook, section 5); counts taken as `app_migrator` or `app_runtime` show `0` and look like a
> pass.

**O1. Ledger and checksums.**

```sql
-- READ-ONLY.
SELECT version, name, checksum, applied_at, applied_by FROM platform.schema_migrations ORDER BY version;
```

Compare each `checksum` with `shasum -a 256 database/migrations/<file>` at the deployed commit (values in the baseline
paragraph). A mismatch, or a version missing from source control, is scenario 6.

**O2. State classification (catalogs only; does not read tenant rows).**

```sql
-- READ-ONLY. Safe on any state; does not error if the objects are absent.
SELECT
  (SELECT string_agg(version, ',' ORDER BY version) FROM platform.schema_migrations)                AS ledger,
  to_regclass('app.campuses')    IS NOT NULL                                                         AS has_campuses,
  to_regclass('app.departments') IS NOT NULL                                                         AS has_departments,
  (SELECT count(*) FROM pg_attribute WHERE attrelid = to_regclass('app.role_assignments')
      AND attname IN ('campus_id', 'department_id') AND NOT attisdropped)                            AS typed_columns,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('app.role_assignments')
      AND conname = 'ra_scope_id_check')                                                             AS has_old_check,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('app.role_assignments')
      AND conname = 'ra_scope_integrity_ck')                                                         AS has_new_check,
  (SELECT convalidated FROM pg_constraint WHERE conrelid = to_regclass('app.role_assignments')
      AND conname = 'ra_scope_integrity_ck')                                                         AS new_check_validated,
  (pg_get_functiondef('app.role_assignments_guard()'::regprocedure)
      LIKE '%NEW.campus_id IS DISTINCT FROM OLD.campus_id%')                                         AS guard_has_campus,
  (pg_get_functiondef('app.role_assignments_guard()'::regprocedure)
      LIKE '%NEW.department_id IS DISTINCT FROM OLD.department_id%')                                 AS guard_has_dept,
  (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('app.role_assignments'),
      to_regclass('app.campuses'), to_regclass('app.departments')))                                  AS tables_found,
  (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('app.role_assignments'),
      to_regclass('app.campuses'), to_regclass('app.departments'))
      AND relrowsecurity AND relforcerowsecurity)                                                    AS tables_force_rls;
```

Expected signatures (observed on the runner's own output for each state):

| Column                | S0: before 0008 | S1: after 0008, before 0009 | S2: after 0009        |
| --------------------- | --------------- | --------------------------- | --------------------- |
| `ledger`              | `0001`…`0007`   | `0001`…`0008`               | `0001`…`0009`         |
| `has_campuses` / `has_departments` | f / f | t / t                    | t / t                 |
| `typed_columns`       | 0               | 2                           | 2                     |
| `has_old_check`       | t               | t                           | **f**                 |
| `has_new_check`       | f               | f                           | **t**                 |
| `new_check_validated` | NULL            | NULL                        | **t**                 |
| `guard_has_campus` / `guard_has_dept` | f / f | f / f                 | **t / t**             |
| `tables_found`        | 1               | 3                           | 3                     |
| `tables_force_rls`    | 1               | 3                           | 3                     |

**Any other combination is MIXED. Stop** (scenario 6). In particular: `ledger` at `…0009` with `has_new_check = f` is
the F10 case that the runner itself would report as success. The signature proves the objects it names; it does not prove
0008's indexes, policies or grants, and says nothing about row data (O6).

**O3. Sessions.**

```sql
-- READ-ONLY. Migrator sessions and every open transaction in this database. Seeing other roles needs superuser or pg_monitor.
SELECT pid, usename, application_name, client_addr, backend_start, xact_start, state,
       wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 60) AS query
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid()
   AND (usename = 'app_migrator' OR xact_start IS NOT NULL)
 ORDER BY xact_start NULLS LAST;
```

A `app_migrator` row that is `active` or `idle in transaction` after the client is gone is an **orphan** (F11). The
runner sets no `application_name`, so identify it by `usename`, `xact_start` and the query text.

**O4. Locks (the three tables and the runner's advisory lock).**

```sql
-- READ-ONLY. For a bigint advisory key, classid = high 32 bits (0 here), objid = low 32 bits, objsubid = 1.
SELECT l.pid, l.locktype, l.mode, l.granted, a.usename
  FROM pg_locks l JOIN pg_stat_activity a USING (pid)
 WHERE l.pid <> pg_backend_pid()
   AND ( l.relation IN (to_regclass('app.role_assignments'), to_regclass('app.campuses'), to_regclass('app.departments'))
      OR (l.locktype = 'advisory' AND l.classid = 0 AND l.objid = 727301001 AND l.objsubid = 1) )
 ORDER BY l.granted, l.pid;
```

Observed during an orphan: three `AccessExclusiveLock` relation rows and one `ExclusiveLock` advisory row, all
`granted`, all one `pid`. On a database that has not reached 0008 no edit is needed: `to_regclass` returns NULL for the
missing tables, which match nothing (the query returned no rows, without error).

**O5. Which node, and prepared transactions.**

```sql
-- READ-ONLY. in_recovery = true means this is a replica: its ledger may lag the primary.
SELECT pg_is_in_recovery() AS in_recovery, (SELECT count(*) FROM pg_prepared_xacts) AS prepared_xacts;
```

The runner never uses two-phase commit; `prepared_xacts > 0` is unexpected.

**O6. Data checks** (RLS-bypassing role only). The fourteen preflight categories are in rollout runbook section 5.4; the
post-0009 invariant and `rows_checked` are in section 9.2. Reuse them; do not improvise.

**O7. Server and application evidence.** Server log around the incident (look for `unexpected EOF on client connection
with an open transaction`, `could not receive data from client`, `canceling statement due to lock timeout`, `deadlock
detected`, crash or failover messages); the deployment platform's list of running instances, workers and jobs;
application error rate **by SQLSTATE** (`23514` is the contract's signature, section 5.5); and, if the DBO enabled it,
DDL statement logging.

---

## 5. Scenarios

Each scenario states what is known, what to observe, whether retrying is safe, whether a forward fix is appropriate,
what needs a decision, and when to stop.

| #   | Scenario                                    | Retry the migration                   | Forward-fix migration                                  |
| --- | ------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| 1   | Fails before taking its table locks         | **Conditional**                       | No                                                     |
| 2   | Takes locks, fails before commit            | **Conditional**                       | No                                                     |
| 3   | Fails in preflight or backfill              | **Unsafe** until data is repaired     | No (data is not repaired by a migration)               |
| 4   | Process or connection lost, commit uncertain | **Unsafe** until the outcome is known | Not applicable; if committed, see 5                    |
| 5   | Commits, then the application misbehaves    | No-op (already applied)               | **Conditional**, additive/strengthening only           |
| 6   | Partial state or ledger disagrees           | **Unsafe**                            | Only a DBO-designed, reviewed reconciliation           |
| 7   | Recovery while legacy writers may be live   | **Unsafe** until the drain is re-proven | No (the fix is operational)                           |

### Scenario 1: 0009 fails before acquiring its table locks

**Where this can happen** [code]: (a) before `BEGIN`: wrong role (`migrations must run as app_migrator`), connection
refused, checksum drift, a ledger version missing from source control, a bad `--allow-contract` value, or waiting on the
advisory lock (F5); (b) inside the transaction before `LOCK TABLE` completes: `SET LOCAL` cannot realistically fail; the
`LOCK` fails with `55P03` after 5 s, `40P01` (deadlock with an in-flight grant), `57014` (cancelled by the operator or a
role `statement_timeout`).

**Known.** Nothing of 0009 has changed; with a server error the transaction cannot commit (F12). **But the failing migration
may not have been the only one in the invocation (F3):** a run with several pending migrations (for example an ordinary `pnpm db:migrate`
on a ledger behind 0007, or an empty ledger) commits them one by one, so earlier ones stay committed and the error says nothing
about them. With the phase rule (F4), `--allow-contract 0009` cannot be combined with a pending 0008 (or any other earlier pending migration) on an
existing database; that command is refused before any migration SQL is sent.

**Observe first.** O1 (is `0009` absent? is `0008` present?), O2 (S0 or S1 exactly), O3 and O4 (is anything holding the
tables or the advisory lock, including a previous run's orphan?), the exact SQLSTATE and message, and for `55P03`/`40P01`
the blocker (`pg_blocking_pids`, O3).

**Retry.** **Conditional.** Only when: the state is exactly S1 (or S0 if the ledger never reached 0008 and the
operator intends the two-step rollout); no `app_migrator` backend and no advisory lock remain (O3, O4); and the drain
has been **re-attested** (rollout runbook section 7). `55P03` and `40P01` are direct evidence that a writer or long
transaction is still alive: do not simply retry. Retry the **two-step** way: `pnpm db:migrate` first, confirm S1, deploy
and drain, then `pnpm db:migrate --allow-contract 0009`.

**Forward fix.** **No.** There is nothing to fix in the schema; a lock failure is operational.

**Decisions (DBO / approver).** Ending a blocking session (cancel or terminate); extending the window; whether the
blocker is acceptable to wait out. Do not change the 5 s bound in the field: that is an edit of an unapplied migration
and a code change (section 9).

**Stop if:** the state is not S0 or S1; an `app_migrator` backend or the advisory lock is still held and unexplained;
`55P03` repeats once after a re-drain; `40P01` occurs at all; the application error rate rises while the migration waits.

### Scenario 2: 0009 acquires some or all locks but fails before commit

**Known.** The whole file is one transaction (F1, F6). Any error rolls back all of it: the backfill, the guard
replacement, the constraint swap, the three RLS toggles and the ledger row. Rolling back the three `NO FORCE` toggles
restores FORCE RLS (tested, F7); `SET LOCAL lock_timeout` ends with the transaction. Locks are released when the
transaction ends. Possible causes: `statement_timeout` from a role or database default (`57014`), disk full or memory
(`53xxx`), server shutdown (`57P01`), an operator `pg_cancel_backend`, or a data/logic error (scenario 3). A server error
means this transaction cannot have committed (F12). A connection error is scenario 4.

**Observe first.** The SQLSTATE and message; O1, O2 (must be exactly S1; in particular `has_new_check = f`,
`guard_has_* = f`, `tables_force_rls = 3`); O3 and O4 (no lingering backend or lock); O6 row counts unchanged from before
the attempt (rollout runbook 5.3/5.5).

**Retry.** **Conditional.** Only when the specific cause is understood and removed (resource restored, timeout default
understood, cancellation was deliberate) **and** O2 is exactly S1. A retry costs another `ACCESS EXCLUSIVE` window and
another queue on `role_assignments`; do not iterate blindly. The injected-failure tests show a retry applies cleanly
after a rollback (F7), which is why the retry is acceptable once the cause is gone.

**Forward fix.** **No.** Nothing was committed. Do not write a migration to "finish" a rolled-back 0009.

**Decisions.** Whether to change a role/database `statement_timeout` for the window (DBO); whether to reschedule.

**Stop if:** O2 shows anything except S1 (a committed `NO FORCE` or a partial state means something other than the
rolled-back transaction acted: scenario 6); `tables_force_rls` is below 3 on a database where an `app_migrator`
transaction is **not** open (a committed loss of FORCE RLS is a security incident; escalate, do not repair ad hoc);
the same failure repeats.

### Scenario 3: 0009 fails during preflight or legacy-data backfill

**Known.** The preflight (F8) is read-only. It counts fourteen categories over rows of **every** status and, if any is
non-zero, raises `integrity_constraint_violation` with a per-category message; `DETAIL` states that nothing changed. It
runs **after** the locks are taken, so the full-table scans run under `ACCESS EXCLUSIVE` (duration unmeasured). The
backfill can fail only for reasons the preflight does not model: a timeout or cancel, resource exhaustion, or the
post-backfill verification (`post-backfill verification failed`). All roll back (F6). Rows are never deleted, revoked or
rewritten by the migration.

**Expected, benign cause.** CAMPUS/DEPARTMENT assignments created **before** 0008 reference campuses that never existed:
`campus not found` / `department not found` (rollout runbook 5.3).

**Observe first.** The full message with its per-category counts; O2 (S1); then, with an RLS-bypassing role, the rows
behind each non-zero category (the `WHERE` clauses in rollout runbook 5.4, selecting identifying columns instead of
`count(*)`). Classify the rows:

| Category                                                                                              | Meaning                                                                          | Handling                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `campus/department not found`, rows predate 0008                                                       | Legacy rows from before the tables existed                                       | DBO decision: audited repair outside this plan                           |
| `campus/department in another organization`                                                            | A role assignment points at another tenant's scope                                | **Security incident.** Stop. Preserve evidence. Not a data-cleanup task   |
| `unknown scope_type`, `scope_id NULL` for CAMPUS/DEPARTMENT, `typed id differs from scope_id`, `wrong-kind typed id set` | Impossible under the 0005/0006/0008 constraints unless something bypassed them | Stop and escalate: possible out-of-band writes (scenario 6)               |
| Count grows between attempts                                                                           | A writer is still creating bad rows                                              | Scenario 7                                                                |

**Retry.** **Unsafe** until every category is `0` as verified by the rollout runbook 5.4 queries (RLS-bypassing role). A
retry on the same data fails identically after taking the same locks. After an audited repair: conditional, as in
scenario 2.

**Forward fix.** **No.** A migration must not repair, revoke or delete assignments, and 0009 must not be changed to
"skip bad rows". Repair is a separate, audited, DBO-owned data procedure; where possible it goes through the
application's own service paths so that audit events are written (the guard allows `ACTIVE` → `REVOKED`; nothing may
resurrect a terminal row). If the failure shows a **defect in 0009's own logic** (for example a preflight predicate that
rejects valid data), the fix is a reviewed code change, and the rule in section 7 on editing versus adding a migration
applies.

**Decisions.** Every repair (DBO); whether a cross-tenant finding is declared an incident (approver/DBO).

**Stop if:** any cross-tenant category is non-zero; unknown scope types; counts grow; the same preflight failure recurs
after a "repair"; `post-backfill verification failed` appears at all (the preflight should have prevented it).

### Scenario 4: process or connection lost, commit status uncertain

**Known.** Because the file, the ledger insert and `COMMIT` are separate round-trips (F1), two situations differ:

- **Loss before `COMMIT` was sent** (during the file or the ledger insert): the transaction **cannot commit**. But the
  backend may keep running the statement and **keep holding the three `ACCESS EXCLUSIVE` locks and the advisory lock**
  until it finishes or the DBO ends it (F11, F14). The application is blocked behind those locks meanwhile, and a second
  run waits forever on the advisory lock (F5).
- **Loss while `COMMIT` is in flight:** genuinely uncertain. The ledger row and the DDL are one transaction, so the
  **ledger row on the primary is a faithful witness**: present means committed with all effects, absent means none.
- The runner's own error is probably a connection error and may be the masked `ROLLBACK` failure (F2); the original cause
  is lost.
- After a **failover**, the new primary's ledger is the truth; the old primary's commits may be missing (F13).

**Observe first (before any second run).** O5 (is this the primary, which one?), O3 and O4 (is an `app_migrator` backend or
the advisory lock still present?), then O1 and O2. Do this repeatedly until O3/O4 are empty; do not infer "it must have
rolled back by now" from elapsed time (F14).

**Decision tree.**

| Observation                                                         | Conclusion                         | Action                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Orphan backend or advisory lock present                              | Outcome undecided; locks held       | **Do not start another run.** DBO decides: wait for the statement, `pg_cancel_backend`, or `pg_terminate_backend` (cancel released the orphan in F11). Then re-observe. |
| No backend; ledger has `0009`; O2 = S2                              | Committed                           | **Do not re-run** (a re-run is a no-op, F4). Go to the post-checks, section 9.2 of the rollout runbook; problems → scenario 5. |
| No backend; ledger lacks `0009`; O2 = S1                            | Rolled back                         | Scenario 2 retry rules.                                                                   |
| Ledger has `0009` but O2 = S1, **or** ledger lacks `0009` but O2 = S2 | Disagreement (should be impossible from the runner, F1) | Scenario 6. Stop.                                              |
| Cannot determine which node is primary                              | Unknown                             | Stop. DBO.                                                                                |

**Retry.** **Unsafe** until the outcome is established; afterwards either meaningless (committed) or scenario 2
(rolled back).

**Forward fix.** None for the uncertainty itself. If it committed and misbehaves, scenario 5.

**Decisions.** Cancel vs terminate vs wait on an orphan (DBO). Terminating a backend that is mid-`COMMIT` is, by
PostgreSQL's documented commit semantics [PG], not a corruption risk (the transaction either committed or did not; O1
decides), but safe termination around `COMMIT` has **not** been verified against this actual migration under all failure modes (F18); it is still the DBO's call.

**Stop if:** an orphan cannot be explained; the primary is ambiguous; the ledger and schema disagree; a second operator
has started a run.

### Scenario 5: 0009 commits, then application behaviour fails

**Known.** State S2. There is no down migration, and this plan does not create one. What changed for the application
(F16, F17): CAMPUS/DEPARTMENT inserts must carry the typed column; the typed columns are immutable; backfilled rows have
`version + 1` and a new `updated_at` and no audit event; no source code reads the typed columns or `version`. Classify
the failure before choosing a response:

| #   | Symptom                                                                                       | Likely cause                                         | Response                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5a  | Grants at CAMPUS/DEPARTMENT scope fail with SQLSTATE `23514` (`ra_scope_integrity_ck`)        | A legacy writer or old application build is alive    | **Fix forward in the application/deployment**: stop or upgrade that writer. Do not touch the constraint. ORGANIZATION grants from that writer still succeed, so it can stay unnoticed. |
| 5b  | Someone proposes rolling the application back                                                  | Pre-F2 build does not write typed columns            | Safe only for builds that write both typed columns. A pre-F2 build breaks CAMPUS/DEPARTMENT grants (5a) and does not know the organisation API. Prefer a forward fix in code. |
| 5c  | Errors unrelated to the constraint                                                             | A defect in application code                         | Fix in code and redeploy. The database stays as it is.                                                                                              |
| 5d  | Clients report version mismatches on role assignments                                          | Backfill bumped `version` on CAMPUS/DEPARTMENT rows  | Refresh the client's view. No source code uses the value; any external consumer is **unknown** [unverified]. Identify the rows with the O6-style query below. |
| 5e  | `UPDATE ... SET status` on a role assignment fails with `restrict_violation`                   | The extended guard rejects a change it should allow  | Compare with the guard text (F8). Only if the guard is genuinely wrong: forward fix 5g.                                                              |
| 5f  | Suspected data inconsistency                                                                   | Out-of-band writes or restore (should be impossible) | Run the section 9.2 `violations` query; non-zero → scenario 6.                                                                                       |
| 5g  | A defect in the guard function or a missing additive object (for example an index)             | A defect in 0009's tail                              | Forward-fix migration under the policy in section 7.                                                                                                 |
| 5h  | Severe, unexplained, data-wide damage                                                          | -                                                    | The only schema-neutral recovery is a **restore** (below), a DBO and approver decision with data loss.                                              |

Rows touched by the backfill (F17), as evidence for 5d (RLS-bypassing role; rows updated again later are no longer
identifiable):

```sql
-- READ-ONLY. Run as an RLS-bypassing role. Rows whose updated_at equals the 0009 commit's transaction start time.
SELECT ra.id, ra.organization_id, ra.scope_type, ra.version
  FROM app.role_assignments ra
 WHERE ra.updated_at = (SELECT applied_at FROM platform.schema_migrations WHERE version = '0009')
 ORDER BY ra.organization_id, ra.id;
```

**Observe first.** Error counts by SQLSTATE and by client (O7, O3); O1, O2 (S2); the section 9.2 checks of the rollout
runbook; which application build and which writer produced the failing statements.

**Retry.** Not applicable: the ledger holds `0009`, and a re-run plans nothing (F4). Do not use `--allow-contract` again
as a "fix".

**Forward fix.** **Conditional**, and only within section 7: additive or strictly strengthening changes. 5g is the one
schema-level case contemplated (replace the guard with a corrected body that rejects a superset of what it rejects now, or
add a missing index). 5a-5d and 5f are not schema problems.

**Restore.** A restore from backup discards every write since the backup, **including other tenants' data**. The
repository contains no restore procedure and none has been exercised (rollout runbook section 3, 10). It is a last resort,
requires the approver and DBO, and must not be promised to stakeholders.

**Decisions.** Whether to hold traffic or enter maintenance mode; forward fix versus restore; how to communicate the
`version` bump (approver).

**Stop if:** any proposal drops or loosens a constraint, touches RLS or grants, or edits the ledger (section 1); the
section 9.2 `violations` is non-zero; evidence of cross-tenant data.

### Scenario 6: partially upgraded database, or schema state disagrees with the ledger

**Known.** The runner makes the ledger row and the DDL atomic (F1), so **the runner alone cannot produce a
disagreement**. It therefore means something else acted: manual SQL, a partial or mismatched restore, another tool, a
wrong target database, or a defect. The runner's behaviour on a disagreement is uneven: a changed checksum, a
version missing from source control, or a ledger that is not a contiguous prefix `0001..N` (the R2 rule in F2.11: `Migration ledger is not a contiguous prefix of the migrations in source control...`) stops it before any migration SQL is sent; a `0008` re-run onto existing objects fails (F9); a `0009` re-run fails at
`DROP`/`ADD CONSTRAINT` in most combinations but could converge in some (F9); and **a ledger that says `0009` while the
schema lacks it is silently accepted** (F10). So a green runner proves nothing here.

**Observe first.** O1 with checksum comparison; O2 (the signature that differs, and in which column); O5; O3/O4 (an
operation may be in progress); O6; the server log and any DDL logging for who changed what and when; and **which database
the runner actually targeted** (rollout runbook section 3: `current_database()`, `inet_server_addr()`, port). A second
database with the same name on another host is a classic cause.

**Retry.** **Unsafe.** Do not run the migration to "converge" a state you have not fully diffed.

**Forward fix.** Appropriate **only** as a DBO-designed reconciliation after a full diff, and only if it can be expressed
as a normal runner migration that moves the schema toward S2 without loosening anything. Method (read-only on the
target): build a reference S1 and S2 in a disposable database with the repository's runner at the deployed commit; compare
catalog definitions (constraints, indexes, triggers, policies, grants, function bodies, RLS flags). A schema-only dump of
the target is read-only but takes `ACCESS SHARE` locks, so it can queue behind a waiting `ACCESS EXCLUSIVE` request: do
not run it while a migration is waiting. If the target differs in ways a migration cannot fix (for example an object the
ledger does not know), the choices are a restore from a known-good backup or a one-off, separately approved DBO action.
**Editing the ledger is not part of this plan** (section 1.4).

**Decisions.** All of them: whether to freeze changes, which reference to trust, restore vs reconcile (DBO and approver),
and whether an incident is declared.

**Stop if:** any MIXED signature; a checksum mismatch; an unknown object; the runner and the schema disagree about
whether 0009 is applied; any sign of `NO FORCE` or a missing policy on a tenant table. Do not run any further migration.

### Scenario 7: recovery while old application instances or legacy writers may still be running

**Known.** The 0009 header requires every legacy writer to be drained first, and says why: after the migration a
straggler fails closed on CAMPUS/DEPARTMENT, and a grant in flight can deadlock with the migration because table lock
order differs. The preflight runs under `ACCESS EXCLUSIVE`, so it is race-free against writers [code]; the exposure is the
lock queue, the deadlock, and the post-commit `23514`. The database cannot tell you which process wrote a row
(rollout runbook 5.5). `app_runtime` sessions are bounded per statement and when idle (F15) but not in total duration;
writers that use other roles are unbounded. A legacy writer that only grants ORGANIZATION roles is **invisible** to every
check (and harmless to 0009).

**Observe first.** The deployment platform's authoritative inventory of instances, workers, cron jobs, seed/import
scripts and admin tools (not memory); O3 grouped by `usename`, `application_name`, `client_addr`; sessions from unknown
addresses using runtime or migrator credentials; the rollout runbook 5.5 query twice, a quiet interval apart; whether
traffic is still routed to old instances.

**Retry.** **Unsafe** until the drain is proven again. Any earlier `55P03`/`40P01` is positive evidence that a writer is
alive. This applies equally to retries after scenario 1, 2 or 4.

**Forward fix.** **No.** The fix is operational and happens in the deployment layer: block or drain at the load balancer
or application (maintenance mode), stop the instances, then re-prove. **Do not change database roles, grants or RLS to
force a drain.**

**Never** run a restore while old instances can still connect: they would write into the restored database.

**Decisions.** Window extension; maintenance mode; whether to end specific sessions (DBO); who attests the drain
(deployment owner) and who accepts that attestation (approver).

**Stop if:** any instance, job or session cannot be accounted for; sessions from unknown clients use privileged
credentials; the 5.5 count is still rising; the window expires.

---

## 6. Cross-scenario stop-the-line list

Stop all migration activity and escalate to the DBO and approver if **any** of the following is true:

1. O2 reports MIXED, or the ledger and schema disagree (scenarios 4, 6).
2. An `app_migrator` backend or the advisory lock `727301001` is held by a session nobody can explain.
3. `tables_force_rls` is below 3 (from state S1 onward) while no migration transaction is open.
4. Any cross-tenant category (campus/department in another organisation) is non-zero.
5. A second operator has started, or might start, a migration.
6. The target database or server is in doubt.
7. Anyone proposes a step prohibited by section 1.
8. The approved window is exhausted.

---

## 7. Forward-fix policy

A forward fix is a **new** migration file, applied by the same runner, ledger entry written by the runner.

**Allowed (additive or strictly strengthening).** Adding an index. Adding a nullable column. Replacing a function body
only if a reviewed comparison shows the new body rejects at least everything the current one rejects (for 5g: all of
`user_id`, `role_id`, `scope_type`, `scope_id`, `campus_id`, `department_id`, `valid_from` immutable, and the terminal
status rule). Adding a constraint, validated or `NOT VALID` then validated, that is no weaker than what exists.

**Forbidden.** Everything in section 1: dropping or loosening `ra_scope_integrity_ck` or the composite foreign keys;
re-adding `ra_scope_id_check`; `NO FORCE` or any RLS/policy weakening; wider grants for `app_runtime`; `BYPASSRLS`;
data repair, revocation or deletion inside a migration; touching the ledger.

**Checklist for any forward fix.**

1. Name and number it as the next version (`0010_…`). **Never edit `0008` or `0009` once either has been applied to
   any persistent database**; the runner reports checksum drift. Editing is possible only for a migration that no
   persistent environment has applied, and then it is a code change to a not-yet-applied file, decided by the repository
   owner, not by the operator during an incident.
2. A migration whose name ends in `_contract` is gated by the runner (`--allow-contract`); use that suffix only for a
   migration that tightens the schema for existing writers.
3. Set `SET LOCAL lock_timeout` before the first lock, as 0009 does, and keep the work in one transaction.
4. Test it on a disposable database following `migration-contract.test.ts`: success on legacy-shaped data, an injected
   failure at each stage that rolls back byte-identically, and a successful retry.
5. Add static gates for the prohibited statements (compare `academic-structure-static.test.ts`).
6. Review as a security change. Rehearse on a restored copy of production-shaped data and **measure** the lock time.
7. Apply with the two-step rule (section 5, scenario 1): never combine an expand with a gated step in one invocation.

---

## 8. Decision record

Record before each action that changes anything. One entry per decision.

```
Time (UTC):                 Operator:            Approver:           DBO:
Scenario (1-7) and trigger:
Observations attached: O1 [ ]  O2 [ ]  O3 [ ]  O4 [ ]  O5 [ ]  O6 [ ]  O7 [ ]
State classification:       S0 / S1 / S2 / MIXED     Ledger: ...
Decision and who made it:
Action taken (exact command or SQL, read-only or not):
Result and re-observation:
Stop conditions checked (section 6):
```

---

## 9. Findings that should change the existing runbook, and hardening proposals

**Status.** R1-R4 below have been applied to the rollout runbook (R4 as a cross-reference to section 4 of this guide,
not a copy), and H1 is implemented in `migrate.ts` (`planMigrations`). The migrations and `cli.ts` are untouched. H2-H7 remain proposals for separate, reviewed changes. Neither document has been
validated against production.

### 9.1 Corrections to `academic-structure-rollout.md` (documentation)

| #   | Where                | Gap                                                                                                                                                                                       | Proposed text                                                                                                              |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| R1 (applied) | Sections 8 and 11 (Gate C) | Gate C and section 8 never require the ledger to be at `0008`. `--allow-contract 0009` at `0007` runs 0008 and 0009 back-to-back, skipping the deploy and drain (F4).                     | Add: "Immediately before the command, O1 shows exactly `0001`-`0008` and `0009` absent. Never combine the two migrations." |
| R2 (applied) | Section 10           | "If the connection is lost mid-run, PostgreSQL aborts the open transaction" omits that the backend may keep running and holding locks (F11, F14) and that only a loss during `COMMIT` is uncertain. | Replace with the F11/F12 wording and point here.                                                                           |
| R3 (applied) | Sections 6 and 8     | A failed run does not report migrations committed earlier in the same invocation (F3).                                                                                                    | Add: "After any failure, read the ledger; do not infer state from the error."                                              |
| R4 (cross-referenced) | Sections 5 and 9     | No catalog-only state check; the existing checks can read zero rows under RLS.                                                                                                            | Add O2 and the signature table.                                                                                              |

### 9.2 Hardening proposals (code; each its own task and review)

| #   | Proposal                                                                                                                                                                                                                                       | Closes                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| H1  | **Implemented in F2.11 (`planMigrations`; unit and disposable-database tests), plus a contiguous-prefix check on the ledger.** Make the planner refuse an invocation in which a non-contract migration pending _before_ an allowed contract migration would run in the same call ("apply 0008 first, separately").                                                           | F4, scenario 1                           |
| H2  | In the runner: attach the `ROLLBACK` error as a secondary cause instead of replacing the original; on failure, include the versions already applied in this run; log distinctly when `COMMIT` was sent and its outcome is unknown.            | F2, F3, scenario 4                       |
| H3  | Set an `application_name` on the migrator session (an orphan is then trivially identifiable) and `client_connection_check_interval` (F11 showed it ends an orphan quickly on the test platform; Linux support to be confirmed).                | F11, scenario 4                          |
| H4  | Acquire the advisory lock with a bounded wait (`pg_try_advisory_lock` loop) and a clear message, so a retry behind an orphan fails fast instead of hanging.                                                                                      | F5, scenario 4                           |
| H5  | A read-only `verify` command that computes the O2 signature (and a schema fingerprint) against the repository and fails when the ledger and the schema disagree.                                                                              | F10, scenario 6                          |
| H6  | A disposable-database test for connection loss: terminate the migrator backend mid-migration (as `migration-contract.test.ts` injects errors), assert the lock behaviour and the post-state, and that a retry after the orphan ends succeeds.    | F18                                      |
| H7  | Measure lock-hold time of 0008 and 0009 on a restored production-shaped copy. A shorter-lock design for 0009 (`ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT`) is a **design change to an unapplied migration** to evaluate only after measurement [PG]. | Unmeasured lock times (scenarios 1-3)    |

---

## 10. Evidence, method and unknowns

**Executed for this document (all without a persistent database):**

- `planMigrations` evaluated against the real migration files with ledgers at 0007, 0008 and 0009 (F4).
- Throw-away embedded PostgreSQL 16.14 (macOS arm64; random port, temp data directory, deleted afterwards), driven by the
  repository's `startThrowawayPostgres`, `createBootstrappedDatabase` and `migrate`:
  - **E1:** the O2 query in S0, S1, S2 and a hand-made mixed state; a re-run on S2 (no-op); the runner on the mixed
    state (accepts it, F10).
  - **E2, E7:** a killed client with an open `ACCESS EXCLUSIVE` transaction and the advisory lock; the O3-O5 queries
    during the orphan; competing sessions (`55P03`); `pg_cancel_backend`; `client_connection_check_interval = '1s'`.
  - **E6:** `--allow-contract 0009` at 0007 with a failure injected into a copy of 0009 (F3); run at baseline `85a9e12`,
    before the phase rule (that command is now refused).
  - **E8:** identification of backfilled rows (F17) and absence of audit events.
  - **E9:** every `sql` block of this document, extracted and run verbatim (O1 in S0 and S2; O2 in S0, S1, S2; O3-O5
    against an orphan; O4 and O5 also on a pre-0008 database; the scenario 5 query returned exactly the two backfilled
    rows).
- `shasum -a 256` equals the runner's stored checksum for both migration files.

The experiment scripts were kept in a session scratch directory and are **not** part of the repository.

**Not verified / unknown:**

- Every SQL statement here has been run only on the throw-away server above, not on your server version, platform or
  roles; the platform for production is not defined in the repository (ADR-006 states PostgreSQL 15+).
- F11 used a `pg_sleep` as a stand-in for the migration's real statements, and `client_connection_check_interval`
  support is platform dependent; Linux behaviour is unconfirmed.
- Behaviour after failover, with replication lag, half-open connections (F13, F14) is from PostgreSQL documentation only.
- Lock-hold time of 0008 and 0009 on production-sized data.
- Role or database defaults for `lock_timeout`/`statement_timeout` on `app_migrator` in any real environment.
- Any consumer of `role_assignments.version` outside this repository; the full set of writers in a real deployment.
- Whether any persistent database contains CAMPUS/DEPARTMENT assignments, and the actual migration state of the
  persistent development database (never queried).
- A restore procedure: none exists in the repository and none has been exercised.
