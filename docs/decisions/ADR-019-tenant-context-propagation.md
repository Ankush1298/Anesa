# ADR-019: Tenant context propagation across requests, jobs, cache and search

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-002, ADR-009

## Context
Isolation must hold outside the HTTP path (workers, caches, search, exports).

## Decision
RequestContext created once per request/job; withTenant is the only DB entry; job envelopes require tenantId and rebuild context; cross-tenant schedulers use SECURITY DEFINER work-list functions; TenantCache builds all keys with tenant/user scope; search runs in the same tenant transaction with the scope predicate (external engines require tenant filters plus verify-after-search); authenticated responses are no-store.

## Options considered
Implicit globals; per-call tenant parameters; enforced context objects.

## Consequences
Fewer ways to forget the tenant; wrappers must be used everywhere (lint enforced).
