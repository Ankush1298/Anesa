-- 0015_employees
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: Employee records.
-- Specification: docs/architecture/v3/02 §4.4 (employees), 03/ADR-003 (account vs role record),
--                08 §4.1 (version / If-Match), 10 §1 rows 32-34, 11 §5.4 (GET/POST /employees, GET/PATCH /employees/{id}).
--
-- Contents:
--  * app.employees: the employee role record of a user account. One per user (UQ organization_id, user_id).
--  * platform.permissions: employee.profile.read, employee.record.create, employee.record.update.
--
-- Deliberately NOT here (recorded, not silently resolved):
--  * employee_postings (department / designation / is_primary): 02 §4.4 defines it, but 08 §5 lists it as an
--    M2 table. employees therefore carries NO department_id, campus_id or designation_id. Consequence: an
--    employee cannot be proven to lie inside a CAMPUS or DEPARTMENT scope, so only ORGANIZATION-scoped holders
--    (and the employee themself, SELF mode) can reach a record until postings exist. Fail-closed by design.
--  * A history table (A2): 08 §5's authoritative M1 inventory has none for employees; the audit row with a
--    mandatory reason carries the old/new diff (same interpretation as docs/architecture/v3/19, Decision 3).
--  * Any coupling between status and leaving_date: 01 §3.4 lists leaving_date as OPTIONAL and gives employees no
--    constraint beyond "code unique per org"; 02 §4.4 types both columns independently. So SEPARATED does not
--    require a leaving date and a leaving date does not require SEPARATED (e.g. a recorded notice period). Status
--    transitions are likewise unrestricted: 01 §3.4 only sketches "ACTIVE->ON_LEAVE->SEPARATED", which read literally
--    would forbid a direct ACTIVE->SEPARATED. OPEN DECISION (docs/architecture/v3/20-employees.md section 4).
--  * employee_code allocation: 02 §4.4 gives no allocation rule (number_sequences is for admission numbers), so
--    the code is supplied by the administrator and is fixed after creation.
--  * Implicit role assignment (employee type FACULTY => FACULTY role, doc 10 intro): role assignments are made
--    through RoleAssignmentService under role.assignment.grant, not as a side effect of this table.

CREATE TABLE app.employees (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  user_id         app.uuid_v7 NOT NULL,
  employee_code   text        NOT NULL CHECK (char_length(employee_code) BETWEEN 1 AND 50),
  employee_type   text        NOT NULL CHECK (employee_type IN ('FACULTY', 'STAFF', 'ADMIN', 'VISITING')),
  joining_date    date        NOT NULL,
  leaving_date    date,
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ON_LEAVE', 'SEPARATED')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_org_fk  FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- Tenant-scoped composite FK: an employee can only point at a user of the SAME tenant.
  CONSTRAINT employees_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT employees_org_code_uq UNIQUE (organization_id, employee_code),
  CONSTRAINT employees_org_user_uq UNIQUE (organization_id, user_id),
  CONSTRAINT employees_org_id_uq   UNIQUE (organization_id, id),
  -- Convention, not an employee-specific rule: 08 §4 line 60 lists "Dates ordered" among the standard check
  -- constraints. Same-day join and leave is allowed (>=).
  CONSTRAINT employees_dates_ck    CHECK (leaving_date IS NULL OR leaving_date >= joining_date)
);

-- employees_org_fk is covered by the leading organization_id of every index above; employees_user_fk by
-- employees_org_user_uq (same leading columns, same order).
CREATE INDEX employees_org_status_ix ON app.employees (organization_id, status);

CREATE TRIGGER employees_touch BEFORE UPDATE ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER employees_immutable BEFORE UPDATE ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employees FORCE  ROW LEVEL SECURITY;

CREATE POLICY employees_tenant_select ON app.employees AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY employees_tenant_insert ON app.employees AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY employees_tenant_update ON app.employees AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Staff data: doc 10 notes that students can never list or search employees (row 32 is not held). Unlike campus
-- structure, an employee record is personal data, so the database itself also refuses a STUDENT session on every
-- command. LIMIT: the only actor distinction the session carries is STUDENT vs STAFF; WHICH staff member may
-- touch WHICH record is decided by the application's authorization engine, which the database cannot see.
CREATE POLICY employees_staff_select ON app.employees AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');
CREATE POLICY employees_staff_insert ON app.employees AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY employees_staff_update ON app.employees AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: id, organization_id, user_id (the identity mapping) and employee_code (the business key that
-- payroll/imports refer to) are fixed at creation. Only the employment facts below can change. version/updated_at
-- are maintained by app.touch_row(). Hard DELETE is not granted: a leaver is SEPARATED, never removed.
GRANT SELECT, INSERT ON app.employees TO app_runtime;
GRANT UPDATE (employee_type, joining_date, leaving_date, status) ON app.employees TO app_runtime;

-- Permissions (doc 10 §1 rows 32-34). Granted to roles by seedTenantRoles.
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('employee.profile.read', 'NORMAL'),
  ('employee.record.create', 'SENSITIVE'),
  ('employee.record.update', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
