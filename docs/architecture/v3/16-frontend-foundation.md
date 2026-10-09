# Frontend foundation v1 (`apps/web`, "Anesa")

Vite + React 19 + TypeScript SPA, React Router 7, zod. Private, authenticated, same-origin. See the amendment
in `docs/decisions/ADR-014-frontend.md`. **Nothing here is an ERP module**: pages that would belong to future
modules are placeholders labelled "Not yet available" and contain no data.

## Backend contract used (verified against `auth.routes.ts` and in a real browser)

All paths are called under the same-origin prefix `/api` (stripped by the dev proxy / production reverse proxy;
the backend itself has no prefix).

| Call | Request | Success | Failure the UI handles |
|---|---|---|---|
| `POST /auth/login` | JSON `{email, password, tenant?}` (public, origin-checked) | `200 {success:true, tenant_id, csrf_token}` + `Set-Cookie` (HttpOnly) | `401 INVALID_CREDENTIALS`, `429 TOO_MANY_REQUESTS` (+`Retry-After`), `400`, `403 CSRF_REJECTED`, `5xx`, network |
| `GET /auth/me` | cookie only | `200 {tenant_id, user_id, actor_kind, display_name, roles[], capabilities[], csrf_token}` | `401` (no/expired session), `403 FORBIDDEN` (signed in, no role assigned), `5xx`, network |
| `POST /auth/logout` | JSON `{}`; `X-CSRF-Token` sent when held (public, origin-checked) | `200 {success:true}` + cookie cleared | any failure: client state is cleared anyway |
| `GET /health` | none | `200 {status:"ok"}` | (not used by the UI) |

Error envelope: `{error:{code,message,requestId}}`. The UI keeps only `status`, `code`, `requestId`,
`Retry-After`; it never shows or logs the server's text.

### Contract mismatch found and the minimal fix
The blueprint (04, ADR-014) says the frontend renders from server-computed capabilities
(`GET /api/v1/me`: identity, roles, capabilities). The implemented `GET /auth/me` returned only
`tenant_id, user_id, actor_kind, csrf_token`: no display name and nothing to tell staff from administrators.
**Fix (additive, `backend`):** `/auth/me` now also returns `display_name`, `roles` (codes) and `capabilities`
(permission codes), computed per request by `AuthorizationEngine.describeActor` from the same effective-assignment
rule as every decision (tenant-scoped, ACTIVE/started/not-ended, sorted). It is for menus only; every action is
re-checked by the backend. Nothing is added to the session token. Tests: `tests/integration/me-profile.test.ts`.
No security control was changed. Not done: the `/api/v1` prefix and a dedicated CSRF-refresh endpoint
(re-reading `/auth/me` is the refresh).

## CSRF and session handling in the browser
* The session cookie is HttpOnly: JavaScript never reads, stores or forwards it. `fetch` uses
  `credentials: 'same-origin'`; the base path is validated to be a same-origin path (an absolute URL is rejected at
  startup), so the client cannot be configured to talk cross-origin.
* The CSRF token is delivered by `login` and `/auth/me`, kept **only in the API client's memory**, sent as
  `X-CSRF-Token` on every unsafe request, and never written to storage, cookies, URL or DOM. On `403 CSRF_REJECTED`
  the client re-reads `/auth/me` once and retries once, then reports the error.
* A `401` on any authenticated call ends the client session (CSRF token cleared, "session expired" notice on the
  login page). Logout always clears client state, even if the request fails.
* Capabilities drive the menu and a UX route guard. Neither is a security boundary.
* Tests prove: no `document.cookie` / `localStorage` / `sessionStorage` / `dangerouslySetInnerHTML` / `console` /
  absolute backend URL / tracker in `src` (static test + ESLint bans), CSRF header on unsafe requests only, retry
  once, no cookie or Authorization header set by hand, no logging, safe text rendering.
* Production bundle scanned by `pnpm check:bundle` (secrets, DB URLs, server env names, session cookie name,
  localhost origins, source maps, trackers).

## Structure
```
apps/web/src
  config/env.ts            validated public config (VITE_API_BASE_PATH, same-origin path only)
  lib/api/                 client.ts (fetch, CSRF, errors), schemas.ts (zod contracts), auth-api.ts, errors.ts, messages.ts
  features/auth/           AuthProvider (state machine), LoginPage, guards, identity (capabilities -> shell kind)
  features/shell/          AppShell (topbar, nav drawer, account menu), navigation (capability-driven)
  features/home/           student / staff / administration landing shells (placeholders)
  pages/                   Not found, Forbidden, No access, Error, Account, Coming soon
  components/ui/           Button, TextField, Alert, Spinner, Badge, Card
  styles/                  tokens.css, base.css, app.css (system fonts, no external requests)
```
Auth state: `loading -> authenticated | unauthenticated | no_access | error(retry)`.

## Accessibility and UI notes
Skip link, landmarks, one `h1` per page, focus moves to `main` on navigation, labelled inputs with
`aria-invalid`/`aria-describedby`, `role="alert"` for errors / `role="status"` for progress, 44 px touch targets,
visible focus ring, `prefers-reduced-motion` honoured, mobile drawer with `aria-expanded` + Escape. Text contrast
computed from the tokens: body 16.3:1, muted 7.7:1, white on primary 6.7:1, danger 6.6:1, input border 5.0:1.
axe-core (jsdom) reports no violations; **axe cannot evaluate colour contrast in jsdom, so contrast is by
calculation, not by tool**.

## Deferred launch requirements (not done, not claimed)
* Privacy policy, terms and cookie notice: need real product/jurisdiction review; none is written. The app
  sets one strictly-necessary session cookie and no analytics.
* Password reset / change, MFA, active-session management UI (backend flows do not exist yet).
* PWA/offline, i18n, dark mode, a CSP header and `X-Robots-Tag` (set at the reverse proxy, see
  `docs/deployment/frontend.md`), automated cross-browser/visual regression tests.
* A real forbidden-vs-404 policy per future resource screen (backend already hides existence).
* Safari does not treat `http://localhost` as a secure context, so the `Secure` session cookie will not stick
  there in development; use Chrome/Firefox or local HTTPS.
