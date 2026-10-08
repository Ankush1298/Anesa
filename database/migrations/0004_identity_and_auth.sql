-- 0004_identity_and_auth
-- Owner: app_migrator

CREATE TABLE platform.identities (
  id app.uuid_v7 PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 320),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  failed_login_count smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_email_uq UNIQUE (email)
);

CREATE TABLE platform.auth_sessions (
  id app.uuid_v7 PRIMARY KEY,
  identity_id app.uuid_v7 NOT NULL REFERENCES platform.identities (id) ON DELETE CASCADE,
  tenant_id app.uuid_v7 REFERENCES app.organizations (id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_token_uq UNIQUE (token_hash)
);

CREATE TRIGGER identities_touch BEFORE UPDATE ON platform.identities FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER identities_immutable BEFORE UPDATE ON platform.identities FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- Attach identity to the tenant membership (app.users)
ALTER TABLE app.users ADD COLUMN identity_id app.uuid_v7 REFERENCES platform.identities (id) ON DELETE CASCADE;

CREATE INDEX users_identity_id_idx ON app.users(identity_id);
CREATE INDEX auth_sessions_identity_id_idx ON platform.auth_sessions(identity_id);
CREATE INDEX auth_sessions_tenant_id_idx ON platform.auth_sessions(tenant_id);

-- Identity shouldn't be mutable on a user row.
-- We do not alter enforce_immutable_keys trigger as it only protects id and organization_id, but the codebase
-- will treat identity_id as immutable conceptually.

-- Only app_runtime can read/write identities and sessions during the auth flow
GRANT USAGE ON SCHEMA platform TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.identities TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.auth_sessions TO app_runtime;

CREATE POLICY users_identity_probe ON app.users AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator');

CREATE POLICY organizations_identity_probe ON app.organizations AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator');

-- Function to allow app_runtime to query cross-tenant memberships for an identity
-- during the login flow. Since it's SECURITY DEFINER owned by app_migrator, it bypasses RLS.
CREATE FUNCTION platform.get_identity_memberships(p_identity_id app.uuid_v7)
RETURNS TABLE (
  organization_id app.uuid_v7,
  user_id app.uuid_v7,
  status text,
  org_slug text,
  org_name text
)
SECURITY DEFINER
SET search_path = app, platform, pg_temp
LANGUAGE sql
AS $$
  SELECT u.organization_id, u.id as user_id, u.status, o.slug as org_slug, o.name as org_name
  FROM app.users u
  JOIN app.organizations o ON u.organization_id = o.id
  WHERE u.identity_id = p_identity_id AND u.status IN ('ACTIVE') AND o.status = 'ACTIVE';
$$;

GRANT EXECUTE ON FUNCTION platform.get_identity_memberships(app.uuid_v7) TO app_runtime;
