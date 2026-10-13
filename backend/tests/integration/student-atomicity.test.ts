import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { contractVersions, migrate } from '../../tools/db/migrate.js';
import { dropAll, freshDatabase, sql, type FreshDb } from '../support/fresh-db.js';
import { ORG_C, seedFixtures, STAFF_C } from '../support/fixtures.js';

// A REAL audit-write failure inside the student create, through the HTTP route: the current month's audit partition
// is dropped on a throw-away database (the same technique as the role-grant test in migrations.test.ts), so the audit
// INSERT fails inside PostgreSQL after the student row and the idempotency claim have been written. The whole
// transaction must roll back, and the same Idempotency-Key must then succeed. Own database: it commits rows and
// alters the partition layout, so it never touches the shared integration database.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';

let db: FreshDb;
let fresh: Database;
let app: ReturnType<typeof buildApp>;
let session: { cookie: string; csrf: string };
let month: { ym: string; start: string; next: string };

const target = uuidv7();
const payload = {
  userId: target,
  admissionNumber: 'ATOM-1',
  admissionDate: '2024-07-01',
  reason: 'Admitted after counselling',
};
const KEY = randomUUID();

const post = (key: string, body: object = payload) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/students',
    payload: body,
    cookies: { session_token: session.cookie },
    headers: { origin: APP_ORIGIN, 'x-csrf-token': session.csrf, 'idempotency-key': key },
  });

const counts = async (key: string) => ({
  students: (await sql(db.admin, 'SELECT 1 FROM app.students WHERE user_id = $1', [target])).length,
  claims: (await sql(db.admin, 'SELECT 1 FROM app.idempotency_keys WHERE key = $1', [key])).length,
  audits: (
    await sql(
      db.admin,
      `SELECT 1 FROM app.audit_events WHERE action = 'student.record.create' AND organization_id = $1`,
      [ORG_C],
    )
  ).length,
});

beforeAll(async () => {
  db = await freshDatabase();
  await migrate({ connectionString: db.migrator, allowContract: contractVersions() });
  await seedFixtures(db.admin);
  await sql(db.admin, 'UPDATE platform.identities SET password_hash = $1 WHERE id = $2', [
    await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    STAFF_C,
  ]);
  await sql(
    db.admin,
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'target.atom@college-c.test', 'x', 'ACTIVE')`,
    [target],
  );
  await sql(
    db.admin,
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, 'target.atom@college-c.test', 'Target', 'ACTIVE', $1)`,
    [target, ORG_C],
  );
  const [m] = await sql<{ ym: string; start: string; next: string }>(
    db.admin,
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM') AS ym,
            to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS start,
            to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month', 'YYYY-MM-DD') AS next`,
  );
  month = m!;
  fresh = new Database(createPool({ connectionString: db.runtime, ssl: false, max: 4 }));
  app = buildApp({
    config: loadConfig({ DATABASE_URL: db.runtime, APP_ORIGINS: APP_ORIGIN }),
    db: fresh,
    logger: false,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'staff.c@college-c.test', password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  session = {
    cookie: login.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: login.json<{ csrf_token: string }>().csrf_token,
  };
}, 180_000);

afterAll(async () => {
  await app?.close();
  await fresh?.close();
  await dropAll();
});

describe('student create: a failing audit write undoes everything, and the same key then succeeds', () => {
  it('audit INSERT fails inside PostgreSQL ⇒ 500 AUDIT_WRITE_FAILED, no student, no claim, no audit row', async () => {
    await sql(db.admin, `DROP TABLE app.audit_events_${month.ym}`); // "the provisioned months ran out"
    const r = await post(KEY);
    expect(r.statusCode).toBe(500);
    expect(r.json<{ error: { code: string; message: string } }>().error.code).toBe(
      'AUDIT_WRITE_FAILED',
    );
    expect(r.json<{ error: { message: string } }>().error.message).not.toMatch(/partition/i);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(await counts(KEY)).toEqual({ students: 0, claims: 0, audits: 0 });
  });

  it('a second attempt with the same key while the audit is STILL broken fails the same way (nothing was cached)', async () => {
    const r = await post(KEY);
    expect(r.statusCode).toBe(500);
    expect(await counts(KEY)).toEqual({ students: 0, claims: 0, audits: 0 });
  });

  it('once the partition exists, the SAME key and body succeed as a fresh request (201, not a replay) and commit all three rows', async () => {
    await sql(
      db.admin,
      `CREATE TABLE app.audit_events_${month.ym} PARTITION OF app.audit_events
         FOR VALUES FROM ('${month.start} 00:00:00+00') TO ('${month.next} 00:00:00+00')`,
    );
    const r = await post(KEY);
    expect(r.statusCode).toBe(201);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(await counts(KEY)).toEqual({ students: 1, claims: 1, audits: 1 });

    const again = await post(KEY);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(r.json());
    expect(await counts(KEY)).toEqual({ students: 1, claims: 1, audits: 1 });
  });
});
