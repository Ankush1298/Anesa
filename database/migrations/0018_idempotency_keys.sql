-- 0018_idempotency_keys
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students slice, Phase 2: shared idempotency mechanism.
-- Specification: docs/architecture/v3/22-idempotency.md (this mechanism), 21-students.md (first consumer),
--                04 §14 (Idempotency-Key convention).
--
-- app.idempotency_keys remembers the SUCCESSFUL response of one mutating request, so a client that retries after a
-- lost response gets the original answer instead of a second write.
--
-- Identity of a record: (organization_id, user_id, key). The key is scoped to the tenant AND the authenticated
-- principal: two users can use the same key string without ever seeing each other's records (RESTRICTIVE policy
-- below), and a key can never be replayed across tenants. `operation` ("METHOD /route") and the SHA-256
-- `request_hash` of the canonical request are stored so that reusing a key for a different request is detected.
--
-- Protocol (implemented by src/shared/idempotency, one transaction with the business write):
--   1. INSERT ... ON CONFLICT (organization_id, user_id, key) DO NOTHING. A concurrent request with the same key
--      waits on the unique index until the first transaction commits (then the insert does nothing and the
--      stored response is replayed) or rolls back (then the insert succeeds and this request proceeds). That wait is
--      the serialisation; no advisory lock is involved.
--   2. The business write, then UPDATE the claim with response_status / response_body.
--   3. A failed request rolls the whole transaction back, claim included, so a failure is NEVER cached.
--   A committed row therefore always carries a response. response_status and response_body are nullable only because
--   the claim exists between steps 1 and 2 inside the open transaction (enforced as an all-or-nothing pair).
--
-- Expiry: expires_at is set to now() + 24 hours by the service. An expired row is not replayed; the next request with
-- that key REPLACES it in place (UPDATE guarded by expires_at <= now(), so two racing replacements cannot both win).
-- There is no DELETE grant: purging expired rows is a later platform job (the expires_at index exists for it).
--
-- Deliberately NOT here: failure caching (an error is retried for real), a response-size cap beyond the service's
-- own 16 KiB limit, and a purge job.

CREATE TABLE app.idempotency_keys (
  organization_id app.uuid_v7 NOT NULL,
  user_id         app.uuid_v7 NOT NULL,
  key             text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  operation       text        NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  request_hash    char(64)    NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status smallint    CHECK (response_status BETWEEN 200 AND 299),
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_pk PRIMARY KEY (organization_id, user_id, key),
  CONSTRAINT idempotency_keys_org_fk  FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- Tenant-scoped composite FK: the principal must be a user of the SAME tenant.
  CONSTRAINT idempotency_keys_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_keys_expiry_ck   CHECK (expires_at > created_at),
  CONSTRAINT idempotency_keys_response_ck CHECK ((response_status IS NULL) = (response_body IS NULL))
);

-- idempotency_keys_org_fk and idempotency_keys_user_fk are covered by the leading columns of the primary key.
CREATE INDEX idempotency_keys_expires_ix ON app.idempotency_keys (expires_at);

CREATE TRIGGER idempotency_keys_immutable BEFORE UPDATE ON app.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_tenant_select ON app.idempotency_keys AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY idempotency_keys_tenant_insert ON app.idempotency_keys AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY idempotency_keys_tenant_update ON app.idempotency_keys AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Principal scope: a session sees and writes only its own user's keys. A stored response can contain data the
-- principal was authorised to see at the time, so another user of the same tenant must never read it.
CREATE POLICY idempotency_keys_own ON app.idempotency_keys AS RESTRICTIVE FOR ALL TO app_runtime
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- Least privilege: the identity (organization_id, user_id, key) is fixed by the claim. The columns below are the ones
-- the protocol rewrites: the response, and (for an expired-key replacement, which may be for a different operation)
-- the operation, fingerprint and clock. No DELETE.
GRANT SELECT, INSERT ON app.idempotency_keys TO app_runtime;
GRANT UPDATE (operation, request_hash, response_status, response_body, created_at, expires_at)
  ON app.idempotency_keys TO app_runtime;
