import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { bootstrapDatabase } from '../../tools/db/bootstrap.js';
import { createBootstrappedDatabase } from '../support/bootstrap-lock.js';
import {
  CLUSTER_BOOTSTRAP_LOCK_KEY,
  dropAll,
  freshDatabase,
  sql,
  withClusterBootstrapLock,
} from '../support/fresh-db.js';

// Regression for "tuple concurrently updated": roles are cluster-wide, so database bootstraps that run at the same
// moment in different test files must be serialised. All on the DISPOSABLE server provided by the global setup.
afterAll(dropAll);

const server = (): string => inject('serverAdminUrl');
/** Advisory-lock rows for the bootstrap key (cluster-wide view). Other test files bootstrap concurrently, so
 *  assertions below always look at ONE session (by pid), never at "no holder at all". */
const lockRows = (granted: boolean): Promise<{ pid: number }[]> =>
  sql<{ pid: number }>(
    server(),
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted = $2`,
    [CLUSTER_BOOTSTRAP_LOCK_KEY, granted],
  );
const sessionAlive = async (pid: number): Promise<boolean> =>
  (await sql(server(), 'SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).length > 0;
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

describe('cluster-wide bootstrap lock', () => {
  it('many concurrent freshDatabase() calls all succeed (this raced before the lock existed)', async () => {
    const dbs = await Promise.all(Array.from({ length: 8 }, () => freshDatabase()));
    expect(new Set(dbs.map((d) => d.name)).size).toBe(8);
    for (const d of dbs) {
      const roles = await sql<{ rolname: string }>(
        d.admin,
        `SELECT rolname FROM pg_roles WHERE rolname IN ('app_migrator', 'app_runtime') ORDER BY 1`,
      );
      expect(roles.map((r) => r.rolname)).toEqual(['app_migrator', 'app_runtime']);
    }
  });

  it('the global-setup path (createBootstrappedDatabase) is serialised too: concurrent calls all succeed', async () => {
    // global-db.ts provisions its database through exactly this function, so another process or project bootstrapping
    // the same server at the same moment takes the same lock.
    const passwords = {
      runtime: decodeURIComponent(new URL(inject('dbRuntimeUrl')).password),
      migrator: decodeURIComponent(new URL(inject('dbMigratorUrl')).password),
    };
    const names = Array.from(
      { length: 6 },
      () => `campusos_test_${randomBytes(6).toString('hex')}`,
    );
    try {
      const admins = await Promise.all(
        names.map((n) => createBootstrappedDatabase(server(), n, passwords)),
      );
      expect(new Set(admins).size).toBe(6);
      for (const admin of admins) {
        const roles = await sql<{ rolname: string }>(
          admin,
          `SELECT rolname FROM pg_roles WHERE rolname IN ('app_migrator', 'app_runtime') ORDER BY 1`,
        );
        expect(roles).toHaveLength(2);
      }
    } finally {
      for (const n of names) await sql(server(), `DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    }
  });

  it('a second bootstrap waits while the lock is held, and proceeds when it is released', async () => {
    const held = gate();
    const release = gate();
    let holderPid = 0;
    const holder = withClusterBootstrapLock(async (pid) => {
      holderPid = pid;
      held.open();
      await release.wait;
    });
    await held.wait;
    expect((await lockRows(true)).map((r) => r.pid)).toContain(holderPid);

    let done = false;
    const second = freshDatabase().then((d) => {
      done = true;
      return d;
    });
    for (let i = 0; i < 200 && (await lockRows(false)).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await lockRows(false)).length).toBeGreaterThanOrEqual(1); // queued behind the holder...
    expect((await lockRows(false)).map((r) => r.pid)).not.toContain(holderPid);
    expect(done).toBe(false); // ...and has not run

    release.open();
    await holder;
    const db = await second;
    expect(db.name).toMatch(/^campusos_mig_/);
    expect((await lockRows(true)).map((r) => r.pid)).not.toContain(holderPid);
    expect(await sessionAlive(holderPid)).toBe(false); // the holder's connection is gone
  });

  it('releases the lock and the connection when the guarded work fails, and the error is not swallowed', async () => {
    const boom = new Error('work failed on purpose');
    let pid = 0;
    await expect(
      withClusterBootstrapLock((p) => {
        pid = p;
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);
    expect(pid).toBeGreaterThan(0);
    expect((await lockRows(true)).map((r) => r.pid)).not.toContain(pid);
    expect(await sessionAlive(pid)).toBe(false);
  });

  it('releases the lock when the real bootstrap fails (not a superuser)', async () => {
    const db = await freshDatabase();
    let pid = 0;
    await expect(
      withClusterBootstrapLock((p) => {
        pid = p;
        return bootstrapDatabase({
          adminUrl: db.runtime,
          runtimePassword: 'x',
          migratorPassword: 'y',
        });
      }),
    ).rejects.toThrow(/superuser/);
    expect((await lockRows(true)).map((r) => r.pid)).not.toContain(pid);
    expect(await sessionAlive(pid)).toBe(false);
    await withClusterBootstrapLock(() => Promise.resolve()); // the next caller is not blocked
  });
});
