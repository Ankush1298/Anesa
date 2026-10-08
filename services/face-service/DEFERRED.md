# DEFERRED — not built, not deployed

Face / biometric attendance is deferred and isolated (ADR-016, ADR-022). This directory holds only
the empty v2 scaffold stubs and is intentionally:

- not a pnpm workspace (see `pnpm-workspace.yaml`),
- not in Docker Compose or any CI workflow (enforced by `backend/tests/security/deferred-modules.test.ts`),
- not a dependency of the core attendance module.

Nothing here may be implemented until the prerequisites listed in the architecture decision log
(R-10: consent, retention, storage, encryption, deletion, liveness, audit, opt-out, alternatives)
are separately specified and approved.
