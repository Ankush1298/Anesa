# ADR-021: Concurrency and data integrity

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-006, ADR-008

## Context
Concurrent edits must not silently corrupt data.

## Decision
Optimistic locking with `version` and `If-Match`; guarded state transitions; DB-enforced uniqueness, exclusion and checks; idempotency keys scoped to tenant and user; row-locked sequences; atomic business-change + audit + outbox transactions.

## Options considered
Last-write-wins; pessimistic locks everywhere; optimistic locking plus constraints.

## Consequences
Clients must handle 409/428; tests include parallel scenarios.
