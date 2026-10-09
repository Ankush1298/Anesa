-- 0007_audit_events
-- Owner: app_migrator
-- F1 audit foundation (ADR-008; docs/architecture/v3/02 §4.9, 03 §11, 08).
--
-- One central, append-only audit table, range-partitioned by month on occurred_at (UTC),
-- PRIMARY KEY (id, occurred_at). Written ONLY through backend/src/shared/audit (same transaction as
-- the business change). There is deliberately NO read path yet: app_runtime gets INSERT on a fixed
-- column list and nothing else (no SELECT/UPDATE/DELETE/TRUNCATE); the viewer arrives with its own
-- permission and scoping.
--
-- PARTITION COVERAGE (fail closed): there is NO DEFAULT partition. A row whose occurred_at falls
-- outside the provisioned months is rejected by PostgreSQL ("no partition of relation found for row",
-- SQLSTATE 23514); because the audit insert shares the business transaction, the business change rolls
-- back too. Events are never dropped and never parked in an unmonitored catch-all. New months are added
-- by a new migration BEFORE the last partition below is reached (docs/architecture/v3/17-audit-foundation.md);
-- a test fails 3 months ahead of the last provisioned month.
-- Provisioned: 2026-10 .. 2028-12 (UTC month boundaries).

CREATE TABLE app.audit_events (
  id                  app.uuid_v7 NOT NULL,
  organization_id     app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- server clock, never client supplied (app_runtime has no INSERT privilege on this column);
  -- clock_timestamp() (statement time), not now() (transaction start)
  occurred_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type          text        NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'AI', 'PLATFORM_SUPPORT')),
  actor_user_id       app.uuid_v7,
  on_behalf_of_user_id app.uuid_v7,
  session_id          app.uuid_v7,
  -- the request id is a random (v4) UUID that correlates with logs; not a UUIDv7 key (see schema-linter exemption)
  request_id          uuid,
  ip                  inet,
  user_agent          text CHECK (user_agent IS NULL OR char_length(user_agent) <= 256),
  action              text        NOT NULL CHECK (char_length(action) <= 100 AND action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type       text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,59}$'),
  resource_id         app.uuid_v7,
  subject_student_id  app.uuid_v7,
  campus_id           app.uuid_v7,
  department_id       app.uuid_v7,
  risk_tier           smallint    NOT NULL CHECK (risk_tier IN (1, 2, 3)),
  changes             jsonb       CHECK (changes IS NULL OR (jsonb_typeof(changes) = 'object' AND octet_length(changes::text) <= 16384)),
  reason_code         text        CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  reason_text         text        CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 1 AND 500),
  metadata            jsonb       CHECK (metadata IS NULL OR (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384)),
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_events_user_actor_ck CHECK (actor_type <> 'USER' OR actor_user_id IS NOT NULL)
) PARTITION BY RANGE (occurred_at);

-- Lookup indexes (partitioned: created on every partition). Tenant first, as everywhere else.
CREATE INDEX audit_events_org_time_ix     ON app.audit_events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_resource_ix     ON app.audit_events (organization_id, resource_type, resource_id);
CREATE INDEX audit_events_subject_ix      ON app.audit_events (organization_id, subject_student_id, occurred_at DESC)
  WHERE subject_student_id IS NOT NULL;
CREATE INDEX audit_events_actor_ix        ON app.audit_events (organization_id, actor_user_id, occurred_at DESC);

-- Append-only for EVERY role (owner and superuser included; only session_replication_role=replica skips
-- triggers). Maintenance (DETACH/DROP of aged partitions) is an owner DDL operation, not row mutation.
CREATE FUNCTION app.reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = 'restrict_violation';
END
$$;
REVOKE ALL ON FUNCTION app.reject_audit_mutation() FROM PUBLIC;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

-- Row Level Security. Only an INSERT policy exists: with no SELECT/UPDATE/DELETE policy and no
-- privilege, the runtime role can neither read nor change audit rows.
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE  ROW LEVEL SECURITY;

-- The tenant is the authenticated tenant, the actor is the authenticated user (cannot be forged by the
-- caller), and impersonation / non-user actors are not available to the runtime in F1.
CREATE POLICY audit_events_tenant_insert ON app.audit_events AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id()
              AND (SELECT app.context_ok())
              AND actor_type = 'USER'
              AND actor_user_id = app.current_user_id()
              AND on_behalf_of_user_id IS NULL);

-- Column-level INSERT: occurred_at is intentionally absent so the server clock always applies.
GRANT INSERT (id, organization_id, actor_type, actor_user_id, on_behalf_of_user_id, session_id,
              request_id, ip, user_agent, action, resource_type, resource_id, subject_student_id,
              campus_id, department_id, risk_tier, changes, reason_code, reason_text, metadata)
  ON app.audit_events TO app_runtime;

-- Monthly partitions (UTC). Each partition is owned by app_migrator, has RLS enabled and forced
-- (defence in depth; routing through the parent applies the parent's policy) and NO grants to anyone.
CREATE TABLE app.audit_events_2026_10 PARTITION OF app.audit_events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
ALTER TABLE app.audit_events_2026_10 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2026_10 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2026_11 PARTITION OF app.audit_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
ALTER TABLE app.audit_events_2026_11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2026_11 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2026_12 PARTITION OF app.audit_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
ALTER TABLE app.audit_events_2026_12 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2026_12 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_01 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_01 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_01 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_02 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_02 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_02 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_03 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_03 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_04 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_04 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_04 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_05 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_05 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_06 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_06 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_07 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_07 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_08 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_08 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_09 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_09 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_09 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_10 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-10-01 00:00:00+00') TO ('2027-11-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_10 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_10 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_11 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-11-01 00:00:00+00') TO ('2027-12-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_11 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2027_12 PARTITION OF app.audit_events
  FOR VALUES FROM ('2027-12-01 00:00:00+00') TO ('2028-01-01 00:00:00+00');
ALTER TABLE app.audit_events_2027_12 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2027_12 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_01 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-01-01 00:00:00+00') TO ('2028-02-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_01 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_01 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_02 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-02-01 00:00:00+00') TO ('2028-03-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_02 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_02 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_03 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-03-01 00:00:00+00') TO ('2028-04-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_03 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_03 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_04 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-04-01 00:00:00+00') TO ('2028-05-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_04 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_04 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_05 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-05-01 00:00:00+00') TO ('2028-06-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_05 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_06 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-06-01 00:00:00+00') TO ('2028-07-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_06 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_07 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-07-01 00:00:00+00') TO ('2028-08-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_07 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_07 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_08 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-08-01 00:00:00+00') TO ('2028-09-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_08 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_08 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_09 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-09-01 00:00:00+00') TO ('2028-10-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_09 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_09 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_10 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-10-01 00:00:00+00') TO ('2028-11-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_10 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_10 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_11 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-11-01 00:00:00+00') TO ('2028-12-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_11 FORCE  ROW LEVEL SECURITY;

CREATE TABLE app.audit_events_2028_12 PARTITION OF app.audit_events
  FOR VALUES FROM ('2028-12-01 00:00:00+00') TO ('2029-01-01 00:00:00+00');
ALTER TABLE app.audit_events_2028_12 ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events_2028_12 FORCE  ROW LEVEL SECURITY;
