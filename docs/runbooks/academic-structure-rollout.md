# Academic structure rollout: migrations 0008 and 0009

Operator runbook for rolling out `database/migrations/0008_academic_structure.sql` (expand) and
`database/migrations/0009_role_scope_integrity_contract.sql` (contract).

**Status of this document.** Written from the repository's migration runner (`backend/tools/db/migrate.ts`,
`backend/tools/db/cli.ts`), the two SQL files, and `docs/architecture/v3/18-academic-structure-f21.md`. **No command or
SQL in it has been executed against any database by the author.** Every SQL statement below was written by reading the
schema; none has been run against a PostgreSQL server, so run them first in a non-production copy. Lock durations on
production-sized data have **not been measured**.

Nothing here replaces an approved change window. A separate, explicit approval is required before running either
migration against a persistent database.

---

## 1. Purpose and scope

| Migration                                  | Kind                  | What it does                                                                                                                                                                                        |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0008_academic_structure.sql`              | Prerequisite (expand) | Creates `app.campuses` and `app.departments`; adds nullable `campus_id` / `department_id` to `app.role_assignments` with composite foreign keys and two indexes. Keeps the old `ra_scope_id_check`. |
| `0009_role_scope_integrity_contract.sql`   | Gated contract        | Preflights all role-assignment rows, backfills the typed columns, extends `app.role_assignments_guard()`, replaces `ra_scope_id_check` with `ra_scope_integrity_ck`. Runs only on explicit opt-in.   |

The runner applies migrations in file order and never runs a migration whose name ends in `_contract` unless the
operator names its exact version with `--allow-contract`. An ordinary run applies everything before 0009, stops, and
reports 0009 as `DEFERRED`.

**Out of scope:** repairing data, creating a down migration, measuring lock times, production infrastructure (how the
runner is packaged or executed in production is not defined in this repository).

---

## 2. Deployment order

1. **0008 first, before the new application build.** The new build writes `campus_id` / `department_id` on every role
   grant (`backend/src/shared/authorization/assignments.ts:178`) and its organization services and routes query
   `app.campuses` / `app.departments`. Against a database without 0008 those statements fail. 0008 is written to be
   compatible with the _old_ writers too (the new columns are nullable and `ra_scope_id_check` is kept), which is what
   makes "migrate, then deploy" safe.
2. **Deploy the application build** that dual-writes `scope_id` and the typed column.
3. **Drain every legacy writer** of `app.role_assignments`: old application instances, background jobs, seed and import
   scripts, anything run by hand.
4. **0009 last**, and only after step 3 is proven. After 0009 the table rejects any CAMPUS/DEPARTMENT assignment whose
   typed column is NULL (SQLSTATE `23514`, check violation). A legacy writer that is still alive does not corrupt data;
   it starts failing. That is deliberate (fail closed), but it is an outage of role grants for that writer.

0009 must wait for the drain because it is the point of no return for old writers (see section 10), and because a
grant in flight can deadlock with the migration (the table lock order differs; see the 0009 header). The 5 second
`lock_timeout` in 0009 is a safety net, not a substitute for the drain.

---

## 3. Preflight checklist

All of these must be true before the first migration command. Record who confirmed each and when.

- [ ] **Approved maintenance/release window** with a named operator and a named approver. Expect lock waits (section 4).
- [ ] **Verified backup, and a restore procedure that has been exercised.** "A backup exists" is not enough: restore it
      somewhere disposable and check it. The repository contains no restore procedure; this one is yours to supply.
- [ ] **Known migration ledger state.** Run the ledger query in section 5.1. Before 0008 the ledger must show exactly
      `0001` to `0007`. `pnpm db:migrate` applies _every_ pending non-contract migration, so any other pending file would
      also run.
- [ ] **Correct target confirmed.** `pnpm db:migrate` reads `MIGRATION_DATABASE_URL` (and loads `../.env` if that file
      exists, via `--env-file-if-exists=../.env`). Confirm which server and database that URL points to _before_ running,
      for example with `psql` using the same URL and `SELECT current_database(), inet_server_addr(), inet_server_port();`
      (read-only). The runner refuses to run unless connected as `app_migrator`.
- [ ] **Monitoring and operator access.** A second session with permission to read `pg_stat_activity` and `pg_locks`
      for all roles (superuser or `pg_monitor`), able to run `pg_blocking_pids()`. Dashboards for error rate and p95 latency
      on the application during the window.
- [ ] **Inventory of every application instance, worker, cron job, seed/import script and admin tool** that can write
      `app.role_assignments`. In this repository the writers are `RoleAssignmentService.grant`
      (`backend/src/shared/authorization/assignments.ts`) and the dev seed (`backend/scripts/dev-seed-core.ts`, which
      writes only ORGANIZATION-scoped rows). Deployments may have others; the repository cannot enumerate them for you.
- [ ] **Session timeouts known.** As `app_migrator`, run `SHOW lock_timeout;` and `SHOW statement_timeout;` (read-only).
      The repository's bootstrap sets timeouts only for `app_runtime` (`backend/tools/db/bootstrap.ts`, 30 s statement,
      10 s lock); it sets none for `app_migrator`, but a DBA may have.
- [ ] **Rollback expectations agreed** with the approver: section 10. There is no down migration.

**Stop** if any box is unchecked.

---

## 4. Lock and availability risks

Read this before the window. These descriptions come from the SQL and the runner; they are not measurements.

**How the runner executes a migration.** Each migration file is sent as one multi-statement query between `BEGIN` and
`COMMIT`, and the `platform.schema_migrations` row is inserted before `COMMIT`. Any lock taken inside is therefore held
**until the whole file has finished**, not just until the statement that took it.

### 0008

- **No `lock_timeout` is set in 0008** (confirmed by reading the file). It will wait for locks indefinitely unless the
  `app_migrator` role or database has a default (check with `SHOW lock_timeout;`, section 3).
- `ALTER TABLE app.role_assignments ADD COLUMN ...` takes `ACCESS EXCLUSIVE` on `app.role_assignments`. Adding nullable
  columns without a default is a catalog change that does not rewrite the table, but the lock is still `ACCESS
