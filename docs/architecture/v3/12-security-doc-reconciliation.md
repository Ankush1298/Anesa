# Blueprint v3.1 — Reconciliation with `security_artitecture.md`

`security_artitecture.md` (found in this folder, unsigned) is a general security architecture. It was compared with v3.1; where they agree nothing changes. Differences and decisions:

| Topic in `security_artitecture.md` | v3.1 status |
|---|---|
| RequestContext as root of trust, mandatory first parameter | **Same** (`05` §2–3) |
| Single policy module, tenant-scoped repositories only, DTOs not entities | **Same** (`06`, `05` §3; DTO rule added to S-1 lint scope) |
| Shared schema + RLS + composite FKs, designed for promotion to schema/DB-per-tenant | **Same.** Added: `withTenant` is the single seam where a tenant→connection-target resolver can be introduced later; no code now (ADR-002) |
| IDs globally unique (UUIDv7) so rows can move between databases | **Same** (ADR-006) |
| Tenant from session; subdomain/header only a hint; disagreement ⇒ reject + audit | **Same** (host-binding, `05` §2) |
| Argon2id with optional pepper in KMS; breached-password screening | Argon2id **adopted**; pepper and breached-password check adopted as M1 settings (`security.password_policy`) |
| TOTP MFA mandatory for staff/admins; step-up for sensitive actions; recovery codes | **Adopted into M1** (was deferred): `user_mfa_factors`, `user_recovery_codes`, `sessions.step_up_at`, CRITICAL permissions require step-up (ADR-004, `10`, `09` §8) |
| Passkeys/WebAuthn, per-tenant SSO | Reserved (schema-ready), not M1 |
| Admin-initiated password reset for staff requires second approver | Adopted as a CRITICAL-permission option (`approval_required` flag in the catalog; enabled for `user.account.reset_password` in multi-admin tenants) |
| Web session cookie vs token | v3.1 keeps access token (memory) + rotating refresh cookie with CSRF header; equivalent revocation guarantees via `sessions` |
| Per-tenant encryption keys, envelope encryption of sensitive fields | **Not in M1.** MFA secrets and sensitive-class files use envelope encryption with an app-level KMS key; per-tenant keys are a post-pilot decision (new R-15) |
| Maker-checker for edits after lock | Covered by A2 override + `correction_requires_approval` policy flag (M4) |
| Anomaly detection, enumeration alerts, canaries | Nightly integrity scan in M1; denial-spike alerts and canary documents arrive with M7 / AI milestone |
| RAG namespaces + in-query filters + re-authorization; unlabeled content rejected | Adopted for the AI milestone (`03` Part 10 rule 8 extended: chunks without tenant/audience labels are rejected) |
| Per-tenant quotas and rate limits | Added to M1 rate limiting (keys include tenant) |
| 15 failure scenarios | All 15 map to X-IDs / S-gates in `09` (1–2→X-01/02/04; 3→X-12; 4→X-05/06; 5→S-9; 6→AI milestone canary test; 7,8→S-8; 9→S-7; 10→S-10; 11→S-10; 12→S-7; 13→S-11; 14→S-12; 15→S-1/S-2/S-4) |

New remaining decision **R-15**: per-tenant encryption keys and data-residency model (needed before a regulated or multi-region tenant). Default: single app-level KMS key, per-bucket keys.
