import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { Database } from './shared/database/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const database = Database.connect({
    connectionString: config.database.url.reveal(),
    ssl: config.database.ssl,
    max: config.database.poolMax,
    onError: (err) => {
      // eslint-disable-next-line no-console -- logger not yet built; message only, no connection details
      console.error('database pool error:', err.message);
    },
  });

  // Refuse to start unless DATABASE_URL is the least-privilege runtime role (never owner/superuser).
  await database.verifyRuntimeRole();

  const app = buildApp({ config, db: database });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    // eslint-disable-next-line no-console -- startup failure before logger exists; values are never included
    console.error(err.message);
  } else {
    // eslint-disable-next-line no-console -- startup failure before logger exists
    console.error('fatal startup error:', err instanceof Error ? err.message : 'unknown');
  }
  process.exit(1);
});