EXCLUSIVE`, and because of the single transaction it is **held through the rest of 0008**: the two
  `ADD CONSTRAINT ... FOREIGN KEY` statements (PostgreSQL validates existing rows when adding a foreign key) and the two
  non-concurrent `CREATE INDEX` statements (each scans the table). Reads and writes of `app.role_assignments` stall for
  that whole span.
- The foreign keys also lock the referenced tables. PostgreSQL documents `ADD FOREIGN KEY` as taking `SHARE ROW
EXCLUSIVE` on both tables; this was not verified against a server here. The referenced tables are `app.campuses` and
  `app.departments`, which 0008 itself creates (so empty and unused), plus `app.organizations` for the inline foreign
  keys in the `CREATE TABLE` statements; treat `app.organizations` as write-blocked briefly.
- **Production lock-hold time has not been measured.** It scales with the size of `app.role_assignments`. Measure it on a
  restored copy of production data if the table is large.

### 0009

- Sets `SET LOCAL lock_timeout = '5s'` and then `LOCK TABLE app.role_assignments, app.campuses, app.departments IN ACCESS
EXCLUSIVE MODE`. If any lock cannot be acquired within 5 s it fails with SQLSTATE `55P03`, rolls back, records
  nothing. The timeout bounds the _waiting_, not the _running_ time: there is no `statement_timeout`, and the locks are
  then held until `COMMIT` while the migration runs the full-table preflight scans, two backfill `UPDATE`s, the constraint
  validation scan, and the `FORCE ROW LEVEL SECURITY` restore. **That duration is unmeasured.**
- The migration briefly turns `NO FORCE ROW LEVEL SECURITY` on the three tables (so the owner can see rows) and restores
  and verifies `FORCE` before commit. This is inside the same transaction as the `ACCESS EXCLUSIVE` locks;
  `app_runtime` stays subject to RLS throughout.

### Risk common to both: queueing

A lock request that has to wait **blocks every request that queues behind it**, including plain `SELECT`s that would
not conflict with the lock currently held. Concretely:

1. A long-running transaction (an open report, an idle-in-transaction session, a stuck job) holds a lock on
   `app.role_assignments`.
2. The migration asks for `ACCESS EXCLUSIVE` and waits behind it.
3. Every later query on that table (authorization checks read `app.role_assignments` on authenticated requests) queues
   behind the migration's pending request.
4. Latency climbs and connection pools fill. The application role has `lock_timeout = 10s` and `statement_timeout = 30s`
   (bootstrap), so individual requests fail with errors instead of waiting forever, but a saturated pool can still
   degrade unrelated endpoints.

For 0009 the 5 s `lock_timeout` caps this at about 5 s of queueing before the migration gives up. For 0008 **nothing
caps it** unless a role default exists. Neither migration is non-blocking; do not describe them that way.

Mitigations an operator can apply (none is performed by the repository): run in a low-traffic window; check for and end
or wait out long transactions first (section 5.2); in a second session watch for a stalled migration and be prepared to
cancel it (`pg_cancel_backend`) if request errors rise; if the table is large, rehearse on a restored copy first.

---

## 5. Read-only preflight

> **Everything in this section is read-only (`SELECT` / `SHOW` only).** None of it changes data. Run it with a
> database administrator account. Do not edit these statements into repairs.

### Which account to use (important)

`app.role_assignments`, `app.campuses` and `app.departments` are `FORCE ROW LEVEL SECURITY` and every policy is
`TO app_runtime`. **The table owner (`app_migrator`) and `app_runtime` outside a tenant context see zero rows.** A
count run as either of those will be `0` and look like a pass. Use a superuser or a role with `BYPASSRLS`, and check it:

```sql
-- READ-ONLY. Expect rolsuper or rolbypassrls = true. If both are false, the counts below are meaningless.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

