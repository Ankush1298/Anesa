-- 0017_students_record_fields
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students slice, Phase 1 (schema and authorization foundation).
-- Specification: docs/architecture/v3/02 §4.4 and §6.1 (students), 10 §1 row 26 (student.record.create),
--                21-students.md (this slice's decisions and deviations).
--
-- EXPAND step of an expand/contract pair. The matching CONTRACT step (NOT NULL on the two new columns) is a LATER
-- migration, gated by the runner's `_contract` rule, and is NOT part of this file. Nothing here reads, updates or
-- backfills a student row, so this migration needs no `NO FORCE ROW LEVEL SECURITY` bracket and does not touch
-- row security on any table.
--
-- Contents:
--  * app.students.admission_date (doc 02: required). Added NULLABLE, NO default: existing rows are NOT given an
--    invented historical date. See the CHECK ... NOT VALID below.
--  * app.students.status_changed_at (doc 02: required). Added NULLABLE with no default, and only THEN given a
--    default, so existing rows stay NULL instead of being silently stamped with the time of this migration.
--  * CHECK (... IS NOT NULL) NOT VALID on both columns: PostgreSQL enforces a NOT VALID check on every INSERT and on
--    every new row version, but does not examine rows that already exist. New and updated rows must therefore
--    carry both values, while legacy rows stay NULL until an operator-approved backfill and the contract step.
--    A legacy row that still has a NULL is therefore also refused any UPDATE (for example a status change) until
--    it is backfilled. That is intended: fail closed rather than carry on with an incomplete record.
--    (Behaviour per the PostgreSQL documentation; proving it on a disposable database is part of the
--    migration tests, tests/integration/migration-0017.test.ts.)
--  * app.students_guard(): BEFORE UPDATE trigger function. admission_number can never change (doc 02: "immutable
--    once set"; a correction is a future audited function, not a runtime UPDATE), and status_changed_at is stamped
--    whenever status changes.
--  * Least privilege: app_runtime loses UPDATE (user_id, admission_number). Re-pointing a student to another
--    account has no service in this slice and needs one (permission, reason, identity and exclusivity checks, audit)
--    before it may be granted again. The UPDATE (status) column grant from 0003 is KEPT for the status workflow
--    (a later phase), and is made safe by the STAFF-only policy below.
--  * RESTRICTIVE UPDATE policy: only a STAFF actor can update a student row. A STUDENT actor keeps SELECT on their
--    own row (students_student_self is unchanged) but can no longer update it, so a student cannot change their own
--    status. Tenant isolation, the student-self read policy and every other policy are untouched.
--  * platform.permissions: student.record.create (doc 10 row 26). Granted to roles by seedTenantRoles.
--
-- Deliberately NOT here (recorded, not silently resolved; see docs/architecture/v3/21-students.md):
--  * registration_number, merged_into_student_id and the (organization_id, status) index: nothing in this slice
--    writes or queries them.
--  * A history table (doc 02 marks students A2): same reading as employees and doc 08, the audit event with a
--    mandatory reason carries the old/new diff.
--  * NOT NULL on admission_date / status_changed_at, and any backfill: a later, operator-gated contract migration.
--  * Automatic admission numbers: Phase 1 numbers are administrator-supplied (format enforced by the service).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Columns. Order matters: the default is attached AFTER the column exists, so legacy rows are not stamped.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.students ADD COLUMN admission_date    date;
ALTER TABLE app.students ADD COLUMN status_changed_at timestamptz;
ALTER TABLE app.students ALTER COLUMN status_changed_at SET DEFAULT now();

ALTER TABLE app.students
  ADD CONSTRAINT students_admission_date_ck    CHECK (admission_date IS NOT NULL) NOT VALID;
ALTER TABLE app.students
  ADD CONSTRAINT students_status_changed_at_ck CHECK (status_changed_at IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- Update guard (SECURITY INVOKER, VOLATILE, search_path pinned, EXECUTE revoked from PUBLIC: repo convention)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.students_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.admission_number IS DISTINCT FROM OLD.admission_number THEN
    RAISE EXCEPTION 'student admission number is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.students_guard() FROM PUBLIC;

CREATE TRIGGER students_guard_upd BEFORE UPDATE ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.students_guard();

-- ---------------------------------------------------------------------------------------------
-- Privileges and row security
-- ---------------------------------------------------------------------------------------------
REVOKE UPDATE (user_id, admission_number) ON app.students FROM app_runtime;

CREATE POLICY students_staff_update ON app.students AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- ---------------------------------------------------------------------------------------------
-- Permission (doc 10 §1 row 26). Same upsert convention as 0010-0015.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.record.create', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
