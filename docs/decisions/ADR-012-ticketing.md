# ADR-012: Ticketing separate from requests with a shared kernel

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-011, ADR-009

## Context
Tickets are conversational and open-ended; requests are structured and approval-driven.

## Decision
Separate tables and UX; shared SLA policies/timers, work queues, files, outbox events, policy engine and audit; cross-links between tickets and requests; SLA timers are DB-backed and polled.

## Options considered
Single generic case entity; fully separate stacks.

## Consequences
Clear semantics with reused infrastructure; two state machines to maintain.