-- READ-ONLY. Sanity check that you can see data; compare with what you expect for this environment.
SELECT count(*) AS role_assignment_rows FROM app.role_assignments;
```

### 5.1 Migration ledger

The runner creates and uses `platform.schema_migrations` (columns `version`, `name`, `checksum`, `applied_at`,
`applied_by`; defined in `backend/tools/db/migrate.ts`). The `checksum` is the SHA-256 of the file as applied; a
modified, already-applied migration is a hard error in the runner.

```sql
-- READ-ONLY.
SELECT version, name, checksum, applied_at, applied_by
  FROM platform.schema_migrations
 ORDER BY version;
```

Expected before 0008: versions `0001` through `0007` only. After 0008: `0001`-`0008`. After 0009: `0001`-`0009`. Anything
else, or a version missing from source control, **stop**: the runner will also refuse (`Database has migration ... that is
missing from source control`).

Not verified here: the exact permissions of the account you use on the `platform` schema.

### 5.2 Long transactions and blockers (before each migration)

```sql
-- READ-ONLY. Open transactions in this database, oldest first. Seeing other roles' rows needs superuser or pg_monitor.
SELECT pid, usename, application_name, state, xact_start, now() - xact_start AS xact_age,
       wait_event_type, wait_event, left(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = current_database()
   AND xact_start IS NOT NULL
   AND pid <> pg_backend_pid()
 ORDER BY xact_start;

-- READ-ONLY. Sessions currently holding or awaiting locks on the three tables.
SELECT l.pid, l.mode, l.granted, a.usename, a.state, a.xact_start, left(a.query, 120) AS query
  FROM pg_locks l
  JOIN pg_stat_activity a USING (pid)
 WHERE l.relation IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass)
   AND l.pid <> pg_backend_pid()
 ORDER BY l.granted, a.xact_start;
```

(`app.campuses` and `app.departments` do not exist before 0008; before 0008 remove them from the second query.) Any
transaction older than the lock wait you can tolerate, and any `idle in transaction` session, should be understood and
resolved _before_ starting. Ending a session is a decision for the approver, not part of this runbook.

### 5.3 Before 0008: what role assignments exist?

At version 0007 the typed columns do not exist, so only scope types can be inspected:

```sql
-- READ-ONLY. Run BEFORE 0008.
SELECT scope_type, status, (scope_id IS NULL) AS scope_id_is_null, count(*)
  FROM app.role_assignments
 GROUP BY scope_type, status, (scope_id IS NULL)
 ORDER BY scope_type, status, scope_id_is_null;
