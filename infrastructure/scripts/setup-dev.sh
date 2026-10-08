#!/usr/bin/env bash
# Creates a local .env with a freshly generated database password. Idempotent: never overwrites.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

if [ -f .env ]; then
  echo ".env already exists; leaving it untouched."
  exit 0
fi

gen() { openssl rand -hex 24; }
sed -e "s/change_me_runtime/$(gen)/g" \
    -e "s/change_me_migrator/$(gen)/g" \
    -e "s/change_me_admin/$(gen)/g" \
    .env.example > .env
echo "Created .env with generated database passwords (not printed)."
echo "Next: start PostgreSQL with either"
echo "  docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d"
echo "  pnpm dev:db        # no Docker: embedded PostgreSQL on 127.0.0.1:54329 (also bootstraps roles + migrates)"
echo "With Docker, then run once:  pnpm db:bootstrap && pnpm db:migrate"
