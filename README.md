# Smart Campus OS

Multi-tenant campus platform. The authoritative design is in `docs/architecture/v3/` and
`docs/decisions/` (ADR-001…022). Security and tenant isolation take priority over feature
completeness; security tests are merge blockers.

## Status

Milestone 1, **Slice 0** (repository & infrastructure baseline) — no product features yet.

## Requirements

- Node.js ≥ 22.12 (see `.nvmrc`)
- pnpm 10 (`corepack enable` or `corepack pnpm …`)
- PostgreSQL 16: either Docker, or the built-in embedded dev server (`pnpm dev:db`)

## Quick start

```bash
corepack pnpm install
infrastructure/scripts/setup-dev.sh        # creates .env with a random DB password (git-ignored)
corepack pnpm dev:db                       # or: docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d
corepack pnpm dev                          # API on http://127.0.0.1:4000  (/health, /ready)
```

## Checks (what CI runs)

| Command                 | Purpose                                                      |
| ----------------------- | ------------------------------------------------------------ |
| `pnpm lint`             | ESLint incl. architecture gates (raw DB driver, process.env) |
| `pnpm format:check`     | Prettier                                                     |
| `pnpm typecheck`        | TypeScript (strict)                                          |
| `pnpm test:unit`        | Fast tests, no database                                      |
| `pnpm test:integration` | Real PostgreSQL (embedded locally, service container in CI)  |
| `pnpm test:security`    | Merge-blocking security/hygiene gates                        |
| `pnpm check:secrets`    | Repository secret scan                                       |
| `pnpm verify`           | All of the above                                             |

## Secrets

Never commit secrets. Only `.env.example` (placeholders) is tracked. See `docs/runbooks/secrets.md`.

## Deferred

Face/biometric attendance is not part of the build (`services/face-service/DEFERRED.md`, ADR-016).