```

Any `CAMPUS` or `DEPARTMENT` rows here predate `app.campuses` / `app.departments`, so they cannot reference a real
campus or department. They **will** fail the 0009 preflight (category "campus not found" / "department not found") until
a database administrator resolves them through an audited procedure. This runbook does not provide that repair.

### 5.4 After 0008, before 0009: mirror of the 0009 preflight

These queries reproduce the fourteen categories that the 0009 preflight counts
(`0009_role_scope_integrity_contract.sql` lines 95-173), over rows of **every** status, using the same predicates.
**Every count must be `0` before you run 0009.** They need the 0008 columns, so run them only after 0008. They have not
been executed against a server; if one errors, fix the runbook rather than improvising.

```sql
-- READ-ONLY. Run AFTER 0008, as a role that bypasses RLS (see above). Expect n = 0 on every row.
SELECT 'unknown scope_type' AS category, count(*) AS n
  FROM app.role_assignments ra
 WHERE ra.scope_type IS NULL OR ra.scope_type NOT IN ('ORGANIZATION', 'CAMPUS', 'DEPARTMENT')
UNION ALL
SELECT 'ORGANIZATION with scope_id set', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'ORGANIZATION' AND ra.scope_id IS NOT NULL
UNION ALL
SELECT 'ORGANIZATION with campus_id set', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'ORGANIZATION' AND ra.campus_id IS NOT NULL
UNION ALL
SELECT 'ORGANIZATION with department_id set', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'ORGANIZATION' AND ra.department_id IS NOT NULL
UNION ALL
SELECT 'CAMPUS with scope_id NULL', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'CAMPUS' AND ra.scope_id IS NULL
UNION ALL
SELECT 'CAMPUS: campus not found', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'CAMPUS' AND ra.scope_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM app.campuses c WHERE c.id = ra.scope_id)
UNION ALL
SELECT 'CAMPUS: campus in another organization', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'CAMPUS' AND ra.scope_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.campuses c WHERE c.id = ra.scope_id AND c.organization_id <> ra.organization_id)
   AND NOT EXISTS (SELECT 1 FROM app.campuses c WHERE c.id = ra.scope_id AND c.organization_id = ra.organization_id)
UNION ALL
SELECT 'CAMPUS: campus_id differs from scope_id', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'CAMPUS' AND ra.campus_id IS NOT NULL AND ra.scope_id IS NOT NULL AND ra.campus_id <> ra.scope_id
UNION ALL
SELECT 'CAMPUS with department_id set', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'CAMPUS' AND ra.department_id IS NOT NULL
UNION ALL
SELECT 'DEPARTMENT with scope_id NULL', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'DEPARTMENT' AND ra.scope_id IS NULL
UNION ALL
SELECT 'DEPARTMENT: department not found', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'DEPARTMENT' AND ra.scope_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.id = ra.scope_id)
UNION ALL
SELECT 'DEPARTMENT: department in another organization', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'DEPARTMENT' AND ra.scope_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.departments d WHERE d.id = ra.scope_id AND d.organization_id <> ra.organization_id)
   AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.id = ra.scope_id AND d.organization_id = ra.organization_id)
UNION ALL
SELECT 'DEPARTMENT: department_id differs from scope_id', count(*)
  FROM app.role_assignments ra
 WHERE ra.scope_type = 'DEPARTMENT' AND ra.department_id IS NOT NULL AND ra.scope_id IS NOT NULL AND ra.department_id <> ra.scope_id
UNION ALL
SELECT 'DEPARTMENT with campus_id set', count(*)
  FROM app.role_assignments ra WHERE ra.scope_type = 'DEPARTMENT' AND ra.campus_id IS NOT NULL;
```

Rows that are _not_ errors for the preflight but that the backfill will rewrite (and that therefore bump `version` and
`updated_at`, see section 10) are CAMPUS/DEPARTMENT rows whose typed column is still NULL:

```sql
-- READ-ONLY. Rows 0009 will backfill. Not an error; expect this to be non-zero for rows written by legacy writers.
SELECT scope_type,
       count(*) FILTER (WHERE scope_type = 'CAMPUS'     AND campus_id     IS NULL) AS campus_rows_to_backfill,
       count(*) FILTER (WHERE scope_type = 'DEPARTMENT' AND department_id IS NULL) AS department_rows_to_backfill
  FROM app.role_assignments
 WHERE scope_type IN ('CAMPUS', 'DEPARTMENT')
 GROUP BY scope_type;
