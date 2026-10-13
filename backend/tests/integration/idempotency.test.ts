import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  runIdempotent,
  type IdempotentResponse,
  type IdempotentResult,
} from '../../src/shared/idempotency/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { CTX, type Ctx } from '../support/fixtures.js';

// The shared idempotency mechanism (0018), exercised directly with a trivial piece of "business work", against the
// shared disposable integration database. Rows committed here carry a per-run key prefix, are the only rows these tests
// look at (no tenant-wide counts), and are deleted at the end. Concurrency is synchronised with gates and by waiting
// until the second backend is observably blocked on a lock in pg_stat_activity (no sleeps for ordering).

const RUN = randomBytes(4).toString('hex');
const keyOf = (n: string): string => `it-idem-${RUN}-${n}`.padEnd(24, '0');
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 8 });
const db = new Database(pool);
// Requests that are EXPECTED to block run on their own pool with an application_name unique to this run, so
// waitUntilBlocked can identify exactly that contender and not a lock wait of some other test file that happens to run
// concurrently on the same database. Holders and ordinary calls use `db`.
const WAITER_APP = `it-idem-waiter-${RUN}`;
const waiterDb = new Database(
  createPool({
    connectionString: inject('dbRuntimeUrl'),
    ssl: false,
    max: 4,
    applicationName: WAITER_APP,
  }),
);
afterAll(async () => {
  await adminQuery('DELETE FROM app.idempotency_keys WHERE key LIKE $1', [`it-idem-${RUN}-%`]);
  await waiterDb.close();
  await db.close();
});

const ctxOf = (a: Ctx): TrustedContext =>
  issueTrustedContext({ tenantId: a.tenant, userId: a.user, actorKind: a.kind });
const staffA = ctxOf(CTX.staffA);
const facultyA = ctxOf(CTX.facultyA);
const staffB = ctxOf(CTX.staffB);

const gateOf = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

/**
 * Polls pg_stat_activity until a backend of THIS run's waiter pool (application_name) waits on a lock in a statement
 * matching `like`. Only the contender under test uses that pool, so another file's lock waits cannot satisfy it.
 */
async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $2
          AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like, WAITER_APP],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}

const OP = 'POST /test/things';
const ok = (who: string): IdempotentResponse => ({
  status: 201,
  body: { success: true, data: { who } },
});

function call(
  database: Database,
  ctx: TrustedContext,
  key: string,
  request: unknown,
  work: () => Promise<IdempotentResponse>,
  operation = OP,
): Promise<IdempotentResult> {
  return database.withTenant(ctx, (tx) =>
    runIdempotent(tx, ctx, { key, operation, request }, work),
  );
}

const stored = (key: string): Promise<Record<string, unknown>[]> =>
  adminQuery(
    `SELECT user_id, operation, request_hash, response_status, response_body, created_at, expires_at
       FROM app.idempotency_keys WHERE key = $1`,
    [key],
  );

