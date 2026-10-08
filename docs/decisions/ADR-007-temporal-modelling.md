# ADR-007: Historical accuracy: effective-dated rows, snapshots and revisions

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-003, ADR-008, ADR-018

## Context
Sections, departments, faculty, subjects and policies change; past attendance and results must remain correct.

## Decision
Memberships are dated rows with overlap protection; published offerings and result lines snapshot official fields; attendance and marks changes create append-only revisions; results are versioned; 'current' is derived by query/view; closed terms are locked with audited overrides.

## Options considered
Mutable columns; event sourcing; system-versioned tables.

## Consequences
Queries are slightly more involved but history is reproducible and explainable; no retroactive rewriting without audit.
