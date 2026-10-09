# CSRF, session cookie and login-abuse controls

Implements the cookie-session hardening required before any state-changing authenticated route
exists. Code: `backend/src/modules/auth/{csrf,session-cookie,login-limiter,auth.hook,auth.routes}.ts`.

## Session cookie

* Name `session_token`, value = 32 random bytes (base64url). It is **not signed**: the server looks it up by
  its SHA-256 hash in `platform.auth_sessions`, so a signing secret would add nothing. `@fastify/cookie`
  is registered **without** a secret (the former `change_me_session_secret` placeholder is gone).
* Attributes (single definition, `session-cookie.ts`, reused for set **and** clear): `HttpOnly; Secure;
  SameSite=Lax; Path=/`, no `Domain`, `Max-Age=43200`. `Secure` is always on (browsers treat
  `http://localhost` as a secure context); there is no insecure fallback.
* Logout revokes the session row and clears the cookie with identical attributes, so the browser drops the
  same cookie it was given.
* Not used: the `__Host-` prefix (it would rename the cookie; candidate hardening once a frontend exists).

## CSRF (three layers; SameSite is never the only one)

1. **Origin check, every state-changing request (public ones included, so forced login/logout is blocked).**
   If an `Origin` header is present it must be in `APP_ORIGINS` (exact origins, `https` required in
   production; startup fails closed if unset in production). With no allow-list (development only) it must
   equal the request's own origin. `Origin: null` and unparsable origins are rejected. With no `Origin`,
   `Sec-Fetch-Site` must be `same-origin` or `none` when present.
2. **Per-session token, every authenticated state-changing request.** Header `X-CSRF-Token` must equal
   `base64url(SHA-256("campusos.csrf.v1:" + session_token))`, compared in constant time. It is derived, so it
   needs no extra secret or storage, is bound to one session, and stops working at logout/expiry/revocation.
   The browser gets it in the JSON of `POST /auth/login` and `GET /auth/me` and must keep it in memory (not
   in a cookie or `localStorage`). It cannot be computed without the HttpOnly cookie.
3. `SameSite=Lax` on the cookie (defence in depth).

Safe methods (`GET`, `HEAD`, `OPTIONS`) are unaffected. No CORS is enabled; the custom header would also force
a preflight for cross-site callers. Order of checks: origin → authentication (401) → CSRF token (403) →
authorization.

Tests prove the hook with test-only routes registered inside the test file; no production mutation route
exists or is needed. A static test asserts that only `/auth/login` and `/auth/logout` are public unsafe routes.

### Limitations
* A same-origin XSS can read the CSRF token from page memory; CSRF protection does not defend against XSS.
* Absent `Origin` (non-browser clients) relies on the token alone, which is the intended behaviour.
* A subdomain you do not control that is in `APP_ORIGINS` is trusted; keep the list to exact app origins.
* `GET` must stay free of side effects; the hook does not protect state changes made over `GET`.

## Login abuse

| Control | Key | Limit | Effect |
|---|---|---|---|
| Per (IP, account) | IP + SHA-256(email) | 5 failures / 15 min | `429`, `Retry-After`; correct password also refused until expiry |
| Per IP | IP | 20 failures / 15 min | `429` (password spraying) |
| Per account (database) | identity | 10 failures | 15-minute lock, **not extended** while active, counter restarts after expiry |

* Checked before any password hashing; the decision never depends on whether the account exists, e-mails are
  never stored in the limiter, and the `429` body is identical for real and nonexistent accounts.
* An attacker's IP only exhausts its own (IP, account) budget, so it cannot block the victim signing in from
  the victim's IP. Locking a victim's account via the database control needs 10 failures from **at least two**
  IPs; the lock is bounded to 15 minutes and cannot be prolonged by further attempts. A determined distributed
  attacker can still cause repeated 15-minute locks; mitigate operationally (alerts) and with MFA later.
* A successful login clears only the (IP, account) budget, never the per-IP one.
* Client IP is `request.ip`; `X-Forwarded-For` is honoured **only** when `TRUST_PROXY=true`. Set it only behind
  a proxy that overwrites the header; with `true`, Fastify trusts all hops, so a directly reachable server
  would be spoofable.
* Memory: at most 10 000 tracked keys; expired entries are swept first, then the oldest are evicted. Entries
  expire after 15 minutes.
* **Single instance only.** Counters are in process memory: they reset on restart and are not shared between
  backend instances. For more than one instance move them to a shared store behind the same interface.
