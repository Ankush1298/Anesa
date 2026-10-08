# ADR-013: AI tool gateway: in-process, session-bound, allowlisted tools

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-005, ADR-019

## Context
AI must inherit the user's security context and never choose identity, tenant, role or scope.

## Decision
The model talks only to a Tool Gateway that builds the context from the authenticated session, validates strict input schemas (no identity parameters, enforced at boot), calls application services inside withTenant (RLS and student backstop apply), returns purpose-built DTOs, and requires UI-originated confirmation for writes (prepare/submit with a bound token). Every call audited with actor_type AI. Tool outputs are untrusted data. Staff tools later resolve scope from the actor's grants, never from model input.

## Options considered
LLM with API token; LLM with SQL access; gateway.

## Consequences
Strong boundary; each tool is deliberate engineering; prompt-injection exposure limited to what the user could already do and cannot write without confirmation.
