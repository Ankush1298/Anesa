-- 0020_student_staff_role_exclusivity
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students slice: database backstop of the person-identity invariant
-- (docs/architecture/v3/21-students.md §6, 20-employees.md §3.1, 06 §7). New file; 0016-0019 are untouched.
--
-- INVARIANT. Within one organization an account that has a student record has NO staff-capable role assignment.
-- actor_kind is derived from the students mapping, so a student holding a staff role is a STUDENT actor whose staff
-- permissions can never be exercised. 0016 already makes student and employee records mutually exclusive.
--
-- STAFF-CAPABLE ASSIGNMENT (the one predicate; the services' SQL in AuthorizationEngine.hasStaffCapableAssignment and
-- the preflight in docs/runbooks/students-contract-rollout.md are written identically):
--     role code <> 'STUDENT'  AND  status = 'ACTIVE'  AND  (valid_until IS NULL OR valid_until > now())
--   * valid_from is IGNORED: a future-dated assignment becomes effective later without any write, so it conflicts now.
--   * REVOKED / EXPIRED rows and rows whose window has ended never conflict.
--   * Any role code but STUDENT counts (unknown or custom codes too: fail closed). A STUDENT-role assignment never
--     conflicts, whatever its window.
--   now() is the transaction start time, as everywhere else in the engine.
--
-- MECHANISM. Two trigger functions, both taking the SAME transaction-scoped advisory lock as 0016 (the key string
-- 'app.person_record_exclusive:' || organization_id || ':' || user_id hashed with hashtextextended(…, 0)):
--   * role_assignments (BEFORE INSERT, and BEFORE UPDATE OF valid_until when it changes): when the new row is a
--     staff-capable assignment and the user has a student record, raise 23P01 / person_record_exclusive. The UPDATE
--     path closes REVIVAL: the runtime role may extend valid_until (column grant from 0006), which would otherwise
--     reactivate an ended window with no insert.
--   * students (BEFORE INSERT, and BEFORE UPDATE OF user_id when it changes): when the user already has a
--     staff-capable assignment, raise 23P01 / person_record_exclusive.
-- The services take the same lock FIRST (shared/authorization/person-identity.ts), so for them the trigger's lock is
-- re-entrant. A privileged writer that does not take it first holds nothing but the lock itself when it waits, so no
-- deadlock cycle can include it. SQLSTATE and constraint name are those of 0016, so the existing 409 mappings apply.
--
-- Design points (same reasoning as 0016, re-verified for these tables):
--  * SECURITY INVOKER on purpose: every table here is FORCE RLS and has no owner probe policy for the migration owner, so
--    a SECURITY DEFINER function would see zero rows and pass silently. The permitted runtime writers are STAFF actors
--    of the tenant, which see every row of both tables. A STUDENT actor (who cannot insert role assignments anyway:
--    role_assignments_student_self) is checked first by this trigger and gets 23P01, because BEFORE ROW triggers run
--    before the RLS WITH CHECK; that session sees its own student row.
--  * VOLATILE plpgsql with the predicate INLINE (not a helper function): under READ COMMITTED every statement of a
--    volatile function takes a fresh snapshot, which lets the waiter see the first transaction's commit after the lock.
--    A STABLE helper would reuse the caller's snapshot and could miss it. NOT reliable under REPEATABLE READ or
--    SERIALIZABLE; Database.withTenant uses READ COMMITTED.
--  * search_path = pg_catalog; every reference is schema-qualified.
--
-- LIMITS (recorded, not hidden):
--  * Forward-only. Rows that already violate the invariant are NOT rejected or changed; run the read-only preflight in
--    docs/runbooks/students-contract-rollout.md first. There is no automatic remediation.
--  * Bypassed by a superuser or a session with session_replication_role = replica, or after DROP TRIGGER. The runtime
--    role can do none of these.
--  * The "a STUDENT role requires a student record" rule is a SERVICE rule of RoleAssignmentService.grant only.
--  * ROLLOUT DEPENDENCY: this file is not a *_contract file, but the runner defers every migration after a deferred
--    contract migration. 0020 therefore runs only after 0019: the database backstop is INACTIVE until
--    `pnpm db:migrate --allow-contract 0019` has been run (see docs/runbooks/students-contract-rollout.md). Until then
--    only the service checks protect the invariant.

CREATE FUNCTION app.enforce_student_staff_role_exclusive_on_assignment() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  assigned_role text;
  clash boolean;
BEGIN
  -- Rows that cannot be staff-capable need no lock: not active, or the window has ended.
  IF NEW.status <> 'ACTIVE' OR (NEW.valid_until IS NOT NULL AND NEW.valid_until <= pg_catalog.now()) THEN
    RETURN NEW;
  END IF;

  SELECT r.code INTO assigned_role
    FROM app.roles AS r
   WHERE r.organization_id = NEW.organization_id AND r.id = NEW.role_id;
  IF assigned_role = 'STUDENT' THEN
    RETURN NEW; -- the student's own role never conflicts (an unknown role, NULL, is treated as staff-capable)
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'app.person_record_exclusive:' || NEW.organization_id::text || ':' || NEW.user_id::text, 0));

  SELECT EXISTS (SELECT 1 FROM app.students AS s
                  WHERE s.organization_id = NEW.organization_id AND s.user_id = NEW.user_id) INTO clash;
  IF clash THEN
    RAISE EXCEPTION 'an account with a student record cannot hold a staff-capable role assignment'
      USING ERRCODE = 'exclusion_violation',
            CONSTRAINT = 'person_record_exclusive',
            SCHEMA = 'app',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.enforce_student_staff_role_exclusive_on_student() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  clash boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'app.person_record_exclusive:' || NEW.organization_id::text || ':' || NEW.user_id::text, 0));

  SELECT EXISTS (SELECT 1
                   FROM app.role_assignments AS ra
                   JOIN app.roles AS r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
                  WHERE ra.organization_id = NEW.organization_id AND ra.user_id = NEW.user_id
                    AND r.code <> 'STUDENT'
                    AND ra.status = 'ACTIVE'
                    AND (ra.valid_until IS NULL OR ra.valid_until > pg_catalog.now())) INTO clash;
  IF clash THEN
    RAISE EXCEPTION 'an account with a staff-capable role assignment cannot hold a student record'
      USING ERRCODE = 'exclusion_violation',
            CONSTRAINT = 'person_record_exclusive',
            SCHEMA = 'app',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.enforce_student_staff_role_exclusive_on_assignment(),
                       app.enforce_student_staff_role_exclusive_on_student() FROM PUBLIC;

CREATE TRIGGER role_assignments_student_exclusive_ins BEFORE INSERT ON app.role_assignments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_student_staff_role_exclusive_on_assignment();

CREATE TRIGGER role_assignments_student_exclusive_upd BEFORE UPDATE OF valid_until ON app.role_assignments
  FOR EACH ROW WHEN (OLD.valid_until IS DISTINCT FROM NEW.valid_until)
  EXECUTE FUNCTION app.enforce_student_staff_role_exclusive_on_assignment();

CREATE TRIGGER students_staff_role_exclusive_ins BEFORE INSERT ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.enforce_student_staff_role_exclusive_on_student();

CREATE TRIGGER students_staff_role_exclusive_upd BEFORE UPDATE OF user_id ON app.students
  FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION app.enforce_student_staff_role_exclusive_on_student();
