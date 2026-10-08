/**
 * Local-only convenience: runs a persistent embedded PostgreSQL using the credentials in
 * DATABASE_URL (so developers without Docker can work). Docker Compose is the documented default:
 * infrastructure/docker/docker-compose.yml. Never used in CI or production.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const raw = process.env['DATABASE_URL'];
if (!raw) {
  console.error('DATABASE_URL is not set. Run infrastructure/scripts/setup-dev.sh first.');
  process.exit(1);
}
const url = new URL(raw);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  console.error('dev:db only manages a local database (host must be 127.0.0.1/localhost).');
  process.exit(1);
}

const dataDir = resolve(import.meta.dirname, '../../.data/postgres');
const dbName = decodeURIComponent(url.pathname.slice(1));
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  onLog: () => undefined,
});

if (!existsSync(resolve(dataDir, 'PG_VERSION'))) await server.initialise();
await server.start();

const admin = new pg.Client({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: 'postgres',
});
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
await admin.end();

console.log(`PostgreSQL ready on ${url.host} (database: ${dbName}). Ctrl+C to stop.`);
const stop = async (): Promise<void> => {
  await server.stop();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
