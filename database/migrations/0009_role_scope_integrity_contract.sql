-- 0009_role_scope_integrity_contract
-- Owner: app_migrator
-- Milestone 2 / F2.1: Academic Structure Scope Integrity (Contract Phase).
--
-- CONTRACT MIGRATION: ENFORCED DEPLOYMENT GATE
--   The `_contract` suffix in this file's name designates it as a contract migration. tools/db/migrate.ts never
--   runs such a migration in an ordinary invocation (`pnpm db:migrate`, `pnpm dev:db`, CI deploy steps): the run
--   applies everything before it, stops here, applies nothing after it, and reports it as DEFERRED. It runs only
--   when an operator names this exact version:   pnpm db:migrate --allow-contract 0009
--   Required order (docs/architecture/v3/18-academic-structure-f21.md):
--     1. Release 0008 (expand) together with the application that writes campus_id / department_id next to
--        scope_id (RoleAssignmentService.grant).
--     2. Upgrade and DRAIN every writer of app.role_assignments (old instances, jobs, seed scripts) so that no
--        process still inserts a CAMPUS/DEPARTMENT assignment without its typed column.
--     3. Only then run the command above. After this migration the row-level check below rejects any
--        CAMPUS/DEPARTMENT assignment whose typed column is NULL, so a straggler writer fails closed.
--   The preflight below additionally refuses to run on inconsistent data (nothing is changed in that case).
--
-- BOUNDED LOCK WAIT (this does NOT replace the drain in step 2 above)
--   The migration needs ACCESS EXCLUSIVE locks on three tables, and a pending ACCESS EXCLUSIVE request makes every
--   later reader and writer of those tables queue behind it. It therefore sets `lock_timeout` to 5 seconds
--   (SET LOCAL: only for this migration's transaction, never the session) BEFORE the first lock. After the drain
--   the locks are free at once; 5 s rides out one short statement that was still finishing, and is short enough that
--   a stuck or forgotten transaction cannot stall the application behind the queue. If the locks cannot be taken in
--   time the statement fails with SQLSTATE 55P03 (lock_not_available), the whole transaction rolls back, nothing is
--   recorded in platform.schema_migrations and nothing has changed: find the blocking transaction (pg_stat_activity,
--   pg_blocking_pids), drain or end it, and run the command again. Without the drain a grant that is in flight can
--   also deadlock with this migration (the table lock order differs), so the bound is a safety net, not a plan.
--
-- WHY THE FIRST STATEMENTS TOUCH ROW LEVEL SECURITY
--   app.role_assignments, app.campuses and app.departments are FORCE ROW LEVEL SECURITY and their policies are
--   all `TO app_runtime`, so the table owner (app_migrator, the role that runs this file) sees ZERO rows through
--   normal queries. Without the bracket below the preflight would count nothing (and always pass) or, for the
--   campus/department existence checks, wrongly report every valid assignment as orphaned; the backfill would
--   update nothing; and ADD CONSTRAINT, which validates every row regardless of RLS, would then fail with an
--   opaque error on real data. The bracket is: NO FORCE (owner exempt) ... FORCE again (verified at the end).
--   It is one transaction under ACCESS EXCLUSIVE locks, app_runtime stays subject to RLS throughout, and any
--   failure rolls the whole file back, including the RLS changes.
--
-- Contents (in this order; nothing is modified before the preflight has passed):
--   1. Lock the tables and let the owner see their rows (metadata only; no row is read or written yet).
--   2. Preflight: validate EVERY invariant on ALL rows (any status). Fail closed with per-category counts.
--      Invalid rows are never deleted, revoked or rewritten by this migration.
--   3. Backfill the typed columns (derived from the already-validated scope_id).
--   4. Post-backfill verification of the final invariant.
--   5. Extend the immutability guard to campus_id / department_id.
--   6. Replace ra_scope_id_check with ra_scope_integrity_ck.
--   7. Restore FORCE ROW LEVEL SECURITY on all three tables and verify it.
--
-- Note: the backfill UPDATE fires app.touch_row(), so backfilled rows get a new updated_at and version + 1.

-- ---------------------------------------------------------------------------------------------
-- 1. Lock, and let the owner see the rows of the three tables for the duration of this transaction
-- ---------------------------------------------------------------------------------------------
SET LOCAL lock_timeout = '5s';
LOCK TABLE app.role_assignments, app.campuses, app.departments IN ACCESS EXCLUSIVE MODE;
ALTER TABLE app.role_assignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campuses         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.departments      NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- 2. Preflight: abort, changing nothing, if any assignment violates the target invariant
-- ---------------------------------------------------------------------------------------------
-- Target invariant (what ra_scope_integrity_ck will enforce):
--   ORGANIZATION: scope_id, campus_id, department_id all NULL
--   CAMPUS:       scope_id NOT NULL, the campus exists in the SAME organization, campus_id (if set) = scope_id,
--                 department_id NULL
--   DEPARTMENT:   scope_id NOT NULL, the department exists in the SAME organization, department_id (if set)
--                 = scope_id, campus_id NULL
-- The composite foreign keys ra_campus_fk / ra_department_fk (0008) already guarantee that a populated typed
-- column refers to a same-organization row; the checks below are still explicit so that the failure is a
-- readable diagnostic here rather than a constraint error later.
DO $$
DECLARE
  -- unknown scope type (impossible while the 0005 CHECK exists; verified rather than assumed)
  n_bad_scope_type          bigint;
  -- ORGANIZATION
  n_org_scope_id_set        bigint;
  n_org_campus_id_set       bigint;
  n_org_department_id_set   bigint;
  -- CAMPUS
  n_campus_scope_id_null    bigint;
  n_campus_not_found        bigint;
  n_campus_other_org        bigint;
  n_campus_typed_mismatch   bigint;
  n_campus_department_set   bigint;
  -- DEPARTMENT
  n_dept_scope_id_null      bigint;
  n_dept_not_found          bigint;
  n_dept_other_org          bigint;
  n_dept_typed_mismatch     bigint;
  n_dept_campus_set         bigint;
  n_total                   bigint;
BEGIN
  SELECT count(*) INTO n_bad_scope_type
    FROM app.role_assignments ra
   WHERE ra.scope_type IS NULL
      OR ra.scope_type NOT IN ('ORGANIZATION', 'CAMPUS', 'DEPARTMENT');

  -- ORGANIZATION
  SELECT count(*) INTO n_org_scope_id_set
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'ORGANIZATION' AND ra.scope_id IS NOT NULL;

  SELECT count(*) INTO n_org_campus_id_set
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'ORGANIZATION' AND ra.campus_id IS NOT NULL;

  SELECT count(*) INTO n_org_department_id_set
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'ORGANIZATION' AND ra.department_id IS NOT NULL;

  -- CAMPUS
  SELECT count(*) INTO n_campus_scope_id_null
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'CAMPUS' AND ra.scope_id IS NULL;

  SELECT count(*) INTO n_campus_not_found
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'CAMPUS'
     AND ra.scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.campuses c WHERE c.id = ra.scope_id);

  SELECT count(*) INTO n_campus_other_org
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'CAMPUS'
     AND ra.scope_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.campuses c
                  WHERE c.id = ra.scope_id AND c.organization_id <> ra.organization_id)
     AND NOT EXISTS (SELECT 1 FROM app.campuses c
                      WHERE c.id = ra.scope_id AND c.organization_id = ra.organization_id);

  SELECT count(*) INTO n_campus_typed_mismatch
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'CAMPUS'
     AND ra.campus_id IS NOT NULL
     AND ra.scope_id IS NOT NULL
     AND ra.campus_id <> ra.scope_id;

  SELECT count(*) INTO n_campus_department_set
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'CAMPUS' AND ra.department_id IS NOT NULL;

  -- DEPARTMENT
  SELECT count(*) INTO n_dept_scope_id_null
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'DEPARTMENT' AND ra.scope_id IS NULL;

  SELECT count(*) INTO n_dept_not_found
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'DEPARTMENT'
     AND ra.scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.id = ra.scope_id);

  SELECT count(*) INTO n_dept_other_org
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'DEPARTMENT'
     AND ra.scope_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.departments d
                  WHERE d.id = ra.scope_id AND d.organization_id <> ra.organization_id)
     AND NOT EXISTS (SELECT 1 FROM app.departments d
                      WHERE d.id = ra.scope_id AND d.organization_id = ra.organization_id);

  SELECT count(*) INTO n_dept_typed_mismatch
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'DEPARTMENT'
     AND ra.department_id IS NOT NULL
     AND ra.scope_id IS NOT NULL
     AND ra.department_id <> ra.scope_id;

  SELECT count(*) INTO n_dept_campus_set
    FROM app.role_assignments ra
   WHERE ra.scope_type = 'DEPARTMENT' AND ra.campus_id IS NOT NULL;

  n_total := n_bad_scope_type
           + n_org_scope_id_set + n_org_campus_id_set + n_org_department_id_set
           + n_campus_scope_id_null + n_campus_not_found + n_campus_other_org
           + n_campus_typed_mismatch + n_campus_department_set
           + n_dept_scope_id_null + n_dept_not_found + n_dept_other_org
           + n_dept_typed_mismatch + n_dept_campus_set;

  IF n_total > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = format(
        'Migration 0009 preflight failed: %s inconsistent row(s) in app.role_assignments (counts per category). '
        'unknown scope_type: %s. '
        'ORGANIZATION with scope_id set: %s, with campus_id set: %s, with department_id set: %s. '
        'CAMPUS with scope_id NULL: %s, campus not found: %s, campus in another organization: %s, '
        'campus_id differs from scope_id: %s, department_id set: %s. '
        'DEPARTMENT with scope_id NULL: %s, department not found: %s, department in another organization: %s, '
        'department_id differs from scope_id: %s, campus_id set: %s.',
        n_total, n_bad_scope_type,
        n_org_scope_id_set, n_org_campus_id_set, n_org_department_id_set,
        n_campus_scope_id_null, n_campus_not_found, n_campus_other_org,
        n_campus_typed_mismatch, n_campus_department_set,
        n_dept_scope_id_null, n_dept_not_found, n_dept_other_org,
        n_dept_typed_mismatch, n_dept_campus_set),
      DETAIL = 'No data was changed and the whole migration was rolled back. Rows of every status (ACTIVE, REVOKED, EXPIRED) are checked.',
      HINT = 'Inspect the offending rows with a database administrator account and correct them through an audited procedure (restore the missing campus/department or fix the assignment); this migration never deletes, revokes or rewrites them. Then re-run.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Backfill typed columns from the validated scope_id (only rows that still lack them)
