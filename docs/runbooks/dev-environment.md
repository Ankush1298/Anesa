# Development environment

1. `corepack pnpm install`
2. `infrastructure/scripts/setup-dev.sh`
3. Database: `docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d` **or** `pnpm dev:db`
4. `pnpm dev` then `curl http://127.0.0.1:4000/ready`

Tests need no manual database: `pnpm test:integration` starts a throw-away PostgreSQL (random port,
random password, temp dir) unless `TEST_DATABASE_URL` points at a superuser URL of an existing
server (CI), in which case a uniquely named database is created and dropped.

### Sharing one PostgreSQL server between test runs (`TEST_DATABASE_URL`)

The application roles `app_migrator` / `app_runtime` are cluster-wide, so how a server is shared matters:

- **One vitest process, several database projects** (e.g. `pnpm test`, or `--project integration --project security-db`):
  supported. All projects of the run use the same generated role passwords (`tests/support/role-passwords.ts`), and
  every role/database bootstrap (global setup and test-time fresh databases) takes one advisory lock on the server's
  maintenance database (`tests/support/bootstrap-lock.ts`, key `727301002`), so bootstraps never overlap.
- **CI** (`.github/workflows/ci.yml`): one job, one service container, and the database projects run as separate
  sequential steps (`pnpm test:integration`, then `pnpm test:security`, whose only database project is `security-db`),
  so two vitest processes never use the container at the same time.
- **Two vitest processes at the same time on one server: not supported.** The lock stops the catalog race, but each
  process re-sets the roles' passwords for its own run and invalidates the other's connections
  (`password authentication failed for user "app_runtime"`). Run them one after the other, or give each its own server.
