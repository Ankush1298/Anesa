# ADR-002: Multi-tenancy: organization is the tenant; shared schema with RLS

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-019, ADR-005

## Context
One college now, SaaS later. Tenant A must never access Tenant B. Cost and migration complexity must stay low.

## Decision
Tenant = `organizations` row. Shared database and schema; `organization_id` on every tenant table; PostgreSQL RLS (ENABLE+FORCE, fail-closed, `tenant_isolation` policy) with `app.tenant_id` set per transaction by `withTenant`; runtime DB role without BYPASSRLS; campus and department are authorization scopes, not isolation boundaries. Platform operations run in a separate realm. Group-level reporting (future) uses aggregated read models, never cross-tenant OLTP queries.

## Options considered
Database-per-tenant; schema-per-tenant; shared schema without RLS; shared schema with RLS.

## Consequences
Cheapest to operate and migrate; a policy bug is the failure mode, mitigated by linter, DB-level tests and cross-tenant matrix tests. SQL injection could alter the setting; mitigated by parameterised-only SQL and lint. Per-tenant databases remain an upgrade path for enterprise customers.
