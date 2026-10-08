# ADR-011: Service request engine: versioned configuration with coded fulfilment actions

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-012

## Context
New services must not need new backend architecture, but a full workflow platform is unnecessary.

## Decision
Immutable published service-type versions (form schema, eligibility, SLA) plus linear workflow steps with assignee resolvers; requests pin their version; approvals append-only; fulfilment actions are a small registry of audited idempotent functions; no loops, parallelism or scripting.

## Options considered
Hard-coded services; BPMN engine; configuration plus action hooks.

## Consequences
Fast to add services; unusual flows need code; clear boundary prevents sprawl.
