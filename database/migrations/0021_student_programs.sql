-- 0021_student_programs
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students Phase 3a, Step 1: DATABASE FOUNDATION of program enrolment.
-- Specification: docs/architecture/v3/02 §4.6 (student_programs), 06 §3 (student scope = the ACTIVE program's
--                campus/department), 10 §1 row 29 (student.program.assign), 11 §5.4 line 161, ADR-007 (dated rows).
--
-- Contents:
--  * app.student_programs: one row per enrolment of a student in a program/cohort (REGULAR openings first; entry_type
--    and previous_student_program_id are modelled for transfers/readmission, which have no application workflow yet).
--  * app.student_program_events: append-only lifecycle history (OPENED / CLOSED), written later in the same
--    transaction as the audit event. Minimal on purpose: it does not copy the student, program or cohort.
--  * two additive UNIQUE constraints on EXISTING tables (programs, cohorts) that the composite foreign keys need.
--
-- NOT here (recorded, not silently resolved):
--  * The permission row for student.program.assign. Existing ownership is "migration row AND catalog.ts entry AND role
--    matrix in the same change" (0014, 0017), and tests/integration/permission-seed.test.ts requires platform.permissions
--    to equal the code catalog exactly, so the row cannot be registered here without the catalog change. It belongs to
--    Step 2 (see docs/runbooks/students-contract-rollout.md once written).
--  * Any rule that couples a row to the CURRENT date (no future start dates): the Phase 3a service decides that against
--    the campus timezone; a CHECK against now() would be wrong for restores and for the campus calendar.
--  * ON_LEAVE (modelled by the status CHECK and the doc 02 vocabulary, but a row cannot be CREATED in it and no
--    transition reaches it: nothing could ever close such a row), transfer/readmission workflows, deactivation protection of programs/cohorts with active
--    enrolments, and any change to students.status.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0021 runs only after 0019 (and 0020) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).
-- By then students.admission_date is NOT NULL (0019).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Supporting UNIQUE constraints on existing tables (targets of composite foreign keys)
-- ---------------------------------------------------------------------------------------------
-- A student_programs row must carry the program's OWN department and the cohort's OWN program. PostgreSQL can enforce
-- that only through a composite foreign key whose target is a unique key containing the extra column. Both added
-- columns are immutable for the runtime role (UPDATE grants of 0014 omit department_id and program_id), and a
-- privileged UPDATE of them is refused by the foreign keys below while enrolments reference the row.
ALTER TABLE app.programs
  ADD CONSTRAINT programs_org_dept_id_uq UNIQUE (organization_id, department_id, id);
ALTER TABLE app.cohorts
  ADD CONSTRAINT cohorts_org_program_id_uq UNIQUE (organization_id, program_id, id);

