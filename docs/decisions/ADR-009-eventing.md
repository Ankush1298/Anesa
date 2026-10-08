# ADR-009: Domain events through a transactional outbox

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-019

## Context
Modules must not depend on notification providers or each other's internals.

## Decision
State changes write `outbox_events` in the same transaction; a relay (via `app_system` work-list functions) dispatches to tenant-scoped jobs (BullMQ). Handlers are idempotent; events carry IDs only. Notifications, SLA timers, summary recomputation and AI hooks subscribe to events.

## Options considered
Direct calls; external broker; outbox + Redis queue.

## Consequences
At-least-once delivery requires idempotent handlers; no new infrastructure beyond Redis.
