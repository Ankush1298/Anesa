# Deploying the web client

`apps/web` builds to static files (`pnpm --filter @campusos/web build` -> `apps/web/dist`). Serve them from the
**same origin** as the API; the reverse proxy maps `/api/*` to the backend with the prefix removed. Never expose
the backend on a different origin for browsers (that would break the cookie and CSRF design).

## Local development
```bash
pnpm dev                 # backend on http://127.0.0.1:4000 (needs the dev database, see README)
pnpm dev:web             # web on http://127.0.0.1:5173 ; /api is proxied to the backend
```
The Vite proxy keeps the browser's `Host` (changeOrigin off), so the backend's development CSRF fallback
(Origin must equal the request's own origin) works with **no** `APP_ORIGINS`. Override the backend address with
`DEV_API_ORIGIN` (dev server only; never in the bundle).

## Production proxy requirements (example: nginx)
```nginx
location /api/ { proxy_pass http://backend:4000/; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
location /     { root /srv/anesa; try_files $uri /index.html; }
# index.html: Cache-Control: no-store ; /assets/*: Cache-Control: public, max-age=31536000, immutable
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
```
Set `X-Forwarded-For` to the real client address **overwriting** any incoming value, and set backend
`TRUST_PROXY=true` only behind such a proxy (the login rate limiter keys on it). Backend `APP_ORIGINS` must list
the public https origin of this site. The CSP above is compatible with the production build (no inline script,
no external hosts); it is not applied to the Vite dev server.
