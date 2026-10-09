-- 0006_authorization_hardening
-- Owner: app_migrator
-- Follow-up to 0005 (append-only: an applied migration is never edited, its checksum is recorded).
--  * permission catalog: trimmed to the Slice-3 set of doc 10; global reference data, no RLS needed
--    (the constant-true policy of 0005 is removed rather than disguised)
--  * roles / role_permissions: read-only for app_runtime (changing the matrix is a migration/provisioning act)
--  * role_assignments: no DELETE (history is kept), only status/valid_until may change, terminal status,
--    valid window check, context_ok() + student-restrictive RLS like every other tenant table

-- ---------------------------------------------------------------------------------------------
-- platform.permissions: global, tenant-free reference data
-- ---------------------------------------------------------------------------------------------
DROP POLICY permissions_select ON platform.permissions;
ALTER TABLE platform.permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.permissions DISABLE ROW LEVEL SECURITY;

-- attendance.* is a reserved namespace (doc 10 §3) and student.profile.update is not in the catalog.
-- ON DELETE CASCADE removes any role_permissions row that referenced them.
DELETE FROM platform.permissions
 WHERE code IN ('attendance.session.read', 'attendance.session.mark', 'student.profile.update');

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('session.read', 'NORMAL'),
  ('session.revoke', 'NORMAL'),
  ('session.revoke_any', 'SENSITIVE'),
  ('student.profile.read', 'SENSITIVE'),
  ('student.profile.read_sensitive', 'SENSITIVE'),
  ('org.campus.manage', 'SENSITIVE'),
  ('org.department.manage', 'SENSITIVE'),
  ('org.settings.read', 'NORMAL'),
  ('role.assignment.grant', 'CRITICAL'),
  ('role.assignment.revoke', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- role_assignments integrity
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.role_assignments
  ADD CONSTRAINT ra_valid_window CHECK (valid_until IS NULL OR valid_until > valid_from);

-- Who/what/where/from-when never change; REVOKED and EXPIRED are terminal (no resurrection).
CREATE FUNCTION app.role_assignments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
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
CREATE TRIGGER role_assignments_guard BEFORE UPDATE ON app.role_assignments
  FOR EACH ROW EXECUTE FUNCTION app.role_assignments_guard();

-- ---------------------------------------------------------------------------------------------
-- Privileges: least privilege for app_runtime
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON app.roles FROM app_runtime;
REVOKE INSERT, UPDATE, DELETE ON app.role_permissions FROM app_runtime;
REVOKE UPDATE, DELETE ON app.role_assignments FROM app_runtime;
GRANT UPDATE (status, valid_until) ON app.role_assignments TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- Policies (replace the 0005 set; add context_ok() and the student boundary)
-- ---------------------------------------------------------------------------------------------
DROP POLICY roles_select_tenant ON app.roles;
DROP POLICY roles_insert_tenant ON app.roles;
DROP POLICY roles_update_tenant ON app.roles;
DROP POLICY roles_delete_tenant ON app.roles;
DROP POLICY rp_select_tenant ON app.role_permissions;
DROP POLICY rp_insert_tenant ON app.role_permissions;
DROP POLICY rp_update_tenant ON app.role_permissions;
DROP POLICY rp_delete_tenant ON app.role_permissions;
DROP POLICY ra_select_tenant ON app.role_assignments;
DROP POLICY ra_insert_tenant ON app.role_assignments;
DROP POLICY ra_update_tenant ON app.role_assignments;
DROP POLICY ra_delete_tenant ON app.role_assignments;

CREATE POLICY roles_tenant_select ON app.roles AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY role_permissions_tenant_select ON app.role_permissions AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY role_assignments_tenant_select ON app.role_assignments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY role_assignments_tenant_insert ON app.role_assignments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY role_assignments_tenant_update ON app.role_assignments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- A student actor sees only their own assignments and can never create or change one.
CREATE POLICY role_assignments_student_self ON app.role_assignments AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF');
