-- 0008_academic_structure
-- Owner: app_migrator
-- Milestone 2 / F2.1: Academic Structure Foundation (Expand Phase).
--
-- Contents:
--  * app.campuses: Physical and administrative campus boundaries.
--  * app.departments: Academic, administrative, and service departments within campuses.
--  * app.role_assignments: Add nullable typed scope columns (campus_id, department_id) and foreign keys.
--    Backward-compatible with existing RoleAssignmentService.grant writer (preserves ra_scope_id_check).
--    Strict constraint enforcement and guard extension are deferred to the contract migration.

-- ---------------------------------------------------------------------------------------------
-- 1. app.campuses
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.campuses (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  code            text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  -- IANA zone name (e.g. 'Asia/Kolkata'); it defines a class's calendar day, so it is REQUIRED (no default: a
  -- silent 'UTC' would mis-date every session). The database only bounds the length: PostgreSQL cannot validate
  -- a zone name in a CHECK without a non-immutable expression that also accepts abbreviations and POSIX offsets
  -- ('PST', 'UTC+5') and can break dump/restore when the tz database changes. The authoritative check is made by
  -- the application at write time against the server's own tz database (pg_timezone_names): CampusService.create
  -- (src/modules/organization). NOT validated by this migration: a writer that bypasses that service can insert any
  -- string of 1..64 characters, which is why no other writer of app.campuses may exist.
  timezone        text        NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  address         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(address) = 'object' AND octet_length(address::text) <= 4096),
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campuses_org_code_uq UNIQUE (organization_id, code),
  CONSTRAINT campuses_org_id_uq   UNIQUE (organization_id, id)
);

CREATE INDEX campuses_org_status_ix ON app.campuses (organization_id, status);

CREATE TRIGGER campuses_touch BEFORE UPDATE ON app.campuses
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER campuses_immutable BEFORE UPDATE ON app.campuses
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.campuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campuses FORCE  ROW LEVEL SECURITY;

CREATE POLICY campuses_tenant_select ON app.campuses AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY campuses_tenant_insert ON app.campuses AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY campuses_tenant_update ON app.campuses AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Organisation structure is readable by every active member of the tenant, but only STAFF sessions may create or
-- change it: a STUDENT session is refused by the database itself (same pattern as users_no_student_insert, 0003).
-- LIMIT: the only actor distinction the session context carries is STUDENT vs STAFF. WHICH staff member may manage
-- WHICH campus (org.campus.manage with its scope) is decided by the application's authorization engine; the
-- database has no permission or scope context to enforce it, so no policy here claims to.
CREATE POLICY campuses_staff_insert ON app.campuses AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY campuses_staff_update ON app.campuses AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: runtime may read and create campuses, and after creation change ONLY name, address and status.
-- Fixed at creation: id and organization_id (identity), code (the stable business key that imports and reports
-- refer to) and timezone. timezone is deliberately not editable through ordinary runtime access: it defines which
-- calendar day a class session belongs to, so changing it silently re-dates attendance and schedules. Changing it
-- needs a deliberate, audited operation once the application defines what happens to existing sessions; that
-- will be a new migration widening this grant, not an UPDATE the runtime can already do today.
-- version/updated_at are maintained by app.touch_row(), which writes NEW directly and needs no column privilege
-- (same arrangement as departments below and role_assignments since 0006). Hard DELETE is not granted.
GRANT SELECT, INSERT ON app.campuses TO app_runtime;
GRANT UPDATE (name, address, status) ON app.campuses TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 2. app.departments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.departments (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  campus_id             app.uuid_v7 NOT NULL,
  parent_department_id  app.uuid_v7,
  name                  text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  code                  text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  kind                  text        NOT NULL DEFAULT 'ACADEMIC' CHECK (kind IN ('ACADEMIC', 'ADMINISTRATIVE', 'SERVICE')),
  status                text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  deleted_at            timestamptz,
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT depts_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT depts_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT depts_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT depts_org_campus_id_uq UNIQUE (organization_id, campus_id, id),
  CONSTRAINT depts_parent_fk FOREIGN KEY (organization_id, campus_id, parent_department_id)
    REFERENCES app.departments (organization_id, campus_id, id) ON DELETE RESTRICT,
  CONSTRAINT depts_no_self_parent_ck CHECK (parent_department_id IS NULL OR parent_department_id <> id)
);

CREATE UNIQUE INDEX depts_campus_code_active_uq ON app.departments (campus_id, code) WHERE deleted_at IS NULL;
CREATE INDEX depts_org_campus_ix ON app.departments (organization_id, campus_id);
CREATE INDEX depts_parent_ix ON app.departments (organization_id, campus_id, parent_department_id);

CREATE TRIGGER departments_touch BEFORE UPDATE ON app.departments
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER departments_immutable BEFORE UPDATE ON app.departments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.departments FORCE  ROW LEVEL SECURITY;

CREATE POLICY departments_tenant_select ON app.departments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY departments_tenant_insert ON app.departments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY departments_tenant_update ON app.departments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Same staff-only write rule as campuses (see the LIMIT note there).
CREATE POLICY departments_staff_insert ON app.departments AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY departments_staff_update ON app.departments AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: runtime may read and create departments, and after creation change ONLY name, status and
-- deleted_at (soft delete). id, organization_id, campus_id, code, kind and parent_department_id are fixed at
-- creation: moving a department between campuses or re-parenting it would silently change what a
-- DEPARTMENT-scoped role assignment means. version/updated_at are maintained by app.touch_row(), a trigger that
-- writes NEW directly and needs no column privilege (the same arrangement role_assignments has since 0006).
-- Hard DELETE is not granted.
GRANT SELECT, INSERT ON app.departments TO app_runtime;
GRANT UPDATE (name, status, deleted_at) ON app.departments TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.role_assignments: expand phase
-- ---------------------------------------------------------------------------------------------
-- Add nullable typed scope columns. Existing ra_scope_id_check is preserved so current
-- writers continuing to insert only scope_id are NOT broken.
ALTER TABLE app.role_assignments
  ADD COLUMN campus_id app.uuid_v7,
  ADD COLUMN department_id app.uuid_v7;

-- Composite foreign keys: enforceable when non-null (MATCH SIMPLE skips nulls).
-- Old writers inserting NULL for campus_id/department_id continue to work safely.
ALTER TABLE app.role_assignments
  ADD CONSTRAINT ra_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT ra_department_fk FOREIGN KEY (organization_id, department_id)
    REFERENCES app.departments (organization_id, id) ON DELETE RESTRICT;

CREATE INDEX role_assignments_org_campus_ix ON app.role_assignments (organization_id, campus_id);
CREATE INDEX role_assignments_org_dept_ix ON app.role_assignments (organization_id, department_id);

-- LOCK ORDER (convention for every writer of these tables): campus first, then department, one row per
-- statement. RoleAssignmentService.grant share-locks the campus and then the department; a transaction that
-- changes both must update the campus row before the department row.
--
-- Note: Extending app.role_assignments_guard() to protect campus_id and department_id
-- is intentionally deferred to the contract phase (0009) to allow migration backfills
-- while runtime column grants (UPDATE on status, valid_until only) prevent application mutation.
