# ADR-001: Application architecture: modular monolith

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-009, ADR-022

## Context
Small team, evolving product, strong transactional needs (attendance, audit), future SaaS growth.

## Decision
A single deployable Node/TypeScript (Fastify) application organised as modules with enforced boundaries (public service interfaces only, no cross-module table access, domain events for coupling). Shared kernel: tenancy, db, policy, audit, events, jobs, cache, storage. Optional capabilities (QR capture, biometrics) are separate modules/processes that depend on core, never the reverse.

## Options considered
Microservices; serverless functions; modular monolith.

## Consequences
Simple operations and ACID transactions across modules; discipline required (dependency-cruiser rules in CI); extraction later is possible along event/interface seams.
