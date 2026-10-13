import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../../tools/db/migrate.js';
import { dropAll, freshDatabase, sql, type FreshDb } from '../support/fresh-db.js';

// Migration 0019 (the contract step of 0017) on a database that holds a LEGACY student row. Own throw-away database
// from tests/support/fresh-db.ts, never the shared integration database: it commits rows.

let db: FreshDb;
const ORG = uuidv7();
const USER = uuidv7();
const STUDENT = uuidv7();

const ledger = async (): Promise<string[]> =>
  (
    await sql<{ version: string }>(
      db.admin,
      'SELECT version FROM platform.schema_migrations ORDER BY version',
    )
  ).map((r) => r.version);

const columns = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await sql<{ column_name: string; is_nullable: string }>(
        db.admin,
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'students'
            AND column_name IN ('admission_date', 'status_changed_at')`,
      )
    ).map((r) => [r.column_name, r.is_nullable]),
  );

const checkNames = async (): Promise<string[]> =>
  (
    await sql<{ conname: string }>(
      db.admin,
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'app.students'::regclass AND conname LIKE 'students\\_%\\_ck' ORDER BY conname`,
    )
  ).map((r) => r.conname);

beforeAll(async () => {
  db = await freshDatabase();
  // everything BEFORE 0017, so the student below is genuinely a legacy row (written under the old schema)
  const dir = mkdtempSync(join(tmpdir(), 'campusos-mig19a-'));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => Number(x.slice(0, 4)) < 17)) {
    cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
  }
  const before = await migrate({ connectionString: db.migrator, dir, allowContract: ['0009'] });
  expect(before.applied.at(-1)).toBe('0016');
  await sql(
    db.admin,
    `INSERT INTO app.organizations (id, name, slug) VALUES ($1, 'Legacy College', $2)`,
    [ORG, `legacy19-${ORG.slice(-8)}`],
  );
  await sql(
    db.admin,
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'h', 'ACTIVE')`,
    [USER, `legacy19-${USER}@legacy.test`],
  );
  await sql(
    db.admin,
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'Legacy', 'ACTIVE', $1)`,
    [USER, ORG, `legacy19-${USER}@legacy.test`],
  );
  await sql(
    db.admin,
    `INSERT INTO app.students (id, organization_id, user_id, admission_number) VALUES ($1, $2, $3, 'LEGACY-19')`,
    [STUDENT, ORG, USER],
  );

  // now the ORDINARY run: 0017 (expand) and 0018; the 0019 contract step is deferred
  const after = await migrate({ connectionString: db.migrator });
  expect(after.applied).toEqual(['0017', '0018']);
  expect(after.deferred).toEqual(['0019', '0020']);
}, 180_000);

afterAll(dropAll);

describe('0019 is gated', () => {
  it('an ordinary run never applies it, and names it as the blocker', async () => {
    const r = await migrate({ connectionString: db.migrator });
    expect(r.applied).toEqual([]);
    expect(r.deferred).toEqual(['0019', '0020']); // 0020 (the person-identity backstop) waits behind 0019
    expect(r.blockedBy).toBe('0019');
    expect(await ledger()).not.toContain('0019');
    expect(await columns()).toEqual({ admission_date: 'YES', status_changed_at: 'YES' });
  });

  it('it cannot be bundled with a pending ordinary migration (phase boundary): nothing is applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig19-'));
    const other = await freshDatabase();
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => Number(x.slice(0, 4)) < 18)) {
      cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
    await migrate({ connectionString: other.migrator, dir, allowContract: ['0009'] }); // ledger 0001-0017
    await expect(
      migrate({ connectionString: other.migrator, allowContract: ['0019'] }),
    ).rejects.toThrow(/cannot run in the same invocation as pending 0018/);
    const rows = await sql<{ version: string }>(
      other.admin,
      'SELECT version FROM platform.schema_migrations ORDER BY version DESC LIMIT 1',
    );
    expect(rows).toEqual([{ version: '0017' }]);
  });
});

describe('0019 on a database that still holds an un-backfilled legacy row', () => {
  it('is refused as a whole: the row is untouched, the ledger and the schema stay at 0018', async () => {
    await expect(
      migrate({ connectionString: db.migrator, allowContract: ['0019'] }),
    ).rejects.toMatchObject({ code: '23514' });

    expect((await ledger()).at(-1)).toBe('0018');
    expect(await columns()).toEqual({ admission_date: 'YES', status_changed_at: 'YES' });
    expect(await checkNames()).toEqual([
      'students_admission_date_ck',
      'students_status_changed_at_ck',
    ]);
    const [row] = await sql(
      db.admin,
      'SELECT admission_date::text AS d, status_changed_at::text AS s FROM app.students WHERE id = $1',
      [STUDENT],
    );
    expect(row).toEqual({ d: null, s: null }); // nothing was invented or written
  });
});

describe('0019 after an operator-approved backfill', () => {
  it('applies alone, tightens the schema, keeps the backfilled values and leaves row security forced', async () => {
    // Illustrative operator backfill, applied OUTSIDE the migration.
    await sql(
      db.admin,
      `UPDATE app.students SET admission_date = DATE '2023-08-01', status_changed_at = TIMESTAMPTZ '2023-08-01 00:00:00+00'
        WHERE id = $1`,
      [STUDENT],
    );
    const r = await migrate({ connectionString: db.migrator, allowContract: ['0019'] });
    expect(r.applied).toEqual(['0019', '0020']); // 0020 follows 0019 in the same invocation, without its own opt-in
    expect(r.deferred).toEqual([]);
    expect((await ledger()).slice(-2)).toEqual(['0019', '0020']);

    expect(await columns()).toEqual({ admission_date: 'NO', status_changed_at: 'NO' });
    expect(await checkNames()).toEqual([]); // the temporary NOT VALID checks are dropped
    const [row] = await sql(
      db.admin,
      'SELECT admission_date::text AS d FROM app.students WHERE id = $1',
      [STUDENT],
    );
    expect(row).toEqual({ d: '2023-08-01' });
    const [flags] = await sql(
      db.admin,
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.students'::regclass",
    );
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('a new student without admission_date is now refused by NOT NULL (23502); status_changed_at still defaults', async () => {
    const other = uuidv7();
    await sql(
      db.admin,
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'h', 'ACTIVE')`,
      [other, `n19-${other}@legacy.test`],
    );
    await sql(
      db.admin,
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'N', 'ACTIVE', $1)`,
      [other, ORG, `n19-${other}@legacy.test`],
    );
    await expect(
      sql(
        db.admin,
        `INSERT INTO app.students (id, organization_id, user_id, admission_number) VALUES ($1, $2, $3, 'NEW-19')`,
        [uuidv7(), ORG, other],
      ),
    ).rejects.toMatchObject({ code: '23502' });
    const ok = await sql(
      db.admin,
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date)
       VALUES ($1, $2, $3, 'NEW-19', DATE '2024-07-01') RETURNING status_changed_at IS NOT NULL AS stamped`,
      [uuidv7(), ORG, other],
    );
    expect(ok).toEqual([{ stamped: true }]);
  });

  it('running it again is a no-op', async () => {
    const r = await migrate({ connectionString: db.migrator, allowContract: ['0019'] });
    expect(r.applied).toEqual([]);
  });
});
