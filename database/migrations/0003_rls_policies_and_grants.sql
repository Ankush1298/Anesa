-- 0003_rls_policies_and_grants
-- Row Level Security for every tenant table, plus least-privilege grants for app_runtime.
--
-- Design notes (see docs/architecture/v3/13-database-isolation-invariants.md):
--  * ENABLE + FORCE ROW LEVEL SECURITY: the table owner (app_migrator) is subject to policies too.
--    Without FORCE an owner silently bypasses RLS. A role with no applicable policy sees nothing.
--  * Policies are scoped TO app_runtime and written per command (SELECT/INSERT/UPDATE/DELETE).
--  * PERMISSIVE policies grant tenant access; RESTRICTIVE policies narrow it for students.
--  * Everything fails closed: missing / malformed context => NULL => predicate false.

-- ---------------------------------------------------------------------------------------------
-- Context verification probe
-- ---------------------------------------------------------------------------------------------
-- True only if the transaction context names a well-formed tenant, a valid actor kind, and an ACTIVE
-- user that belongs to that tenant. SECURITY DEFINER (owner: app_migrator) so it can look the user up
-- without recursing into the users policy; the owner sees exactly one row, and only when invoked on
-- behalf of another session user (policy users_context_probe below). It returns a boolean only.
CREATE FUNCTION app.context_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT app.current_tenant_id() IS NOT NULL
     AND app.current_actor_kind() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM app.users AS u
       WHERE u.id = app.current_user_id()
         AND u.organization_id = app.current_tenant_id()
         AND u.status = 'ACTIVE'
     )
$$;
REVOKE ALL ON FUNCTION app.context_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.context_ok() TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- Enable and force RLS everywhere
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations      FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users              FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.students           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.students           FORCE  ROW LEVEL SECURITY;
ALTER TABLE app.student_guardians  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_guardians  FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------------
-- app.organizations  (read-only for the runtime role; provisioning is a platform operation)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY organizations_tenant_select ON app.organizations AS PERMISSIVE FOR SELECT TO app_runtime
  USING (id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- ---------------------------------------------------------------------------------------------
-- app.users
-- ---------------------------------------------------------------------------------------------
CREATE POLICY users_tenant_select ON app.users AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY users_tenant_insert ON app.users AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY users_tenant_update ON app.users AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY users_tenant_delete ON app.users AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Student actors: only their own account row; they can never create accounts.
CREATE POLICY users_student_self ON app.users AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND id = app.current_user_id()));
CREATE POLICY users_no_student_insert ON app.users AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Probe policy for the OWNER role: visible only when the owner is running a SECURITY DEFINER
-- function on behalf of a different session user, and only the single row that the (already
-- validated-for-format) context names. A direct login as app_migrator (session_user = current_user)
-- matches nothing, so FORCE RLS keeps the migration role blind to tenant data.
CREATE POLICY users_context_probe ON app.users AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text <> current_user::text
         AND id = app.current_user_id()
         AND organization_id = app.current_tenant_id()
         AND status = 'ACTIVE');
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(), app.current_actor_kind()
  TO app_migrator;

-- ---------------------------------------------------------------------------------------------
-- app.students
-- ---------------------------------------------------------------------------------------------
CREATE POLICY students_tenant_select ON app.students AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY students_tenant_insert ON app.students AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY students_tenant_update ON app.students AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Defence in depth: DELETE is not granted (students are never hard-deleted), but if it ever is, the
-- tenant boundary and the student boundary already apply.
CREATE POLICY students_tenant_delete ON app.students AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Student self isolation: the student identity is derived from the mapping students.user_id = the
-- authenticated user. No client-supplied student id is ever consulted.
CREATE POLICY students_student_self ON app.students AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()));
CREATE POLICY students_no_student_insert ON app.students AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- ---------------------------------------------------------------------------------------------
-- app.student_guardians  (student-owned protected data)
-- ---------------------------------------------------------------------------------------------
CREATE POLICY student_guardians_tenant_select ON app.student_guardians AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_guardians_tenant_insert ON app.student_guardians AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_guardians_tenant_update ON app.student_guardians AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_guardians_tenant_delete ON app.student_guardians AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- A student actor may only touch rows whose student_id is the student mapped to their own user.
-- The subquery runs under the students policies (so it can only ever return the actor's own row).
CREATE POLICY student_guardians_student_self ON app.student_guardians AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())));

-- ---------------------------------------------------------------------------------------------
-- Least-privilege grants for app_runtime (no TRUNCATE, REFERENCES, TRIGGER; no ownership)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON app.organizations TO app_runtime;

GRANT SELECT, INSERT ON app.users TO app_runtime;
GRANT UPDATE (email, display_name, status) ON app.users TO app_runtime;

GRANT SELECT, INSERT ON app.students TO app_runtime;
-- user_id is updatable on purpose: re-pointing a student to another login is a staff operation, and
-- the student-self RLS policy (not a missing privilege) must stop a student from using it.
GRANT UPDATE (user_id, admission_number, status) ON app.students TO app_runtime;

GRANT SELECT, INSERT, DELETE ON app.student_guardians TO app_runtime;
-- student_id is updatable on purpose, for the same reason as above.
GRANT UPDATE (student_id, full_name, phone, email, relation, is_primary) ON app.student_guardians TO app_runtime;
