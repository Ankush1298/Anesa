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

## Amendment (2026-10-09): Vite + React SPA for the first foundation

The "single app, role-aware shells, capabilities from the server, server authorisation is the only
boundary" decision is **unchanged**. Only the framework differs from the original Next.js wording:

- Every screen is private behind login: there is no SEO or server-rendering need.
- A static build served behind the same reverse proxy as the API keeps all browser requests
  **same-origin**, which the cookie session and CSRF design (doc 15) depend on, and avoids running a second
  server runtime that would also hold cookies and secrets.
- Smaller supply chain and no BFF layer to secure.

The code is framework-neutral where it matters (typed API client, auth state, capability model, UI components),
so moving to Next.js later, e.g. if SSR or a public marketing site is ever required, is a re-hosting
exercise, not a rewrite. PWA/offline scope remains future work. Code: `apps/web`.
