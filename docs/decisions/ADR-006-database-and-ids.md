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
