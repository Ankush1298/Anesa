#!/usr/bin/env bash
# Creates a local .env with a freshly generated database password. Idempotent: never overwrites.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

if [ -f .env ]; then
  echo ".env already exists; leaving it untouched."
  exit 0
fi

password="$(openssl rand -hex 24)"
sed "s/change_me/${password}/g" .env.example > .env
echo "Created .env with a generated database password (not printed)."
echo "Next: start PostgreSQL with either"
echo "  docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d"
echo "  pnpm dev:db        # no Docker: embedded PostgreSQL on 127.0.0.1:54329"
