# ADR-018: Attendance policy engine

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-007, ADR-008

## Context
Rules differ by institution, program, subject and semester; history must not change silently.

## Decision
Versioned `attendance_policies` with scope wildcards and JSON rules (minimum percentage, warning thresholds, status weights, edit window, correction approval) resolved most-specific-first and pinned to offerings at publish; statuses PRESENT/ABSENT/LATE/EXCUSED; corrections create revisions; summaries record policy and version; changing a policy requires an audited re-pin and recompute.

## Options considered
Single global rule; per-course columns; policy engine.

## Consequences
Flexible and auditable; policy resolution tests required; leave records reserved for later.
