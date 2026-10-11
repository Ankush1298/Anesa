-- 0014_academic_programs
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: Academic Structure Primitives.
-- Specification: docs/architecture/v3/02 §4.5, 08 §4.1 / §5 (Programs minimal), 10 §1 rows 20-22,
--                11 §5.1 row 1D / §5.4 line 160 (GET/POST /period-types, GET/POST/PATCH /programs,
--                GET/POST/PATCH /cohorts), 04 §14.2 (/academics domain, academic.* GRANTED).
--
-- Contents:
--  * app.period_types: org-configurable kinds of study period (SEMESTER/TRIMESTER/YEAR). Insert-only
--    at runtime (no PATCH endpoint in doc 11 §5.4), so no UPDATE grant/policy is issued.
--  * app.programs: a programme of study owned by a department, measured in a period_type.
--  * app.cohorts: an admission batch of a program (UI label "Batch"/"Cohort").
--    Prerequisites for app.students / app.student_programs (Milestone 1 People slice).
--
-- Deliberately NOT here (recorded, not silently resolved):
--  * Per-tenant seeding of default period types (SEMESTER/TRIMESTER/YEAR): doc 08 §4 line 111 seeds
--    them in the provisioning routine. period_types carries a staff-only RESTRICTIVE insert policy, so
--    the app_migrator owner cannot insert tenant rows here (FORCE RLS applies to the owner too, and the
--    owner is not a STAFF actor). Tenants create period types through POST /period-types; seeding is a
--    provisioning concern, consistent with how organization_settings defaults are handled (0012).
--  * programs.degree_level is a bounded free string (1..30). doc 02 §4.5 says its allowed values come
--    from the org setting `academic.degree_levels`, which is NOT in the code registry (shared/settings
--    has four keys, none academic). Validating against a non-existent setting would invent a decision;
--    the column is length-bounded and that validation is deferred until the setting is registered.

-- ---------------------------------------------------------------------------------------------
-- 1. app.period_types
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.period_types (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
  code            text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 30),
  label           text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 50),
  label_plural    text        NOT NULL CHECK (char_length(label_plural) BETWEEN 1 AND 50),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_types_org_code_uq UNIQUE (organization_id, code),
  CONSTRAINT period_types_org_id_uq   UNIQUE (organization_id, id)
);

CREATE TRIGGER period_types_touch BEFORE UPDATE ON app.period_types
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER period_types_immutable BEFORE UPDATE ON app.period_types
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.period_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.period_types FORCE  ROW LEVEL SECURITY;

