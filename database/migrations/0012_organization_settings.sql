-- 0012_organization_settings
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: Organization Settings Registry
-- Specification: docs/architecture/v3/02 §4.2 (organization_settings), 08 (key registry in code),
-- 10 rows 18-19 (org.settings.read / org.settings.manage), 11 §5.4 (GET /settings, PUT /settings/{key}).
--
-- Contents:
--  * app.organization_settings: typed key/value per tenant. The registry of valid keys (type, schema, default) lives
--    in code (backend/src/shared/settings); the database stores only values a tenant administrator has chosen.
--    Organization-wide by design: the primary key is (organization_id, key), there is no campus or department column.
--  * platform.permissions: registers org.settings.manage (doc 10 row 19, CRITICAL). org.settings.read exists since 0006.
--
-- Deliberately NOT here: seeded default rows (defaults live in the code registry; a row is written only when an
-- administrator sets a value), a history table (the field-level old/new diff and the mandatory reason are kept in
-- app.audit_events), and any DELETE path (no hard delete is granted to the runtime role).

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('org.settings.manage', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

CREATE TABLE app.organization_settings (
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  key             text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  value           jsonb       NOT NULL CHECK (octet_length(value::text) <= 16384),
  updated_by      app.uuid_v7 NOT NULL,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_settings_pk PRIMARY KEY (organization_id, key),
  -- Same-tenant author: a setting can only be attributed to a user of its own organization.
  CONSTRAINT organization_settings_updated_by_fk FOREIGN KEY (organization_id, updated_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT
);

-- Every foreign key is supported by an index with the same leading columns (schema linter S-2).
CREATE INDEX organization_settings_updated_by_ix ON app.organization_settings (organization_id, updated_by);

CREATE TRIGGER organization_settings_touch BEFORE UPDATE ON app.organization_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER organization_settings_immutable BEFORE UPDATE ON app.organization_settings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY organization_settings_tenant_select ON app.organization_settings AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY organization_settings_tenant_insert ON app.organization_settings AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY organization_settings_tenant_update ON app.organization_settings AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Only STAFF sessions may write (a STUDENT session is refused by the database itself), as for campuses/designations.
-- LIMIT: which staff member may manage settings (org.settings.manage, organization scope) is decided by the
-- application's authorization engine; the database has no permission context and claims nothing about it.
CREATE POLICY organization_settings_staff_insert ON app.organization_settings AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY organization_settings_staff_update ON app.organization_settings AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Attribution cannot be forged: the author recorded on a row is always the session's own user (the same rule the
-- audit table applies to its actor column). An unset user makes the comparison NULL, which refuses the write.
CREATE POLICY organization_settings_author_insert ON app.organization_settings AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (updated_by = app.current_user_id());
CREATE POLICY organization_settings_author_update ON app.organization_settings AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK (updated_by = app.current_user_id());

-- Least privilege: read and create; after creation only the value and its author may change. organization_id and
-- key (the primary key) are fixed; version / updated_at are maintained by app.touch_row(). No DELETE, no TRUNCATE.
GRANT SELECT, INSERT ON app.organization_settings TO app_runtime;
GRANT UPDATE (value, updated_by) ON app.organization_settings TO app_runtime;
