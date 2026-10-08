# ADR-015: Deployment: Docker-first, cloud-first, self-hosting later

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-001

## Context
Hybrid deployment desired but doubling operations at pilot is unnecessary.

## Decision
All components containerised with env-driven config and no cloud-only APIs; cloud deployment is primary; self-host packaging (installer, docs, support) is deferred until demanded; internal service ports are never published.

## Options considered
Cloud only; both from day one; Docker-first cloud-first.

## Consequences
Keeps options open at low cost; self-host support promised later, not now.
