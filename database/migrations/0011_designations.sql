-- 0011_designations
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: Organization Designations
--
-- Contents:
--  * app.designations: Academic, administrative, and teaching staff designations.
--    Pre-requisite for app.employees (Milestone 1 People slice).

CREATE TABLE app.designations (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  code            text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  category        text        NOT NULL CHECK (category IN ('TEACHING', 'NON_TEACHING', 'ADMIN')),
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT designations_org_code_uq UNIQUE (organization_id, code),
  CONSTRAINT designations_org_id_uq   UNIQUE (organization_id, id)
);

CREATE INDEX designations_org_status_ix ON app.designations (organization_id, status);

CREATE TRIGGER designations_touch BEFORE UPDATE ON app.designations
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER designations_immutable BEFORE UPDATE ON app.designations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.designations FORCE  ROW LEVEL SECURITY;

CREATE POLICY designations_tenant_select ON app.designations AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY designations_tenant_insert ON app.designations AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY designations_tenant_update ON app.designations AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY designations_staff_insert ON app.designations AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY designations_staff_update ON app.designations AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.designations TO app_runtime;
GRANT UPDATE (name, category, status) ON app.designations TO app_runtime;
