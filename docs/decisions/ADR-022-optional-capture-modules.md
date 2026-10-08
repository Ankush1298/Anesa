# ADR-022: Optional attendance capture modules (QR, biometric)

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-016, ADR-001

## Context
Alternative capture methods must never become core dependencies and must resist trivial abuse.

## Decision
Capture modules live outside core attendance, own their tables/schema, and write via `attendance.markFromCapture()` which applies standard validation, revision and audit. QR capture, if built, uses rotating server-validated codes with short TTL, session/device binding and optional network/location checks, with faculty review; shared static codes are rejected. Biometric modules additionally follow ADR-016.

## Options considered
Embed capture in core attendance; plugin modules.

## Consequences
Core stays simple and testable; capture modules need their own security review.
