-- 0022_student_program_assign_permission
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students Phase 3a, Step 2A: registers the permission that opens and closes student_programs.
-- Specification: docs/architecture/v3/10 §1 row 29 (student.program.assign, SENSITIVE; GRANTED to DEPARTMENT_ADMIN,
--                CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, held by no other role).
--
-- Ownership rule (0014, 0017): this row, the PERMISSION_CATALOG entry in backend/src/shared/authorization/catalog.ts and
-- the ROLE_MATRIX grants in role-matrix.ts change together; tests/integration/permission-seed.test.ts requires
-- platform.permissions to equal the code catalog exactly. The row could not ship in 0021 (that migration is
-- immutable once accepted), hence this separate migration.
--
-- Existing tenants: this migration only REGISTERS the code. Role grants live in app.role_permissions and reach a tenant
-- only through seedTenantRoles, which skips codes that are not yet registered here. So: apply 0022 first, then re-run the
-- seed for each existing tenant (a separate, explicitly authorised operation; not performed by this change). Until then
-- no role holds the permission and the future enrolment service refuses with 403 (fail closed).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0022 runs only after 0019 (and 0020, 0021) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.program.assign', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