-- ---------------------------------------------------------------------------------------------
-- app.role_assignments_guard() from 0006 compares user_id, role_id, scope_type, scope_id and valid_from only,
-- so this update passes it; the extended guard is installed afterwards.
UPDATE app.role_assignments
   SET campus_id = scope_id
 WHERE scope_type = 'CAMPUS' AND campus_id IS NULL;

UPDATE app.role_assignments
   SET department_id = scope_id
 WHERE scope_type = 'DEPARTMENT' AND department_id IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Post-backfill verification: no row may violate the final invariant (readable error, not a constraint error)
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  n_violations bigint;
BEGIN
  -- `IS NOT TRUE` (not NOT): a comparison against NULL is unknown, and an unknown must count as a violation.
  SELECT count(*) INTO n_violations
    FROM app.role_assignments ra
   WHERE (
     (ra.scope_type = 'ORGANIZATION' AND ra.scope_id IS NULL AND ra.campus_id IS NULL AND ra.department_id IS NULL) OR
     (ra.scope_type = 'CAMPUS' AND ra.scope_id IS NOT NULL AND ra.campus_id IS NOT NULL AND ra.campus_id = ra.scope_id AND ra.department_id IS NULL) OR
     (ra.scope_type = 'DEPARTMENT' AND ra.scope_id IS NOT NULL AND ra.department_id IS NOT NULL AND ra.department_id = ra.scope_id AND ra.campus_id IS NULL)
   ) IS NOT TRUE;
  IF n_violations > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = format('Migration 0009 post-backfill verification failed: %s row(s) in app.role_assignments still violate the scope invariant.', n_violations),
      DETAIL = 'The whole migration was rolled back.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Extend the immutability guard to campus_id and department_id
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.role_assignments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'role assignment user, role, scope and start are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'role assignment status is terminal once REVOKED or EXPIRED' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.role_assignments_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 6. Replace ra_scope_id_check with the strict relational check
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.role_assignments DROP CONSTRAINT ra_scope_id_check;

