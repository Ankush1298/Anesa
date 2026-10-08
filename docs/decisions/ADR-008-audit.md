# ADR-008: Audit: central, transactional, append-only

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-007

## Context
Disputes and compliance require who/what/when/where/old/new/why for sensitive operations.

## Decision
`audit_events` (monthly partitions) written inside the same transaction as the change for MUST-audit operations; field-level diffs with sensitive values masked; reason required for CRITICAL actions; read access to sensitive data audited; app role cannot update/delete; daily digest export; retention configurable (default 7 years); viewer endpoint is scope-filtered.

## Options considered
Async logging; per-table history; central transactional log.

## Consequences
Strong evidence with modest write overhead; partition maintenance needed; domain revisions (attendance, marks) complement but do not replace the audit log.
