# ADR-016: Face/biometric attendance is deferred and isolated

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-022

## Context
Biometric data is high-risk; traditional attendance is the production system; legal, retention, encryption, liveness and consent requirements are undefined.

## Decision
No face or biometric tables, services or dependencies in the core. If built, it is an optional module with its own schema and migrations, consent registry entries, encryption and deletion procedures, liveness/anti-spoofing, audit, opt-out and a mandatory alternative method, calling the attendance public interface. Prerequisite list (R-10) must be approved before design starts. Group-photo recognition is rejected.

## Options considered
Build in pilot; build later as core feature; build later as isolated optional module.

## Consequences
Pilot scope and risk shrink; scaffold folders for face service remain unused and excluded from build until a new decision.