ALTER TABLE app.role_assignments
  ADD CONSTRAINT ra_scope_integrity_ck CHECK (
    (scope_type = 'ORGANIZATION' AND scope_id IS NULL AND campus_id IS NULL AND department_id IS NULL) OR
    (scope_type = 'CAMPUS' AND scope_id IS NOT NULL AND campus_id IS NOT NULL AND campus_id = scope_id AND department_id IS NULL) OR
    (scope_type = 'DEPARTMENT' AND scope_id IS NOT NULL AND department_id IS NOT NULL AND department_id = scope_id AND campus_id IS NULL)
  );

-- ---------------------------------------------------------------------------------------------
-- 7. Restore FORCE ROW LEVEL SECURITY (the owner is subject to the policies again) and verify the end state
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.role_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campuses         FORCE ROW LEVEL SECURITY;
ALTER TABLE app.departments      FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  n_unprotected bigint;
BEGIN
  SELECT count(*) INTO n_unprotected
    FROM pg_class c
   WHERE c.oid IN ('app.role_assignments'::regclass, 'app.campuses'::regclass, 'app.departments'::regclass)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF n_unprotected > 0 THEN
    RAISE EXCEPTION 'Migration 0009 must leave role_assignments, campuses and departments with ROW LEVEL SECURITY enabled and forced'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;