```

If you want the offending rows (not just counts), take the `WHERE` clause of the failing category above and select
`ra.id, ra.organization_id, ra.user_id, ra.role_id, ra.scope_type, ra.scope_id, ra.campus_id, ra.department_id, ra.status`
instead of `count(*)`. **Do not repair from this runbook.** Fix through an audited, separately reviewed procedure.

### 5.5 Drain evidence (heuristic, not proof)

The database cannot tell you which process wrote a row. A useful signal: after the new build is the only one deployed,
the number of CAMPUS/DEPARTMENT rows with a NULL typed column must stop growing.

```sql
-- READ-ONLY. Run now and again after a quiet interval. The count must not increase once only the new build runs.
SELECT count(*) AS legacy_shaped_rows, max(created_at) AS newest_created_at
  FROM app.role_assignments
 WHERE (scope_type = 'CAMPUS' AND campus_id IS NULL) OR (scope_type = 'DEPARTMENT' AND department_id IS NULL);
```

A stable count does **not** prove no legacy writer exists (it may simply not have granted anything). The proof is the
inventory in section 3 plus confirmation from your deployment system that old instances and jobs are stopped.

---

## 6. Apply 0008

**Do not run this until sections 3 and 5.1-5.3 are complete.** This block is a command to run in the window; it has
not been run by the author.

```bash
pnpm db:migrate
```

`pnpm db:migrate` resolves to `tsx --env-file-if-exists=../.env tools/db/cli.ts migrate` in `backend/` (root
`package.json` delegates with `pnpm --filter @campusos/backend run db:migrate`).

**Expected outcome**

- `migrate: applied [0008], already applied [0001, 0002, 0003, 0004, 0005, 0006, 0007]`
- followed by a warning that `0009` is `DEFERRED` and needs `--allow-contract 0009`; "Nothing after it was applied."
- exit code `0`; a ledger row for `0008` (section 9.1).

**Stop conditions**

- The command exits non-zero. The statement fails inside the transaction, which rolls back; the ledger gets no `0008`
  row. Capture the full error output, run the ledger query (5.1), and do not retry blindly.
- `applied` contains anything other than `0008`: an unexpected migration ran. Stop and investigate.
- Error `migrations must run as app_migrator`: wrong credentials. Stop.
- Error about checksum drift or a migration missing from source control: stop; this is a repository/ledger mismatch.
- Application error rate or latency rises while it runs, or the command is waiting on a lock for longer than you
  agreed: in a second session use `pg_blocking_pids()` (section 5.2) to see what it waits on. Cancelling is a decision for
  the operator and approver.
- Verification in section 9.1 fails.

---

## 7. Deploy and drain writers

1. **Only after 0008 is committed and 9.1 verifies**, deploy the application build that dual-writes `scope_id` and
   `campus_id` / `department_id`.
2. Stop every old instance, worker, job, seed/import script and manual tool that can write `app.role_assignments`
   (inventory from section 3). Confirm from the deployment platform, not from memory.
3. Re-run the section 5.4 queries (every row `0`) and the 5.5 query twice, a quiet interval apart.
4. Re-run 5.2 to confirm there are no long transactions.

**Stop** (do not proceed to 0009) if: any old instance or job is still running or cannot be accounted for; any 5.4
category is non-zero; the 5.5 count is still increasing; anyone cannot attest to the inventory.

---

## 8. Apply 0009

**Do not run this until section 7 is complete and the approver has confirmed the drain.** Not executed by the author.

```bash
pnpm db:migrate --allow-contract 0009
```

**There is no `--` between `db:migrate` and `--allow-contract`.** With the pinned pnpm (10.34.6), `pnpm db:migrate
--allow-contract 0009` forwards `--allow-contract 0009` to the CLI. The spelling `pnpm db:migrate -- --allow-contract
0009` forwards a literal `--`, which `backend/tools/db/cli.ts` does not recognise and rejects with a usage error and a
non-zero exit before connecting to any database (fail-closed). The pnpm forwarding behaviour was probed in F2.4 in a
scratch workspace; the CLI's own parsing was re-probed for F2.5 with no database environment (section 12). Both
`--allow-contract 0009` and `--allow-contract=0009` are accepted; the version must be exactly four digits and must name an
existing `*_contract` migration, otherwise the runner throws before running anything. There is no environment variable
or wildcard form.

**Expected outcome**

- `migrate: applied [0009], already applied [0001, ..., 0008]` and **no** `DEFERRED` warning; exit code `0`.
- Section 9 verification passes.

**Stop conditions and what they mean**

| Symptom                                                                              | Meaning                                                                                                                              | Action                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLSTATE `55P03` (`lock_not_available`)                                              | Could not take the `ACCESS EXCLUSIVE` locks in 5 s. Whole transaction rolled back; nothing recorded.                                 | Find the blocker (`pg_stat_activity`, `pg_blocking_pids`), let the approver decide how to resolve it, and re-run the command only after the drain is re-confirmed.                              |
| SQLSTATE `40P01` (deadlock)                                                          | A grant in flight deadlocked with the migration. Indicates a writer is still alive.                                                  | Rolled back. Re-do section 7; do not simply retry.                                                                                                                                              |
| `Migration 0009 preflight failed: N inconsistent row(s) ...` (SQLSTATE class `23`)   | Data violates the target invariant. The message lists a count per category (same categories as 5.4). Nothing was changed.            | Use 5.4 to see which rows. Repair is outside this runbook (audited procedure by a DBA). Re-run 5.4 until all zero, then re-run.                                                                  |
| `Migration 0009 post-backfill verification failed ...`                               | Rows still violate the invariant after backfill. Rolled back.                                                                        | Stop; escalate. Do not retry.                                                                                                                                                                   |
| `Migration 0009 must leave ... ROW LEVEL SECURITY enabled and forced`                | The end-state RLS check failed. Rolled back.                                                                                         | Stop; escalate.                                                                                                                                                                                 |
| Usage error (`usage: migrate [--allow-contract ...`)                                 | Argument not understood, for example the `--` spelling.                                                                              | Nothing ran. Fix the command.                                                                                                                                                                   |
| `allow-contract "..." : no contract migration with that exact version`               | Wrong version.                                                                                                                       | Nothing ran. Use `0009`.                                                                                                                                                                        |

Any failure **before `COMMIT`** rolls the whole file back, including the RLS changes (see section 10). Always confirm with
the ledger query that `0009` is absent before concluding that nothing changed.

---

## 9. Post-migration checks

All **READ-ONLY**. Run as a role that bypasses RLS where row counts matter (section 5).

### 9.1 After 0008

```sql
-- READ-ONLY. Ledger: 0008 present.
SELECT version, name, applied_at, applied_by FROM platform.schema_migrations ORDER BY version;

-- READ-ONLY. New tables and typed columns exist. Expect 2 tables and 2 columns.
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'app' AND table_name IN ('campuses', 'departments') ORDER BY table_name;
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema = 'app' AND table_name = 'role_assignments' AND column_name IN ('campus_id', 'department_id');

-- READ-ONLY. Foreign keys validated and indexes valid. Expect convalidated = true, indisvalid = true.
SELECT conname, convalidated FROM pg_constraint
 WHERE conrelid = 'app.role_assignments'::regclass AND conname IN ('ra_campus_fk', 'ra_department_fk', 'ra_scope_id_check');
SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('role_assignments_org_campus_ix', 'role_assignments_org_dept_ix');
```

At this point `ra_scope_id_check` must **still exist** (0008 keeps it).

### 9.2 After 0009

```sql
-- READ-ONLY. Ledger: 0009 present, applied_by = app_migrator.
SELECT version, name, applied_at, applied_by FROM platform.schema_migrations ORDER BY version;

-- READ-ONLY. Strict scope-integrity constraint: ra_scope_integrity_ck exists and is validated;
-- ra_scope_id_check is gone; the composite foreign keys remain.
SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'app.role_assignments'::regclass
   AND conname IN ('ra_scope_integrity_ck', 'ra_scope_id_check', 'ra_campus_fk', 'ra_department_fk')
 ORDER BY conname;
-- Expect: ra_campus_fk, ra_department_fk, ra_scope_integrity_ck (convalidated = true); NO ra_scope_id_check.

-- READ-ONLY. FORCE RLS state. Expect relrowsecurity = true AND relforcerowsecurity = true on all three.
SELECT c.oid::regclass::text AS table_name, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
 WHERE c.oid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass)
 ORDER BY 1;

