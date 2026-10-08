# ADR-004: Authentication: short-lived tokens, rotating refresh sessions, Argon2id

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-005

## Context
Web and PWA clients; instant revocation required; passwords stored for new accounts.

## Decision
Access token (≈15 min, claims: sub, org, sid, authz_ver) signed with asymmetric keys; refresh token rotated on use inside a server-side session family with reuse detection; refresh cookie HttpOnly/Secure/SameSite=Strict with custom-header CSRF defence; tenant bound by session and host. Passwords hashed with Argon2id using current OWASP-class parameters tuned per environment; no plaintext storage; lockout and rate limits. TOTP MFA is mandatory for admin-class roles (configurable `security.mfa_required_roles`, default HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR) and recommended for others; CRITICAL permissions require a step-up (MFA within 10 minutes on the session); recovery codes provided; WebAuthn/passkeys and per-tenant SSO are schema-ready, not built in M1.

## Options considered
Server sessions only; JWT only; JWT + refresh family; bcrypt.

## Consequences
Revocation is immediate through session state; refresh endpoint needs careful CSRF handling; Argon2id memory cost must be sized for the deployment.
