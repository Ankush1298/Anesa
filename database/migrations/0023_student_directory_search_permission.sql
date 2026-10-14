-- 0023_student_directory_search_permission
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students: registers the permission behind the staff student lookup (GET /api/v1/students?admissionNumber=).
-- Specification: docs/architecture/v3/10 §1 row 25 (student.directory.search, SENSITIVE; GRANTED to HOD, DEPARTMENT_ADMIN,
--                CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, held by no other role). The scope contract of the lookup
--                (students without an active enrolment are findable across campus/department boundaries; placed students
--                only inside the caller's scope) is documented in docs/architecture/v3/21-students.md §0b.
--
-- Ownership rule (0014, 0017, 0022): this row, the PERMISSION_CATALOG entry in backend/src/shared/authorization/catalog.ts and
-- the ROLE_MATRIX grants in role-matrix.ts change together; tests/integration/permission-seed.test.ts requires
-- platform.permissions to equal the code catalog exactly.
--
-- Existing tenants: this migration only REGISTERS the code. Role grants live in app.role_permissions and reach a tenant
-- only through seedTenantRoles, which skips codes that are not yet registered here. So: apply 0023 first, then re-run the
-- seed for each existing tenant (a separate, explicitly authorised operation; not performed by this change). Until then
-- no role holds the permission and the lookup refuses with 403 (fail closed).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0023 runs only after 0019 (and 0020, 0021, 0022) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.directory.search', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