describe('claim, store and replay', () => {
  it('the first call runs the work and stores the 2xx response; the same key + request replays it without running the work', async () => {
    const key = keyOf('replay');
    let runs = 0;
    const work = (): Promise<IdempotentResponse> => {
      runs++;
      return Promise.resolve(ok(`run-${runs}`));
    };
    const first = await call(db, staffA, key, { a: 1 }, work);
    expect(first).toEqual({ ...ok('run-1'), replayed: false });

    const second = await call(db, staffA, key, { a: 1 }, work);
    expect(second).toEqual({ ...ok('run-1'), replayed: true });
    expect(runs).toBe(1);

    const rows = await stored(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: OP, response_status: 201 });
    expect(rows[0]?.['request_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('equal requests replay whatever the key order of the request object', async () => {
    const key = keyOf('canonical');
    let runs = 0;
    const work = (): Promise<IdempotentResponse> => {
      runs++;
      return Promise.resolve(ok('x'));
    };
    await call(db, staffA, key, { a: 1, b: { c: 2, d: 3 } }, work);
    const again = await call(db, staffA, key, { b: { d: 3, c: 2 }, a: 1 }, work);
    expect(again.replayed).toBe(true);
    expect(runs).toBe(1);
  });

  it('the same key with a different request, or a different operation, is refused with 422 and runs nothing', async () => {
    const key = keyOf('mismatch');
    let runs = 0;
    const work = (): Promise<IdempotentResponse> => {
      runs++;
      return Promise.resolve(ok('x'));
    };
    await call(db, staffA, key, { a: 1 }, work);
    for (const attempt of [
      call(db, staffA, key, { a: 2 }, work),
      call(db, staffA, key, { a: 1 }, work, 'POST /test/other'),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        statusCode: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    expect(runs).toBe(1);
    // the stored record is untouched by the refused attempts
    expect((await stored(key))[0]).toMatchObject({ operation: OP, response_status: 201 });
  });

  it('is scoped to the tenant AND the principal: the same key string is an independent claim for another user and tenant', async () => {
    const key = keyOf('scope');
    const seen: string[] = [];
    const work = (who: string) => (): Promise<IdempotentResponse> => {
      seen.push(who);
      return Promise.resolve(ok(who));
    };
    const a = await call(db, staffA, key, { a: 1 }, work('staffA'));
    const f = await call(db, facultyA, key, { a: 1 }, work('facultyA')); // same tenant, other principal
    const b = await call(db, staffB, key, { a: 1 }, work('staffB')); // other tenant
    expect([a.replayed, f.replayed, b.replayed]).toEqual([false, false, false]);
    expect(seen).toEqual(['staffA', 'facultyA', 'staffB']);
    expect(await stored(key)).toHaveLength(3);
    // each principal replays its own response, never another's
    expect((await call(db, facultyA, key, { a: 1 }, work('x'))).body).toEqual(ok('facultyA').body);
    expect((await call(db, staffB, key, { a: 1 }, work('x'))).body).toEqual(ok('staffB').body);
  });
});

describe('failures are never cached', () => {
  it('a failing work rolls the claim back: no record remains and a retry runs the work for real', async () => {
    const key = keyOf('failure');
    await expect(
      call(db, staffA, key, { a: 1 }, () =>
        Promise.reject(new AppError(409, 'CONFLICT', 'business conflict')),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await stored(key)).toEqual([]);

    const retry = await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('second-try')));
    expect(retry).toEqual({ ...ok('second-try'), replayed: false });
  });

  it('a failure after a REPLACED expired claim restores the old (expired) record', async () => {
    const key = keyOf('fail-after-replace');
    await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('old')));
    await adminQuery(
      `UPDATE app.idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`,
      [key],
    );
    const before = (await stored(key))[0];
    await expect(
      call(db, staffA, key, { a: 2 }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect((await stored(key))[0]).toEqual(before);
  });

  it('a non-2xx or oversized result is a server error and is not stored', async () => {
    const k1 = keyOf('bad-status');
    await expect(
      call(db, staffA, k1, {}, () => Promise.resolve({ status: 500, body: { x: 1 } })),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(await stored(k1)).toEqual([]);

    const k2 = keyOf('too-big');
    await expect(
      call(db, staffA, k2, {}, () =>
        Promise.resolve({ status: 201, body: { blob: 'x'.repeat(20_000) } }),
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(await stored(k2)).toEqual([]);
  });
});

describe('expiry', () => {
  it('a record lives 24 hours from its claim', async () => {
    const key = keyOf('ttl');
    await call(db, staffA, key, {}, () => Promise.resolve(ok('x')));
    const [r] = await adminQuery<{ hours: string }>(
      `SELECT round(extract(epoch FROM (expires_at - created_at)) / 3600)::text AS hours
         FROM app.idempotency_keys WHERE key = $1`,
      [key],
    );
    expect(r?.hours).toBe('24');
  });

  it('an expired record is replaced in place (even for a different request and operation) and then replays the new response', async () => {
    const key = keyOf('expired');
    await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('old')));
    await adminQuery(
      `UPDATE app.idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`,
      [key],
    );

    let runs = 0;
    const work = (): Promise<IdempotentResponse> => {
      runs++;
      return Promise.resolve(ok('new'));
    };
    const replaced = await call(db, staffA, key, { a: 2 }, work, 'POST /test/other');
    expect(replaced).toEqual({ ...ok('new'), replayed: false });
    expect(runs).toBe(1);

    const rows = await stored(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: 'POST /test/other', response_status: 201 });
    expect(new Date(String(rows[0]?.['expires_at'])).getTime()).toBeGreaterThan(Date.now());

    const again = await call(db, staffA, key, { a: 2 }, work, 'POST /test/other');
    expect(again).toEqual({ ...ok('new'), replayed: true });
    // and the OLD request is now the mismatching one
    await expect(call(db, staffA, key, { a: 1 }, work)).rejects.toMatchObject({ statusCode: 422 });
    expect(runs).toBe(1);
  });

  it('two requests racing to replace the same expired record: exactly one runs the work, the other replays its response', async () => {
    const key = keyOf('expired-race');
    await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('old')));
    await adminQuery(
      `UPDATE app.idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`,
      [key],
    );
    const inside = gateOf();
    const release = gateOf();
    const ran: string[] = [];

    const winner = call(db, staffA, key, { a: 2 }, async () => {
      ran.push('winner');
      inside.open();
      await release.wait;
      return ok('winner');
    });
    await inside.wait; // the winner replaced the record and holds the row lock inside its transaction
    const loser = call(waiterDb, staffA, key, { a: 2 }, () => {
      ran.push('loser');
      return Promise.resolve(ok('loser'));
    });
    await waitUntilBlocked('%app.idempotency_keys%'); // the loser is provably waiting for the winner
    release.open();

    const [w, l] = await Promise.all([winner, loser]);
    expect(w).toEqual({ ...ok('winner'), replayed: false });
    expect(l).toEqual({ ...ok('winner'), replayed: true });
    expect(ran).toEqual(['winner']);
    expect(await stored(key)).toHaveLength(1);
  });
});

