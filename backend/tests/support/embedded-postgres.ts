import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

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
