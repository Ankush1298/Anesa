/**
 * Local-only convenience: runs a persistent embedded PostgreSQL (superuser from DATABASE_ADMIN_URL),
 * then idempotently bootstraps the roles/schemas and applies migrations. Docker Compose is the
 * documented default (infrastructure/docker/docker-compose.yml). Never used in CI or production.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { bootstrapDatabase } from '../tools/db/bootstrap.js';
import { migrate } from '../tools/db/migrate.js';

function need(name: string): URL {
  const raw = process.env[name];
  if (!raw) {
    console.error(`${name} is not set. Run infrastructure/scripts/setup-dev.sh first.`);
    process.exit(1);
  }
  return new URL(raw);
}

const admin = need('DATABASE_ADMIN_URL');
const runtime = need('DATABASE_URL');
const migrator = need('MIGRATION_DATABASE_URL');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname)) {
  console.error('dev:db only manages a local database (host must be 127.0.0.1/localhost).');
  process.exit(1);
}

const dataDir = resolve(import.meta.dirname, '../../.data/postgres');
const dbName = decodeURIComponent(admin.pathname.slice(1));
const port = Number(admin.port || 5432);
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: decodeURIComponent(admin.username),
  password: decodeURIComponent(admin.password),
  port,
  persistent: true,
  onLog: () => undefined,
});

if (!existsSync(resolve(dataDir, 'PG_VERSION'))) await server.initialise();
await server.start();

const maintenance = new pg.Client({
  host: admin.hostname,
  port,
  user: decodeURIComponent(admin.username),
  password: decodeURIComponent(admin.password),
  database: 'postgres',
});
await maintenance.connect();
const exists = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (exists.rowCount === 0) {
  await maintenance.query(`CREATE DATABASE ${maintenance.escapeIdentifier(dbName)}`);
}
await maintenance.end();

await bootstrapDatabase({
  adminUrl: admin.toString(),
  runtimePassword: decodeURIComponent(runtime.password),
  migratorPassword: decodeURIComponent(migrator.password),
});
// Deliberately NO allowContract: the dev database never receives a contract migration implicitly.
const result = await migrate({ connectionString: migrator.toString() });

console.log(
  `PostgreSQL ready on ${admin.host} (database: ${dbName}); migrations applied: [${result.applied.join(', ')}]. Ctrl+C to stop.`,
);
if (result.deferred.length > 0) {
  console.warn(
    `Deferred contract migration(s) [${result.deferred.join(', ')}]: run \`pnpm db:migrate --allow-contract ${result.blockedBy}\` only after the writers are upgraded.`,
  );
}
const stop = async (): Promise<void> => {
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