describe('concurrent requests with the same key', () => {
  it('the second waits for the first to commit, then replays its response; the work runs once', async () => {
    const key = keyOf('concurrent');
    const inside = gateOf();
    const release = gateOf();
    const ran: string[] = [];

    const first = call(db, staffA, key, { a: 1 }, async () => {
      ran.push('first');
      inside.open();
      await release.wait;
      return ok('first');
    });
    await inside.wait; // first holds the claim, uncommitted
    const second = call(waiterDb, staffA, key, { a: 1 }, () => {
      ran.push('second');
      return Promise.resolve(ok('second'));
    });
    await waitUntilBlocked('%INSERT INTO app.idempotency_keys%');
    release.open();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ ...ok('first'), replayed: false });
    expect(b).toEqual({ ...ok('first'), replayed: true });
    expect(ran).toEqual(['first']);
    expect(await stored(key)).toHaveLength(1);
  });

  it('if the first FAILS, the waiting second takes over the claim and runs the work (the failure was not cached)', async () => {
    const key = keyOf('concurrent-fail');
    const inside = gateOf();
    const release = gateOf();
    const ran: string[] = [];

    const first = call(db, staffA, key, { a: 1 }, async () => {
      ran.push('first');
      inside.open();
      await release.wait;
      throw new AppError(409, 'CONFLICT', 'first failed');
    });
    const firstOutcome = first.then(
      () => 'resolved',
      (e: unknown) => (e as AppError).statusCode,
    );
    await inside.wait;
    const second = call(waiterDb, staffA, key, { a: 1 }, () => {
      ran.push('second');
      return Promise.resolve(ok('second'));
    });
    await waitUntilBlocked('%INSERT INTO app.idempotency_keys%');
    release.open();

    expect(await firstOutcome).toBe(409);
    expect(await second).toEqual({ ...ok('second'), replayed: false });
    expect(ran).toEqual(['first', 'second']);
    expect(await stored(key)).toHaveLength(1);
  });

  it('a waiting request with a DIFFERENT body is refused with 422 once the first commits', async () => {
    const key = keyOf('concurrent-mismatch');
    const inside = gateOf();
    const release = gateOf();
    const first = call(db, staffA, key, { a: 1 }, async () => {
      inside.open();
      await release.wait;
      return ok('first');
    });
    await inside.wait;
    const second = call(waiterDb, staffA, key, { a: 999 }, () => Promise.resolve(ok('second')));
    const outcome = second.then(
      () => 'resolved',
      (e: unknown) => (e as AppError).statusCode,
    );
    await waitUntilBlocked('%INSERT INTO app.idempotency_keys%');
    release.open();
    await first;
    expect(await outcome).toBe(422);
  });

  it('a lock timeout while waiting for the same key is a deterministic 409 (retry-safe), and leaves no record behind', async () => {
    const key = keyOf('lock-timeout');
    // Test-only connection option: the waiting session uses a short lock_timeout (the runtime role's own is 10 s).
    const impatientPool = createPool({
      connectionString: `${inject('dbRuntimeUrl')}?options=-c%20lock_timeout%3D1000ms`,
      ssl: false,
      max: 2,
    });
    const impatient = new Database(impatientPool);
    const inside = gateOf();
    const release = gateOf();
    try {
      const first = call(db, staffA, key, { a: 1 }, async () => {
        inside.open();
        await release.wait;
        return ok('first');
      });
      await inside.wait;
      await expect(
        call(impatient, staffA, key, { a: 1 }, () => Promise.resolve(ok('never'))),
      ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_IN_PROGRESS' });
      release.open();
      expect(await first).toEqual({ ...ok('first'), replayed: false });
      // a retry now simply replays
      expect((await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('x')))).replayed).toBe(
        true,
      );
    } finally {
      release.open();
      await impatient.close();
    }
  });
});