-- ---------------------------------------------------------------------------------------------
-- 2. app.student_programs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.student_programs (
  id                          app.uuid_v7 PRIMARY KEY,
  organization_id             app.uuid_v7 NOT NULL,
  student_id                  app.uuid_v7 NOT NULL,
  program_id                  app.uuid_v7 NOT NULL,
  cohort_id                   app.uuid_v7 NOT NULL,
  -- Frozen copies taken from the program's department at opening; the foreign keys below make them consistent with
  -- the program and with each other, and they never change afterwards (immutable columns, doc 02 §4.6).
  campus_id                   app.uuid_v7 NOT NULL,
  department_id               app.uuid_v7 NOT NULL,
  start_date                  date        NOT NULL CHECK (start_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  end_date                    date        CHECK (end_date IS NULL OR end_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  status                      text        NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE', 'COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED', 'ON_LEAVE')),
  entry_type                  text        NOT NULL DEFAULT 'REGULAR'
                              CHECK (entry_type IN ('REGULAR', 'LATERAL', 'TRANSFER_IN', 'READMISSION')),
  previous_student_program_id app.uuid_v7,
  exit_reason                 text        CHECK (exit_reason IS NULL OR char_length(exit_reason) BETWEEN 1 AND 500),
  version                     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_programs_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT student_programs_org_id_uq UNIQUE (organization_id, id),
  -- target of the same-student foreign keys (previous enrolment, history events)
  CONSTRAINT student_programs_org_student_id_uq UNIQUE (organization_id, student_id, id),
  -- Tenant-scoped composite FKs: every relation is checked against the SAME organization.
  CONSTRAINT student_programs_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  -- the department IS the program's department
  CONSTRAINT student_programs_program_fk FOREIGN KEY (organization_id, department_id, program_id)
    REFERENCES app.programs (organization_id, department_id, id) ON DELETE RESTRICT,
  -- the cohort IS a cohort of the selected program
  CONSTRAINT student_programs_cohort_fk FOREIGN KEY (organization_id, program_id, cohort_id)
    REFERENCES app.cohorts (organization_id, program_id, id) ON DELETE RESTRICT,
  -- the campus IS the department's campus
  CONSTRAINT student_programs_department_fk FOREIGN KEY (organization_id, campus_id, department_id)
    REFERENCES app.departments (organization_id, campus_id, id) ON DELETE RESTRICT,
  -- a previous enrolment belongs to the SAME student (MATCH SIMPLE: not checked while it is NULL)
  CONSTRAINT student_programs_previous_fk FOREIGN KEY (organization_id, student_id, previous_student_program_id)
    REFERENCES app.student_programs (organization_id, student_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_programs_previous_not_self_ck
    CHECK (previous_student_program_id IS NULL OR previous_student_program_id <> id),
  CONSTRAINT student_programs_regular_no_previous_ck
    CHECK (entry_type <> 'REGULAR' OR previous_student_program_id IS NULL),
  -- an enrolment still in progress has no end date; a closed one has exactly one
  CONSTRAINT student_programs_end_date_ck
    CHECK ((status IN ('ACTIVE', 'ON_LEAVE')) = (end_date IS NULL)),
  CONSTRAINT student_programs_dates_ck
    CHECK (end_date IS NULL OR end_date >= start_date),
  -- an ACTIVE enrolment has not exited
  CONSTRAINT student_programs_active_no_exit_reason_ck
    CHECK (status <> 'ACTIVE' OR exit_reason IS NULL)
);

-- At most ONE ACTIVE enrolment per student (doc 02 §4.6). The service maps its 23505 to 409.
CREATE UNIQUE INDEX student_programs_one_active_uq
  ON app.student_programs (organization_id, student_id) WHERE status = 'ACTIVE';

-- FK-backing indexes (schema-linter S-2: an index whose leading columns equal each foreign key's columns, in order)
-- plus the doc 02 query indexes. organization_id alone and (organization_id, student_id) are covered by the
-- unique constraints above.
CREATE INDEX student_programs_org_student_previous_ix
  ON app.student_programs (organization_id, student_id, previous_student_program_id);
CREATE INDEX student_programs_org_dept_program_ix
  ON app.student_programs (organization_id, department_id, program_id);
CREATE INDEX student_programs_org_program_cohort_ix
  ON app.student_programs (organization_id, program_id, cohort_id);
CREATE INDEX student_programs_org_campus_dept_ix
  ON app.student_programs (organization_id, campus_id, department_id);
CREATE INDEX student_programs_org_dept_status_ix
  ON app.student_programs (organization_id, department_id, status);
CREATE INDEX student_programs_org_cohort_ix
  ON app.student_programs (organization_id, cohort_id);

-- Row guards (invoker, volatile, pinned search_path; same family as role_assignments_guard and students_guard).
--  * UPDATE: only status / end_date / exit_reason may change (the runtime role is granted exactly those columns; this
--    also stops privileged sessions). A closed row is terminal. ACTIVE may only move to COMPLETED, TRANSFERRED_OUT or
--    DISCONTINUED (a close); ON_LEAVE is modelled by the CHECKs but no transition into or out of it exists yet.
CREATE FUNCTION app.student_programs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
     OR NEW.previous_student_program_id IS DISTINCT FROM OLD.previous_student_program_id THEN
    RAISE EXCEPTION 'student program identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status NOT IN ('ACTIVE', 'ON_LEAVE') THEN
    RAISE EXCEPTION 'a closed student program is terminal' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED')) THEN
    RAISE EXCEPTION 'invalid student program status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

--  * INSERT: opening an ACTIVE enrolment requires an ACTIVE cohort and a start date on or after the student's admission
--    date. The cohort row is share-locked, so a concurrent cohort deactivation (an UPDATE) waits for this transaction
--    and a transaction that deactivated it first is seen after the wait (READ COMMITTED). Closed rows may be inserted
--    (history import) without the cohort rule. Nothing here reads the current date.
--    SECURITY INVOKER: it reads app.students / app.cohorts as the writer, which for a STAFF actor sees every row of
--    the tenant, like the 0016 and 0020 guards. Parents it cannot see are left to the foreign keys (23503).
CREATE FUNCTION app.student_programs_open_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  admitted date;
  cohort_status text;
BEGIN
  -- Phase 3a has no ON_LEAVE workflow: a row born ON_LEAVE could never be closed (no transition leaves it, and
  -- end_date_ck forbids an end date), so it is refused here rather than left as a permanent orphan.
  IF NEW.status = 'ON_LEAVE' THEN
    RAISE EXCEPTION 'student program: ON_LEAVE enrolments cannot be created (no workflow exists yet)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'student_programs_no_direct_on_leave_ck';
  END IF;

  -- A student or cohort this session cannot see (or that does not match) is left to the foreign keys, which run after
  -- this trigger and refuse the row with 23503; this guard only judges rows whose parents it can read.
  SELECT s.admission_date INTO admitted
    FROM app.students AS s
   WHERE s.organization_id = NEW.organization_id AND s.id = NEW.student_id;
  IF FOUND THEN
    IF admitted IS NULL THEN
      RAISE EXCEPTION 'student program: the student has no admission date'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'student_programs_start_after_admission_ck';
    END IF;
    IF NEW.start_date < admitted THEN
      RAISE EXCEPTION 'student program: start_date % is before the admission date %', NEW.start_date, admitted
        USING ERRCODE = 'check_violation', CONSTRAINT = 'student_programs_start_after_admission_ck';
    END IF;
  END IF;

  IF NEW.status = 'ACTIVE' THEN
    SELECT c.status INTO cohort_status
      FROM app.cohorts AS c
     WHERE c.organization_id = NEW.organization_id AND c.program_id = NEW.program_id AND c.id = NEW.cohort_id
       FOR SHARE;
    IF FOUND AND cohort_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'student program: the cohort must be ACTIVE to open an enrolment'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'student_programs_cohort_active_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.student_programs_guard(), app.student_programs_open_guard() FROM PUBLIC;

CREATE TRIGGER student_programs_touch BEFORE UPDATE ON app.student_programs
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER student_programs_immutable BEFORE UPDATE ON app.student_programs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER student_programs_guard_upd BEFORE UPDATE ON app.student_programs
  FOR EACH ROW EXECUTE FUNCTION app.student_programs_guard();
CREATE TRIGGER student_programs_open_guard_ins BEFORE INSERT ON app.student_programs
  FOR EACH ROW EXECUTE FUNCTION app.student_programs_open_guard();

ALTER TABLE app.student_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_programs FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_programs_tenant_select ON app.student_programs AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_programs_tenant_insert ON app.student_programs AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_programs_tenant_update ON app.student_programs AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- STAFF read everything of the tenant; a STUDENT reads only the enrolments of their OWN student record (the subquery
-- runs under the students policies, which already restrict it to the actor's own row) and can never write: the WITH
-- CHECK admits STAFF only, for INSERT and for UPDATE. Any other actor kind sees nothing.
CREATE POLICY student_programs_student_self ON app.student_programs AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: id, organization_id, student/program/cohort/campus/department, dates, entry_type and the previous
-- link are fixed at opening. A close changes only status, end_date and exit_reason (version/updated_at come from
-- touch_row). No DELETE.
GRANT SELECT, INSERT ON app.student_programs TO app_runtime;
GRANT UPDATE (status, end_date, exit_reason) ON app.student_programs TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.student_program_events (append-only lifecycle history)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.student_program_events (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  student_program_id app.uuid_v7 NOT NULL,
  student_id         app.uuid_v7 NOT NULL,
  event_type         text        NOT NULL CHECK (event_type IN ('OPENED', 'CLOSED')),
  from_status        text        CHECK (from_status IS NULL OR from_status IN ('ACTIVE', 'COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED', 'ON_LEAVE')),
  to_status          text        NOT NULL CHECK (to_status IN ('ACTIVE', 'COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED', 'ON_LEAVE')),
  effective_date     date        NOT NULL CHECK (effective_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  reason             text        NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  actor_user_id      app.uuid_v7 NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT student_program_events_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- the event's student IS the enrolment's student
  CONSTRAINT student_program_events_program_fk FOREIGN KEY (organization_id, student_id, student_program_id)
    REFERENCES app.student_programs (organization_id, student_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_program_events_actor_fk FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  -- OPENED starts an ACTIVE enrolment; CLOSED ends an ACTIVE one in a terminal outcome. Nothing else is recordable yet.
  -- (IS NOT DISTINCT FROM, not `=`: a CHECK that evaluates to NULL is SATISFIED, so a NULL from_status must not slip through.)
  CONSTRAINT student_program_events_shape_ck CHECK (
    (event_type = 'OPENED' AND from_status IS NULL AND to_status = 'ACTIVE')
    OR (event_type = 'CLOSED' AND from_status IS NOT DISTINCT FROM 'ACTIVE'
        AND to_status IN ('COMPLETED', 'TRANSFERRED_OUT', 'DISCONTINUED'))
  )
);

-- One OPENED and one CLOSED event per enrolment (a close is terminal, so a second CLOSED can never be legitimate).
CREATE UNIQUE INDEX student_program_events_one_opened_uq
  ON app.student_program_events (organization_id, student_program_id) WHERE event_type = 'OPENED';
CREATE UNIQUE INDEX student_program_events_one_closed_uq
  ON app.student_program_events (organization_id, student_program_id) WHERE event_type = 'CLOSED';

-- FK-backing and query indexes. organization_id alone is covered by these.
CREATE INDEX student_program_events_org_student_program_ix
  ON app.student_program_events (organization_id, student_id, student_program_id, occurred_at);
CREATE INDEX student_program_events_org_actor_ix
  ON app.student_program_events (organization_id, actor_user_id);

-- An event must DESCRIBE the enrolment's actual state. Written after the enrolment change in the same transaction (the
-- service order: INSERT the enrolment then its OPENED event; UPDATE the enrolment then its CLOSED event), so it reads the
-- row as this transaction left it.
--  * OPENED: the enrolment is ACTIVE and the event date is its start_date.
--  * CLOSED: the enrolment's status IS the event's to_status and the event date is its end_date. A closed row is
--    terminal, so this can never become false later.
-- The enrolment row is share-locked: an OPENED event is judged against an ACTIVE row that a concurrent close cannot
-- change until this transaction ends. Lock order is always enrolment row -> event insert (the service already holds the
-- row lock from its own INSERT/UPDATE), and no path locks an event and then an enrolment, so no cycle exists.
-- An enrolment, student or tenant this session cannot see is left to the foreign keys / row security (23503 / 42501).
-- SECURITY INVOKER like the other guards; a BEFORE ROW trigger runs before the RLS WITH CHECK.
CREATE FUNCTION app.student_program_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  sp_status text;
  sp_start  date;
  sp_end    date;
BEGIN
  SELECT sp.status, sp.start_date, sp.end_date INTO sp_status, sp_start, sp_end
    FROM app.student_programs AS sp
   WHERE sp.organization_id = NEW.organization_id AND sp.student_id = NEW.student_id AND sp.id = NEW.student_program_id
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.event_type = 'OPENED'
     AND (sp_status IS DISTINCT FROM 'ACTIVE' OR NEW.effective_date IS DISTINCT FROM sp_start) THEN
    RAISE EXCEPTION 'student program event: OPENED must describe an ACTIVE enrolment on its start date'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'student_program_events_matches_enrolment_ck';
  END IF;
  IF NEW.event_type = 'CLOSED'
     AND (sp_status IS DISTINCT FROM NEW.to_status OR sp_end IS DISTINCT FROM NEW.effective_date) THEN
    RAISE EXCEPTION 'student program event: CLOSED must describe the enrolment''s actual outcome and end date'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'student_program_events_matches_enrolment_ck';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.student_program_events_guard() FROM PUBLIC;

CREATE FUNCTION app.reject_student_program_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'student program events are append-only' USING ERRCODE = 'restrict_violation';
END
$$;
REVOKE ALL ON FUNCTION app.reject_student_program_event_mutation() FROM PUBLIC;

-- Append-only for EVERY role (owner and superuser included; only session_replication_role = replica skips triggers),
-- like audit_events (0007). The immutable-keys trigger keeps the schema-wide convention (every table has one).
CREATE TRIGGER student_program_events_guard_ins BEFORE INSERT ON app.student_program_events
  FOR EACH ROW EXECUTE FUNCTION app.student_program_events_guard();
CREATE TRIGGER student_program_events_immutable BEFORE UPDATE ON app.student_program_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER student_program_events_append_only BEFORE UPDATE OR DELETE ON app.student_program_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_student_program_event_mutation();
CREATE TRIGGER student_program_events_no_truncate BEFORE TRUNCATE ON app.student_program_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_student_program_event_mutation();

ALTER TABLE app.student_program_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_program_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_program_events_tenant_select ON app.student_program_events AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_program_events_tenant_insert ON app.student_program_events AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY student_program_events_student_self ON app.student_program_events AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Authorship: an event is attributed to the session's own user and to nobody else (same rule as organization_settings,
-- 0012), so the history cannot be forged by the runtime role.
CREATE POLICY student_program_events_authorship ON app.student_program_events AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (actor_user_id = app.current_user_id());

-- Least privilege: read and append only. No UPDATE, no DELETE. occurred_at is intentionally absent from the INSERT
-- list so the server clock always applies (same rule as audit_events, 0007). id stays suppliable: every table's id is
-- generated by the application (uuid v7), and uniqueness/tenancy are enforced by the key and the composite foreign keys.
GRANT SELECT ON app.student_program_events TO app_runtime;
GRANT INSERT (id, organization_id, student_program_id, student_id, event_type, from_status, to_status,
              effective_date, reason, actor_user_id) ON app.student_program_events TO app_runtime;
