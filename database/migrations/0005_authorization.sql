-- 0005_authorization
-- Owner: app_migrator

CREATE TABLE platform.permissions (
  code text PRIMARY KEY CHECK (char_length(code) BETWEEN 1 AND 100),
  sensitivity text NOT NULL CHECK (sensitivity IN ('NORMAL', 'SENSITIVE', 'CRITICAL'))
);

CREATE TABLE app.roles (
  id app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_org_code_uq UNIQUE (organization_id, code),
  CONSTRAINT roles_org_id_uq UNIQUE (organization_id, id)
);

CREATE TABLE app.role_permissions (
  organization_id app.uuid_v7 NOT NULL,
  role_id app.uuid_v7 NOT NULL,
  permission_code text NOT NULL REFERENCES platform.permissions (code) ON DELETE CASCADE,
  scope_mode text NOT NULL CHECK (scope_mode IN ('SELF', 'ASSIGNED', 'GRANTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, role_id, permission_code),
  CONSTRAINT rp_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT rp_role_fk FOREIGN KEY (organization_id, role_id) REFERENCES app.roles (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE app.role_assignments (
  id app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  user_id app.uuid_v7 NOT NULL,
  role_id app.uuid_v7 NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('ORGANIZATION', 'CAMPUS', 'DEPARTMENT')),
  scope_id app.uuid_v7,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ra_user_fk FOREIGN KEY (organization_id, user_id) REFERENCES app.users (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ra_role_fk FOREIGN KEY (organization_id, role_id) REFERENCES app.roles (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ra_scope_id_check CHECK (
    (scope_type = 'ORGANIZATION' AND scope_id IS NULL) OR
    (scope_type != 'ORGANIZATION' AND scope_id IS NOT NULL)
  )
);

-- Triggers for updated_at and immutability
CREATE TRIGGER roles_touch BEFORE UPDATE ON app.roles FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER roles_immutable BEFORE UPDATE ON app.roles FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER role_permissions_immutable BEFORE UPDATE ON app.role_permissions FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER role_assignments_touch BEFORE UPDATE ON app.role_assignments FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER role_assignments_immutable BEFORE UPDATE ON app.role_assignments FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- Seed platform permissions
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('session.read', 'NORMAL'),
  ('session.revoke', 'NORMAL'),
  ('session.revoke_any', 'SENSITIVE'),
  ('student.profile.read', 'SENSITIVE'),
  ('student.profile.read_sensitive', 'SENSITIVE'),
  ('student.profile.update', 'SENSITIVE'),
  ('attendance.session.read', 'NORMAL'),
  ('attendance.session.mark', 'SENSITIVE'),
  ('org.department.manage', 'SENSITIVE'),
  ('org.campus.manage', 'SENSITIVE'),
  ('org.settings.read', 'NORMAL'),
  ('role.assignment.grant', 'CRITICAL'),
  ('role.assignment.revoke', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- RLS
ALTER TABLE platform.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_assignments ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform.permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_assignments FORCE ROW LEVEL SECURITY;

-- Grants
GRANT SELECT ON platform.permissions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.roles TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.role_permissions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.role_assignments TO app_runtime;

-- Policies for platform.permissions (global read)
CREATE POLICY permissions_select ON platform.permissions AS PERMISSIVE FOR SELECT TO app_runtime USING ('catalog' = 'catalog');

-- Policies for app.roles
CREATE POLICY roles_select_tenant ON app.roles AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY roles_insert_tenant ON app.roles AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id());
CREATE POLICY roles_update_tenant ON app.roles AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY roles_delete_tenant ON app.roles AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id());

-- Policies for app.role_permissions
CREATE POLICY rp_select_tenant ON app.role_permissions AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY rp_insert_tenant ON app.role_permissions AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id());
CREATE POLICY rp_update_tenant ON app.role_permissions AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY rp_delete_tenant ON app.role_permissions AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id());

-- Policies for app.role_assignments
CREATE POLICY ra_select_tenant ON app.role_assignments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY ra_insert_tenant ON app.role_assignments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id());
CREATE POLICY ra_update_tenant ON app.role_assignments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id());
CREATE POLICY ra_delete_tenant ON app.role_assignments AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id());

CREATE INDEX role_permissions_permission_code_idx ON app.role_permissions(permission_code);
CREATE INDEX role_assignments_user_idx ON app.role_assignments(organization_id, user_id);
CREATE INDEX role_assignments_role_idx ON app.role_assignments(organization_id, role_id);


