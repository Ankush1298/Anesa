import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import EmbeddedPostgres from 'embedded-postgres';

// ROOT CAUSE of "failing tests exit 0": merely importing `embedded-postgres` registers (via its dependency
// `async-exit-hook`) a `beforeExit` handler that ends the process with process.exit(0). Vitest reports
// failures through `process.exitCode = 1`, so that handler silently replaced exit code 1 with 0 in every
// run that loads this module (global-db.ts imports it even when TEST_DATABASE_URL is set), which let
// `pnpm test` and `pnpm run verify` succeed with failing tests.
// Remove the two NATURAL-exit hooks: `beforeExit` (the culprit) and `exit` (the library calls its async
// shutdown there WITHOUT a `done` callback, which throws "done is not a function" once `beforeExit` no
// longer runs first; the `exit` event cannot await async cleanup anyway). The SIGINT/SIGTERM/SIGHUP
// cleanup hooks stay, and the real teardown (global-db.ts) stops the server explicitly.
// Guarded: `unhookEvent` throws if the event was already removed (several projects load this module).
const exitHook = createRequire(createRequire(import.meta.url).resolve('embedded-postgres'))(
  'async-exit-hook',
) as { hookedEvents(): string[]; unhookEvent(event: string): void };
for (const event of ['beforeExit', 'exit']) {
  if (exitHook.hookedEvents().includes(event)) exitHook.unhookEvent(event);
}

export interface RunningPostgres {
  /** Superuser connection URL for the maintenance database (test harness only). */
  adminUrl: string;
  stop: () => Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Throw-away PostgreSQL for tests: random port, random password, temp data dir, deleted on stop. */
export async function startThrowawayPostgres(): Promise<RunningPostgres> {
  const dir = await mkdtemp(join(tmpdir(), 'campusos-pg-'));
  const port = await freePort();
  const password = randomBytes(18).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'),
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  return {
    adminUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await pg.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
