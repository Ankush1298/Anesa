-- 0013_number_sequences
-- Owner: app_migrator
-- Milestone 1 / Phase 1E: Number Sequence Engine
-- Specification: docs/architecture/v3/02 §4.2 (number_sequences), 08 §5 (platform group inventory),
-- 11 §5.1 row 1B / §5.3 (`shared/numbering`).
--
-- Contents:
--  * app.number_sequences: atomic monotonic allocator per (organization_id, key, period).
--    next_value bigint! stores the next unallocated number.
--    Allocated via single-statement atomic upsert:
--      INSERT INTO app.number_sequences (organization_id, key, period, next_value)
--      VALUES ($1, $2, $3, 2)
--      ON CONFLICT (organization_id, key, period)
--      DO UPDATE SET next_value = app.number_sequences.next_value + 1
--      WHERE app.number_sequences.next_value < 9223372036854775807
--      RETURNING (app.number_sequences.next_value - 1)::text AS allocated_value;
--
-- Deliberately NOT here: public HTTP endpoints or domain-specific numbering logic
-- (student admission numbers, receipts, tickets). Those are built in their respective domain modules.

CREATE TABLE app.number_sequences (
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  key             text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  period          text        NOT NULL CHECK (char_length(period) BETWEEN 1 AND 50),
  next_value      bigint      NOT NULL CHECK (next_value > 0),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT number_sequences_pk PRIMARY KEY (organization_id, key, period)
);

CREATE TRIGGER number_sequences_touch BEFORE UPDATE ON app.number_sequences
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER number_sequences_immutable BEFORE UPDATE ON app.number_sequences
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.number_sequences FORCE  ROW LEVEL SECURITY;

CREATE POLICY number_sequences_tenant_select ON app.number_sequences AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY number_sequences_tenant_insert ON app.number_sequences AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY number_sequences_tenant_update ON app.number_sequences AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Least privilege: app_runtime can read, insert, and increment next_value.
-- organization_id, key, and period are fixed at insert; version/updated_at are maintained by app.touch_row().
-- No DELETE, no TRUNCATE.
GRANT SELECT, INSERT ON app.number_sequences TO app_runtime;
GRANT UPDATE (next_value) ON app.number_sequences TO app_runtime;
