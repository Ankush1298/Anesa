# F2.1 — Academic structure foundation (campuses, departments, typed role scopes)

Migrations `0008_academic_structure.sql` (expand) and `0009_role_scope_integrity_contract.sql` (contract).
Code: `backend/src/shared/authorization/assignments.ts`, `backend/src/modules/organization/**`, `backend/tools/db/migrate.ts`.
Status: implemented; **database verification is recorded in the milestone report, not here.**

## Schema

| Object | Rules |
|---|---|
| `app.campuses` | `organization_id` FK; unique `(organization_id, code)`; `timezone` **required, no default**; `status` ACTIVE/INACTIVE; RLS enabled + forced; tenant policies for SELECT/INSERT/UPDATE; **restrictive staff-only** INSERT/UPDATE (`current_actor_kind() = 'STAFF'`); no DELETE policy or grant. |
| `app.departments` | composite FK `(organization_id, campus_id)` → campuses; optional parent in the **same campus**; soft delete (`deleted_at`); same policy set as campuses. |
| `role_assignments.campus_id / department_id` | 0008: nullable, composite same-tenant FKs. 0009: backfilled from `scope_id` and enforced by `ra_scope_integrity_ck` (ORGANIZATION: all three NULL; CAMPUS: `campus_id = scope_id`, no department; DEPARTMENT: `department_id = scope_id`, no campus). `role_assignments_guard()` makes both immutable (and keeps the 0006 terminal-status rule). |

The database knows only STUDENT vs STAFF. **Which** staff member may manage **which** campus is decided by the application (`org.campus.manage` with its scope); no policy claims otherwise.

### Runtime privileges (`app_runtime`)
* `campuses`: `SELECT, INSERT`; `UPDATE (name, address, status)`. Never updatable: `id`, `organization_id`, **`code`**, **`timezone`**.
* `departments`: `SELECT, INSERT`; `UPDATE (name, status, deleted_at)`. Never updatable: `id`, `organization_id`, `campus_id`, `parent_department_id`, `code`, `kind`.
* `version` / `updated_at` are maintained by `app.touch_row()` (a trigger writes `NEW`; it needs no column privilege). Limit: INSERT is table-wide, so an inserting client could set `created_at`/`version` (same as the other tables).

## Timezone policy
A campus timezone decides which calendar day a session belongs to.
* Accepted: `UTC` and `Area/Location` names that the **server's tz database lists** (`pg_timezone_names`), case-sensitive (`Asia/Kolkata`, `America/Argentina/Buenos_Aires`).
* Rejected: abbreviations and legacy single tokens (`IST`, `PST`, `EST`, `EST5EDT`, `CET`, `GMT`, **`Factory`**), POSIX offsets (`UTC+5`, `GMT+5:30`), the **`Etc/`** family (`Etc/GMT+5` has an inverted sign), and the **`posix/`** and **`right/`** duplicate trees. Verified on a real server: PostgreSQL itself *lists* `EST`, `EST5EDT`, `Etc/UTC`, `Etc/GMT+5`, so membership alone is not enough.
* Link names that tzdata still ships (`Asia/Calcutta`, `US/Pacific`) pass when the server knows them; PostgreSQL does not say which names are links. New campuses should use the canonical name.
* Where: `CampusService.create` (`src/modules/organization`), pre-filter in `timezone.ts` + membership query. **The database does not validate the identifier** (a `CHECK` cannot query `pg_timezone_names`, and a trigger would add an object to `app`); any writer that bypasses the service can store any 1–64 character string. A static test limits writers of `app.campuses` to the service.
* **Changing a timezone** is not possible through ordinary runtime access (no UPDATE privilege). A future change path must be explicitly authorised, audited, and must define the effect on existing sessions and attendance days.

## Role-assignment scope lifecycle
`RoleAssignmentService.grant` order: reason, scope shape, permission, no self-grant, user/role exist, role↔scope type, grantor's own scope (`assertMayManage`), **scope lifecycle (this section)**, duplicate check, INSERT (scope_id **and** the matching typed column), audit — one transaction.
* Grantable scope: campus ACTIVE; department not deleted, ACTIVE, and under an ACTIVE campus. Anything else (unknown, other tenant, inactive, soft-deleted) → the established `404 RESOURCE_NOT_FOUND`, only after the grantor was authorised for that scope.
* Existing assignments are never altered by a scope's deactivation and can still be revoked.
* **Proposed product rule** (not implemented): deactivating a campus/department could also require a decision about its active assignments (revoke, keep, or block). Today they stay valid.