-- READ-ONLY. Guard function now protects the typed columns. Expect both flags = true.
SELECT pg_get_functiondef('app.role_assignments_guard()'::regprocedure) LIKE '%NEW.campus_id IS DISTINCT FROM OLD.campus_id%' AS guards_campus_id,
       pg_get_functiondef('app.role_assignments_guard()'::regprocedure) LIKE '%NEW.department_id IS DISTINCT FROM OLD.department_id%' AS guards_department_id;

-- READ-ONLY. Typed-column consistency. Expect violations = 0 and rows_checked = the total from 5.3.
-- (This is the same predicate as ra_scope_integrity_ck; IS NOT TRUE counts NULL results as violations.)
SELECT count(*) FILTER (WHERE ((
         (scope_type = 'ORGANIZATION' AND scope_id IS NULL AND campus_id IS NULL AND department_id IS NULL) OR
         (scope_type = 'CAMPUS' AND scope_id IS NOT NULL AND campus_id IS NOT NULL AND campus_id = scope_id AND department_id IS NULL) OR
         (scope_type = 'DEPARTMENT' AND scope_id IS NOT NULL AND department_id IS NOT NULL AND department_id = scope_id AND campus_id IS NULL)
       )) IS NOT TRUE) AS violations,
       count(*) AS rows_checked
  FROM app.role_assignments;
