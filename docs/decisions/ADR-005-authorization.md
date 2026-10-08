# ADR-005: Authorization: RBAC with scope modes and dated scoped assignments

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-002, ADR-013

## Context
Faculty by assignment, HOD by department, admins by campus/organisation, students by self; object-level protection (BOLA) is mandatory.

## Decision
Permissions are code-defined `module.resource.action`; `role_permissions` carry `scope_mode` SELF/ASSIGNED/GRANTED; `role_assignments` carry scope (organisation/campus/department) and validity; `role_grant_rules` prevent escalation; resolvers expose both point checks and SQL predicates; out-of-scope resources return 404; every route declares a permission and every service asserts on the loaded object. RLS provides tenant and student-self backstops.

## Options considered
Plain RBAC; permission strings with scope suffix; ABAC/OPA engine; RBAC + scope modes.

## Consequences
Understandable, fast, testable; new scope kinds require resolver code; point/list agreement tests are mandatory.