CREATE POLICY period_types_tenant_select ON app.period_types AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY period_types_tenant_insert ON app.period_types AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Same staff-only write rule as campuses/departments (0008): a STUDENT session is refused by the
-- database itself. WHICH staff member may manage academic structure (academic.program.manage with its
-- scope) is decided by the application authorization engine; the database has no scope context here.
CREATE POLICY period_types_staff_insert ON app.period_types AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: runtime may read and create period types only. There is no PATCH endpoint, so no
-- UPDATE grant is issued; code, label and label_plural are therefore fixed at creation. Widening this
-- to support editing is a future migration, not an UPDATE the runtime can already do.
GRANT SELECT, INSERT ON app.period_types TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 2. app.programs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.programs (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  department_id      app.uuid_v7 NOT NULL,
  period_type_id     app.uuid_v7 NOT NULL,
  name               text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  code               text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  degree_level       text        NOT NULL CHECK (char_length(degree_level) BETWEEN 1 AND 30),
  duration_periods   smallint    NOT NULL CHECK (duration_periods BETWEEN 1 AND 100),
  periods_per_year   smallint    CHECK (periods_per_year IS NULL OR periods_per_year BETWEEN 1 AND 100),
  default_regulation text        CHECK (default_regulation IS NULL OR char_length(default_regulation) BETWEEN 1 AND 30),
  status             text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT programs_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- Tenant-scoped composite FKs: a program's department and period type must belong to the same tenant.
  CONSTRAINT programs_department_fk FOREIGN KEY (organization_id, department_id)
    REFERENCES app.departments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT programs_period_type_fk FOREIGN KEY (organization_id, period_type_id)
    REFERENCES app.period_types (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT programs_org_code_uq UNIQUE (organization_id, code),
  CONSTRAINT programs_org_id_uq   UNIQUE (organization_id, id)
);

-- FK-backing indexes (schema-linter S-2 requires an index whose leading columns match each FK).
-- organization_id alone is covered by programs_org_code_uq.
CREATE INDEX programs_org_department_ix  ON app.programs (organization_id, department_id);
CREATE INDEX programs_org_period_type_ix ON app.programs (organization_id, period_type_id);
CREATE INDEX programs_org_status_ix      ON app.programs (organization_id, status);

CREATE TRIGGER programs_touch BEFORE UPDATE ON app.programs
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER programs_immutable BEFORE UPDATE ON app.programs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.programs FORCE  ROW LEVEL SECURITY;

CREATE POLICY programs_tenant_select ON app.programs AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY programs_tenant_insert ON app.programs AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY programs_tenant_update ON app.programs AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY programs_staff_insert ON app.programs AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY programs_staff_update ON app.programs AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: id, organization_id, department_id, period_type_id and code are fixed at creation
-- (moving a program between departments or period types silently changes what every cohort and student
-- assignment under it means). Only descriptive fields and lifecycle status are updatable.
-- version/updated_at are maintained by app.touch_row(). Hard DELETE is not granted.
GRANT SELECT, INSERT ON app.programs TO app_runtime;
GRANT UPDATE (name, degree_level, duration_periods, periods_per_year, default_regulation, status) ON app.programs TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.cohorts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.cohorts (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  program_id              app.uuid_v7 NOT NULL,
  admission_year          smallint    NOT NULL CHECK (admission_year BETWEEN 1900 AND 2200),
  intake_code             text        NOT NULL DEFAULT 'MAIN' CHECK (char_length(intake_code) BETWEEN 1 AND 10),
  name                    text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  regulation              text        CHECK (regulation IS NULL OR char_length(regulation) BETWEEN 1 AND 30),
  expected_graduation_year smallint   CHECK (expected_graduation_year IS NULL OR (expected_graduation_year BETWEEN 1900 AND 2200 AND expected_graduation_year >= admission_year)),
  status                  text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'GRADUATED', 'CLOSED')),
  version                 integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohorts_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT cohorts_program_fk FOREIGN KEY (organization_id, program_id)
    REFERENCES app.programs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cohorts_program_year_intake_uq UNIQUE (program_id, admission_year, intake_code),
  CONSTRAINT cohorts_org_id_uq UNIQUE (organization_id, id)
);

-- FK-backing indexes. organization_id alone is covered by cohorts_org_id_uq; the composite
-- (organization_id, program_id) FK needs its own leading-column index.
CREATE INDEX cohorts_org_program_ix ON app.cohorts (organization_id, program_id);
CREATE INDEX cohorts_org_status_ix  ON app.cohorts (organization_id, status);

CREATE TRIGGER cohorts_touch BEFORE UPDATE ON app.cohorts
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER cohorts_immutable BEFORE UPDATE ON app.cohorts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cohorts FORCE  ROW LEVEL SECURITY;

CREATE POLICY cohorts_tenant_select ON app.cohorts AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY cohorts_tenant_insert ON app.cohorts AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY cohorts_tenant_update ON app.cohorts AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY cohorts_staff_insert ON app.cohorts AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY cohorts_staff_update ON app.cohorts AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: id, organization_id, program_id, admission_year and intake_code are fixed at
-- creation (they form the cohort's identity and its unique business key). Only name, regulation,
-- expected_graduation_year and status are updatable. Hard DELETE is not granted.
GRANT SELECT, INSERT ON app.cohorts TO app_runtime;
GRANT UPDATE (name, regulation, expected_graduation_year, status) ON app.cohorts TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 4. Permissions (doc 10 §1 rows 20-22). Registered here, granted to roles by seedTenantRoles.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('academic.program.read', 'NORMAL'),
  ('academic.program.manage', 'SENSITIVE'),
  ('academic.cohort.manage', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
