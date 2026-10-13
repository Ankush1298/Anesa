-- 0016_person_record_exclusivity
-- Owner: app_migrator
-- X1 / FU-EMP-5: within one organization a user account may hold a student record OR an employee record, never both
-- (docs/architecture/v3/20-employees.md, ADR-003 amendment). actor_kind is derived from the students mapping, so a
-- user holding both would be a STUDENT actor that can never exercise its staff permissions.
--
-- Mechanism: one trigger function, attached to
--   * BEFORE INSERT ON app.students,
--   * BEFORE INSERT ON app.employees,
--   * BEFORE UPDATE OF user_id ON app.students (only when user_id actually changes; employees.user_id is not
--     updatable at runtime, and employee_code/user_id are immutable by privilege). Since migration 0017 the runtime
--     role cannot update students.user_id either, so this UPDATE path is reachable only by privileged sessions
--     (superuser, a future audited service role): defence in depth, not a runtime path.
-- It takes a transaction-scoped advisory lock keyed on (organization_id, user_id), then looks for a row for the same
-- account in the OTHER table. Two concurrent writers for one account therefore serialise on the lock: the second
-- one runs its check after the first has committed (or rolled back) and sees the outcome. Without the lock both
-- checks would run on snapshots that cannot see each other and both inserts would succeed.
--
-- Design points (each verified against 0001-0015):
--  * SECURITY INVOKER on purpose. FORCE RLS applies to the owner app_migrator too and, unlike app.users
--    (users_context_probe), neither table has an owner probe policy, so a SECURITY DEFINER function owned by
--    app_migrator would see ZERO rows and silently pass. Running as the writer is correct because every permitted
--    write to these tables needs a STAFF actor in the tenant (students_no_student_insert, employees_staff_insert and,
--    for the few columns the runtime role may still update, the STAFF-only students_staff_update policy added by
--    0017; before 0017 the students_student_self WITH CHECK played that part), and exactly that context sees every row
--    of both tables.
--    LIMIT: a session whose RLS hides the other table is also one whose own write RLS refuses, so no permitted write
--    can be checked blind. A superuser/BYPASSRLS role sees all rows and is checked correctly.
--  * VOLATILE (the default, required for a trigger that locks): under READ COMMITTED every statement in a volatile
--    function takes a fresh snapshot, which is what lets the waiter see the first transaction's commit after the
--    lock is granted. LIMIT: under REPEATABLE READ/SERIALIZABLE the snapshot predates the lock wait, the check can
--    miss the other row, and the check is NOT reliable. Database.withTenant uses the default READ COMMITTED.
--  * search_path = pg_catalog (repo convention for every function); all references are schema-qualified.
--  * Lock ordering: at most ONE advisory lock per trigger firing, always taken first in the trigger, on a
--    string-derived 64-bit hash key (text prefix). Hash collisions are possible, including in principle with the
--    runner (727301001) and bootstrap (727301002) keys; a collision only adds contention (an unrelated writer
--    waits), and never bypasses the check, which compares the exact organization_id and user_id. The lock is
--    taken after the row-level locks the writers already hold (users FOR SHARE in EmployeeService, the students
--    row lock a BEFORE UPDATE trigger runs under), and nothing waits for an advisory lock while holding the lock of
--    a different key in the same statement. A privileged session that repoints several students can still take several
--    advisory locks in an order another such transaction reverses; PostgreSQL then reports 40P01 (deadlock), never
--    a wrong answer.
--  * SQLSTATE 23P01 (exclusion_violation) with CONSTRAINT = person_record_exclusive: the closest standard class for
--    "this row excludes that row", and distinct from 23505 (unique) so callers can map it unambiguously.
--
-- NOT covered (recorded, not silently resolved): a superuser or app_migrator running with triggers disabled
-- (session_replication_role = replica) or after DROP TRIGGER; pre-existing data (a database that already holds a
-- user with both records is not rejected by this migration, it only prevents new violations); records of the same
-- user in DIFFERENT organizations (they are different accounts: users are tenant-scoped).

CREATE FUNCTION app.enforce_person_record_exclusive() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  clash boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'app.person_record_exclusive:' || NEW.organization_id::text || ':' || NEW.user_id::text, 0));

  IF TG_TABLE_NAME = 'students' THEN
    SELECT EXISTS (SELECT 1 FROM app.employees AS e
                    WHERE e.organization_id = NEW.organization_id AND e.user_id = NEW.user_id) INTO clash;
  ELSE
    SELECT EXISTS (SELECT 1 FROM app.students AS s
                    WHERE s.organization_id = NEW.organization_id AND s.user_id = NEW.user_id) INTO clash;
  END IF;

  IF clash THEN
    RAISE EXCEPTION 'a user cannot hold both a student and an employee record in one organization'
      USING ERRCODE = 'exclusion_violation',
            CONSTRAINT = 'person_record_exclusive',
            SCHEMA = 'app',
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.enforce_person_record_exclusive() FROM PUBLIC;

CREATE TRIGGER students_person_exclusive_ins BEFORE INSERT ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.enforce_person_record_exclusive();

CREATE TRIGGER students_person_exclusive_upd BEFORE UPDATE OF user_id ON app.students
  FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION app.enforce_person_record_exclusive();

CREATE TRIGGER employees_person_exclusive_ins BEFORE INSERT ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.enforce_person_record_exclusive();
