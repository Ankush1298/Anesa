# Development environment

1. `corepack pnpm install`
2. `infrastructure/scripts/setup-dev.sh`
3. Database: `docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d` **or** `pnpm dev:db`
4. `pnpm dev` then `curl http://127.0.0.1:4000/ready`

Tests need no manual database: `pnpm test:integration` starts a throw-away PostgreSQL (random port,
random password, temp dir) unless `TEST_DATABASE_URL` points at a superuser URL of an existing
server (CI), in which case a uniquely named database is created and dropped.
