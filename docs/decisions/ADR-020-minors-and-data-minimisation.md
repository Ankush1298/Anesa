# ADR-020: Support for under-18 students and data minimisation

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-003, ADR-005

## Context
The system must not assume adults; legal requirements vary and are reviewed separately.

## Decision
Date of birth optional/configurable, 'is minor' computed from tenant age-of-majority, guardians modelled with consent/visibility/notification flags, policy settings for guardian visibility and communications, consents record who granted them, collectable student fields governed by a per-tenant register, minimal-content templates for guardian messages. No claim of legal compliance; legal review is a separate gate.

## Options considered
Assume adults; store is_minor flag; computed minor status with policies.

## Consequences
Safe by default with configurability; extra checks in notification and guardian paths; legal review remains required.