### Locking and concurrency
* Convention for **every** writer of these tables: **campus row first, then department row, one row per statement.**
* The grant `FOR SHARE`-locks the campus, then (for a department) the department, and re-checks status under the lock. A status/soft-delete `UPDATE` (FOR NO KEY UPDATE) waits for the grant; under READ COMMITTED a waiting grant re-evaluates the row after the deactivation commits and is refused.
* The INSERT's foreign keys take only `FOR KEY SHARE`, which a status update does **not** conflict with — the explicit `FOR SHARE` is what provides the protection.
* Two grants only share-lock and never block each other. A deactivation that follows the order (campus before department) cannot form a cycle with a grant. A writer that locks the department first and then the campus **can** deadlock with a grant (PostgreSQL aborts one with `40P01`); the convention forbids it.
* Tests: `tests/integration/scope-locking.test.ts` (two real connections, both orderings).
* **Enrolment guards (Students Phase 3a, step 2B).** Deactivating (`status -> INACTIVE`) or soft-deleting a department, and moving a cohort away from `ACTIVE`, are refused with `409 CONFLICT` while an `ACTIVE` `app.student_programs` row references the department (`department_id`) or the cohort. Each check is a plain read run AFTER the writer took its own `FOR NO KEY UPDATE` lock and after authorization (so an unauthorized caller gets 403/404, never the conflict). It takes no lock above its own level, so the order campus -> department -> program -> cohort is unchanged and no cycle is possible. The future enrolment service share-locks department, program and cohort (each re-checked `ACTIVE`) before inserting: an opener that holds the share lock makes the deactivator wait and then see the committed enrolment (409); a deactivation that commits first leaves the opener with zero rows. Campuses and programs need no new check: a campus cannot be deactivated while it has an active department and a program cannot be deactivated while it has an active cohort. Only `ACTIVE` enrolments block; `ON_LEAVE` rows cannot be created yet (migration 0021). Tests: `tests/integration/enrolment-guards.test.ts`.

## Rollout (expand → drain → contract)
The runner treats a migration whose name ends in `_contract` as gated: an ordinary run applies everything before it, **stops at the first one, applies nothing after it, reports it as deferred**. Only `--allow-contract <exact version>` runs it (no environment variable, no wildcard; a wrong or non-contract version is an error before any migration SQL is sent). `pnpm dev:db` never authorises it.

**Phase boundary (F2.11).** On an existing database (non-empty ledger) a contract migration must be the **first** migration an invocation applies. `pnpm db:migrate --allow-contract 0009` while 0008 is still pending is refused by the planner before any migration SQL is sent (nothing is applied); the operator runs `pnpm db:migrate` first, deploys and drains, then names `0009`. An applied-versions list that is not a contiguous prefix `0001..N` is refused too. An empty ledger (a brand-new database: nothing deployed, no writer to drain) may be built in one pass. This exemption tests only the ledger, so it rests on one property of the migration files: the tables 0009 rewrites (`role_assignments`, `campuses`, `departments`) are created by a plain `CREATE TABLE` in the same pass, so a one-pass run reaches 0009 only if they did not pre-exist. A truncated or missing ledger on a populated database, a schema built by only some migrations, or a lone pre-existing table stops the pass at the first conflicting object (nothing in 0001-0009 uses `IF NOT EXISTS`). The ledger cannot prove that the application was deployed or the writers drained; that remains the operator's responsibility (steps 2-3 below). Each further contract migration needs its own invocation.

1. Release **0008** with the application build that writes `campus_id` / `department_id` (`pnpm db:migrate` — 0009 is reported as deferred).
2. Upgrade and **drain every writer** of `app.role_assignments`: old instances, background jobs, seed and import scripts.
3. Only then: `pnpm db:migrate --allow-contract 0009`.
4. 0009 locks the three tables, lets the owner see the rows (`NO FORCE` for the duration of the transaction; FORCE is restored and verified), runs a **fail-closed preflight with per-category counts** over rows of every status, backfills, verifies, extends the guard, swaps the constraint. Invalid legacy data (orphaned or cross-tenant scopes, contradictory typed ids, wrong-kind typed ids, unknown scope types) aborts the whole migration with nothing changed; it never repairs, revokes or deletes. Existing CAMPUS/DEPARTMENT assignments from before F2.1 reference campuses that did not exist, so a database that has any must be repaired by an administrator first.

## Verification map
| Property | Test |
|---|---|
| Gate logic (deferral, opt-in, wrong version, order, applied, drift) | `tests/unit/migrate-plan.test.ts` |
| Phase boundary (0007/0008/0009 ledgers, empty ledger, inconsistent ledgers) | `tests/unit/migrate-plan.test.ts`; end to end at 0007 in `tests/integration/migration-contract.test.ts` |
| Exemption cannot be abused (truncated/missing/partial ledger, partial schema, lone legacy table; a refusal sends no migration SQL) | `tests/integration/migration-contract.test.ts`; premise (plain `CREATE TABLE`) pinned in `tests/security/academic-structure-static.test.ts` |
| Gate against a database; blocked/ordered/failed contract migration | `tests/integration/migration-contract.test.ts` |
| 0009 success and six failure classes with full rollback comparison | `tests/integration/migration-contract.test.ts` |
| Grant dual-write, lifecycle 404s, ordering | `tests/integration/assignments.test.ts` |
| Concurrency | `tests/integration/scope-locking.test.ts` |
| Timezone shape / policy | `tests/unit/timezone.test.ts`, `tests/integration/campus.test.ts` |
| Privileges, policies, tenant isolation | `tests/security-db/academic-structure.test.ts`, `schema-linter`, `roles-and-privileges`, `authorization-rls` |
| Static migration/runner/writer gates | `tests/security/academic-structure-static.test.ts` |