describe('N simultaneous requests, losers with another body, and timeouts', () => {
  it('six simultaneous requests with the same key and request: exactly one runs the work and all six answer identically', async () => {
    const key = keyOf('burst');
    let runs = 0;
    const work = (): Promise<IdempotentResponse> => {
      runs++;
      return Promise.resolve(ok('burst'));
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(db, staffA, key, { a: 1 }, work)),
    );
    expect(runs).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    for (const r of results) expect([r.status, r.body]).toEqual([201, ok('burst').body]);
    expect(await stored(key)).toHaveLength(1);
  });

  it('simultaneous requests where only one body differs: the winner defines the record, equal bodies replay it, every other body is refused with 422', async () => {
    const key = keyOf('burst-mixed');
    const bodies = [{ a: 1 }, { a: 1 }, { a: 2 }, { a: 1 }];
    const ranFor: unknown[] = [];
    const settled = await Promise.allSettled(
      bodies.map((body) =>
        call(db, staffA, key, body, () => {
          ranFor.push(body); // evidence of which request won the claim: the only one whose work ran
          return Promise.resolve(ok(JSON.stringify(body)));
        }),
      ),
    );
    expect(ranFor).toHaveLength(1);
    const winner = ranFor[0];
    const winnerJson = JSON.stringify(winner);
    bodies.forEach((body, i) => {
      const r = settled[i]!;
      if (JSON.stringify(body) === winnerJson) {
        // same normalized body as the winner: replays (or is) the winner's response, identical for all
        expect(r).toMatchObject({
          status: 'fulfilled',
          value: { status: 201, body: ok(winnerJson).body },
        });
      } else {
        expect(r.status).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          statusCode: 422,
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
    });
    expect(settled.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(settled.filter((r) => r.status === 'fulfilled' && !r.value.replayed)).toHaveLength(1);
    expect(await stored(key)).toHaveLength(1);
  });

  it('a request with a DIFFERENT body that waited on an expired-record replacement is refused with 422 afterwards', async () => {
    const key = keyOf('expired-race-mismatch');
    await call(db, staffA, key, { a: 1 }, () => Promise.resolve(ok('old')));
    await adminQuery(
      `UPDATE app.idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE key = $1`,
      [key],
    );
    const inside = gateOf();
    const release = gateOf();
    const winner = call(db, staffA, key, { a: 2 }, async () => {
      inside.open();
      await release.wait;
      return ok('winner');
    });
    await inside.wait;
    let loserRan = false;
    const loser = call(waiterDb, staffA, key, { a: 3 }, () => {
      loserRan = true;
      return Promise.resolve(ok('loser'));
    });
    const outcome = loser.then(
      () => 'resolved',
      (e: unknown) => (e as AppError).statusCode,
    );
    await waitUntilBlocked('%app.idempotency_keys%');
    release.open();
    await winner;
    expect(await outcome).toBe(422);
    expect(loserRan).toBe(false);
    expect((await stored(key))[0]).toMatchObject({ response_status: 201 });
  });

  it('after a lock timeout the pooled connection is clean and reusable (single-connection pool), and no claim was committed for the loser', async () => {
    const key = keyOf('timeout-reuse');
    const impatient = new Database(
      new pg.Pool({
        connectionString: inject('dbRuntimeUrl'),
        max: 1,
        options: '-c lock_timeout=1000ms',
      }),
    );
    const inside = gateOf();
    const release = gateOf();
    try {
      const first = call(db, staffA, key, { a: 1 }, async () => {
        inside.open();
        await release.wait;
        return ok('first');
      });
      await inside.wait;
      await expect(
        call(impatient, staffA, key, { a: 1 }, () => Promise.resolve(ok('never'))),
      ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_IN_PROGRESS' });
      // the SAME single connection serves the next request normally (the aborted transaction was rolled back)
      const other = await call(impatient, staffA, keyOf('timeout-reuse-2'), {}, () =>
        Promise.resolve(ok('second-key')),
      );
      expect(other.replayed).toBe(false);
      release.open();
      expect(await first).toEqual({ ...ok('first'), replayed: false });
      const replay = await call(impatient, staffA, key, { a: 1 }, () => Promise.resolve(ok('x')));
      expect(replay).toEqual({ ...ok('first'), replayed: true });
      expect(await stored(key)).toHaveLength(1);
    } finally {
      release.open();
      await impatient.close();
    }
  });

  it('a STATEMENT timeout (57014) while waiting is a deterministic 503, leaves no claim, and the connection stays usable', async () => {
    const key = keyOf('statement-timeout');
    // lock_timeout disabled, statement_timeout short: the wait for the first request's claim is cancelled by the
    // statement timeout instead of the lock timeout.
    const impatient = new Database(
      new pg.Pool({
        connectionString: inject('dbRuntimeUrl'),
        max: 1,
        options: '-c lock_timeout=0 -c statement_timeout=1000',
      }),
    );
    const inside = gateOf();
    const release = gateOf();
    try {
      const first = call(db, staffA, key, { a: 1 }, async () => {
        inside.open();
        await release.wait;
        return ok('first');
      });
      await inside.wait;
      await expect(
        call(impatient, staffA, key, { a: 1 }, () => Promise.resolve(ok('never'))),
      ).rejects.toMatchObject({ statusCode: 503, code: 'DATABASE_BUSY' });
      const other = await call(impatient, staffA, keyOf('statement-timeout-2'), {}, () =>
        Promise.resolve(ok('after-timeout')),
      );
      expect(other.replayed).toBe(false);
      release.open();
      await first;
      expect(await stored(key)).toHaveLength(1);
      expect((await stored(key))[0]).toMatchObject({ response_status: 201 });
    } finally {
      release.open();
      await impatient.close();
    }
  });
});