```

Also re-run the section 5.4 queries: every count must still be `0`.

### 9.3 Application behaviour

With the deployed build, as an authorized test staff user in a **non-production tenant** if one exists: grant a
CAMPUS-scoped role and a DEPARTMENT-scoped role (the typed column must be populated by the application) and confirm the
application error rate is normal. Do not create test data in a real tenant without the approver's consent.

### 9.4 Tests to run afterwards (disposable environment only)

The repository's database-backed tests start their own throw-away PostgreSQL (or use `TEST_DATABASE_URL` pointing at a
disposable server). **Never point them at the production or any persistent database.**

```bash
# Static gates and unit tests (no database):
pnpm --filter @campusos/backend exec vitest run --project unit --project security

# Database-backed, disposable environment only:
pnpm --filter @campusos/backend exec vitest run tests/integration/migration-contract.test.ts
pnpm --filter @campusos/backend exec vitest run tests/integration/scope-locking.test.ts
pnpm --filter @campusos/backend exec vitest run tests/integration/assignments.test.ts
pnpm --filter @campusos/backend exec vitest run tests/security-db/academic-structure.test.ts
```

These validate the migration logic on a throw-away database. They do not validate your production data or production
lock behaviour.

---

## 10. Failure and rollback limits

**Before commit.** Each migration runs in one transaction (`BEGIN` ... `COMMIT`) together with its ledger row. Any error
during the file, including `55P03`, a failed preflight, or a failed verification, rolls everything back: DDL, backfills,
the RLS `NO FORCE`/`FORCE` toggles, and the ledger row. Rollback of injected failures for 0009 is exercised by
`tests/integration/migration-contract.test.ts` (on a disposable database). After any failure, confirm with the ledger
query (5.1) that the version is absent. If the connection is lost mid-run, PostgreSQL aborts the open transaction; verify
the same way. Do not assume.

**After commit.** There is **no down migration for 0008 or 0009** in this repository
(`database/migrations/` contains forward files only). The repository provides no rollback command, and this runbook does
not invent one.

- **After 0008:** the schema change is additive and old writers keep working, so rolling the _application_ back to a
  pre-F2 build is expected to be safe. The new tables and columns remain. Removing them would be a destructive change
  that needs its own reviewed forward migration.
- **After 0009:**
  - `ra_scope_id_check` is gone and `ra_scope_integrity_ck` enforces typed columns. A legacy writer that inserts a
    CAMPUS/DEPARTMENT row without the typed column now fails with SQLSTATE `23514`. Rolling the application back to
    such a build breaks role grants at those scopes.
  - The backfill updated every CAMPUS/DEPARTMENT row that lacked its typed column, which fired `app.touch_row()`:
    **`version` was incremented and `updated_at` changed on those rows.** Any client holding an old `version` for one of
    these assignments will see a version mismatch. This cannot be undone by the repository.
  - Reverting the constraint and guard requires a **new forward migration** (not written; it would need design and
    review). Alternatively a **separately rehearsed recovery plan** such as a restore from backup, which discards every
    write since that backup. Neither exists in the repository today; do not promise either to stakeholders.
- Invalid data found by the preflight is never deleted, revoked or rewritten by the migration.

If a problem is discovered after commit: stop further rollout, keep the evidence (ledger, section 9 outputs, logs),
escalate to the approver, and decide between a forward fix and a restore plan. Do not improvise destructive SQL.

---

## 11. Operator sign-off checklist

Each gate is a hard stop. If a gate fails, **stop, do not continue to the next gate**, and escalate to the approver.

**Gate A: before 0008**

- [ ] Window approved; approver and operator named.
- [ ] Backup taken and restore procedure exercised (not just "exists").
- [ ] Ledger shows exactly `0001`-`0007` (5.1).
- [ ] Target database confirmed; `app_migrator` credentials in use.
- [ ] No unexplained long or idle-in-transaction sessions (5.2).
- [ ] Writer/instance/job inventory completed (section 3).
- [ ] `SHOW lock_timeout` / `statement_timeout` for `app_migrator` recorded.

**Gate B: after 0008**

- [ ] Exit code `0`; `applied [0008]`; 0009 reported `DEFERRED`.
- [ ] Section 9.1 checks pass (including `ra_scope_id_check` still present).
- [ ] No application error spike during the run.

**Gate C: before 0009**

- [ ] New application build deployed and healthy.
- [ ] Every legacy writer stopped and attested by the deployment owner (7).
- [ ] All section 5.4 counts are `0` (as a role that bypasses RLS).
- [ ] 5.5 count not increasing across a quiet interval.
- [ ] No long or idle-in-transaction sessions (5.2).
- [ ] Rollback limits (section 10) acknowledged by the approver, in writing.
- [ ] Fresh backup or confirmation the earlier one is still current enough.

**Gate D: after 0009**

- [ ] Command used was exactly `pnpm db:migrate --allow-contract 0009` (no `--`); exit code `0`; `applied [0009]`.
- [ ] Section 9.2 checks pass: ledger, `ra_scope_integrity_ck` validated, no `ra_scope_id_check`, FORCE RLS on all three,
      guard flags true, `violations = 0`.
- [ ] Application healthy; grant at CAMPUS and DEPARTMENT scope behaves correctly (9.3).
- [ ] Disposable-environment tests from 9.4 have been run (or scheduled) against the same revision.
- [ ] Results recorded: who, when, outputs of each check.

---

## 12. Evidence and unknowns

**Verified by the author (no database involved):** the CLI parsing behaviour in section 8 was probed by running
`backend/tools/db/cli.ts migrate ...` with an empty environment and no `.env`. `-- --allow-contract 0009` produced the
usage error (exit 1); `--allow-contract 0009` and `--allow-contract=0009` passed argument parsing and stopped at
`MIGRATION_DATABASE_URL is not set` (exit 1); a missing or malformed version produced the usage error.

**Not verified / unknown:**

- Lock-hold durations of 0008 and 0009 on production-sized data.
- Whether production has role/database defaults for `lock_timeout` or `statement_timeout` on `app_migrator`.
- Whether the SQL in sections 5 and 9 runs without modification on your server version (never executed).
- How the runner is packaged and invoked in production (this repository only defines the `pnpm` scripts).
- The full set of writers of `app.role_assignments` in your deployment.
- Any CAMPUS/DEPARTMENT role assignments in the target database (never queried).
