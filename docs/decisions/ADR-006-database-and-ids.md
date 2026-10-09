# ADR-006: Database platform, identifiers and conventions

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-002, ADR-021

## Context
Relational, history-heavy academic data; distributed-friendly sortable IDs; unpredictable IDs are not authorisation.

## Decision
PostgreSQL 15+, Drizzle plus reviewed SQL migrations, UUIDv7 generated in the application, no sequential public IDs, varchar+CHECK enums, effective-dating with exclusion constraints, no cascade deletes, timestamptz everywhere, money in minor units, versioned forward-only migrations (expand/migrate/contract). Separate DB roles for migration, runtime, system.

## Options considered
Prisma/other ORMs; UUIDv4; native enums; Postgres 18 uuidv7().

## Consequences
Predictable SQL and index locality; hand-written SQL for RLS/exclusion helpers; ID generation lives in one package.

## Amendment (2026-10-10): the expand/contract gate is enforced by the migration runner
"expand/migrate/contract" is no longer only a convention. A migration whose file name ends in `_contract`
(e.g. `0009_role_scope_integrity_contract.sql`) is a **contract migration**: `tools/db/migrate.ts` never runs it in an
ordinary invocation. The run applies everything before it, stops at the first contract migration, applies nothing
after it (later migrations may depend on it) and reports it as deferred. It runs only when the operator names its
exact version (`pnpm db:migrate --allow-contract 0009`); there is no environment variable and no wildcard, and
`pnpm dev:db` never authorises one. Disposable test databases opt in explicitly. Details and the release order:
`docs/architecture/v3/18-academic-structure-f21.md`.
