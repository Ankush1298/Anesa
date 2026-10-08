# ADR-014: Frontend: one Next.js application with role-aware shells

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-005

## Context
Small team; students/faculty on phones, admins on desktop; people may hold several roles.

## Decision
Single app with route groups for auth, student, staff, admin and insights; navigation from server-computed capabilities; lint-enforced import boundaries; PWA for student/staff; admin/insights code-split and extractable later; server authorisation is the only security boundary.

## Options considered
Separate apps; micro-frontends; single app.

## Consequences
Fast delivery and one auth client; requires boundary discipline; extraction path preserved.
