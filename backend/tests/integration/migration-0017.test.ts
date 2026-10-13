import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { DEFAULT_MIGRATIONS_DIR, contractVersions, migrate } from '../../tools/db/migrate.js';
import { dropAll, freshDatabase, sql, type FreshDb } from '../support/fresh-db.js';

// Migration 0017 on a database that ALREADY holds a student row (a "legacy" row from before 0017). Own throw-away
// database from tests/support/fresh-db.ts, never the shared integration database: it commits rows.
// This proves the expand-step promises: legacy rows are neither stamped nor backfilled, the NOT VALID checks guard
// new row versions, and the later contract step (not part of this phase) would be refused while a NULL remains.

let db: FreshDb;
const ORG = uuidv7();
const USER = uuidv7();
const STUDENT = uuidv7();

async function code(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
  throw new Error('expected the statement to fail');
}

beforeAll(async () => {
  db = await freshDatabase();
  // everything BEFORE 0017
  const dir = mkdtempSync(join(tmpdir(), 'campusos-mig17-'));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => !x.startsWith('0017'))) {
    cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
  }
  const before = await migrate({
    connectionString: db.migrator,
    dir,
    allowContract: contractVersions(),
  });
  expect(before.applied.at(-1)).toBe('0016');

  // a legacy student, inserted with only the pre-0017 columns (superuser: the owner cannot see tenant rows)
  await sql(
    db.admin,
    `INSERT INTO app.organizations (id, name, slug) VALUES ($1, 'Legacy College', $2)`,
    [ORG, `legacy-${ORG.slice(-8)}`],
  );
  await sql(
    db.admin,
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'h', 'ACTIVE')`,
    [USER, `legacy-${USER}@legacy.test`],
  );
  await sql(
    db.admin,
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'Legacy', 'ACTIVE', $1)`,
    [USER, ORG, `legacy-${USER}@legacy.test`],
  );
  await sql(
    db.admin,
    `INSERT INTO app.students (id, organization_id, user_id, admission_number) VALUES ($1, $2, $3, 'LEGACY-1')`,
    [STUDENT, ORG, USER],
  );

  // now 0017 on top
  const after = await migrate({ connectionString: db.migrator, allowContract: contractVersions() });
  expect(after.applied).toEqual(['0017']);
}, 180_000);

afterAll(dropAll);

describe('0017 on a database with a legacy student row', () => {
  it('does not stamp or backfill the legacy row, and leaves row security forced', async () => {
    const [row] = await sql<{ admission_date: string | null; status_changed_at: string | null }>(
      db.admin,
      'SELECT admission_date::text, status_changed_at::text FROM app.students WHERE id = $1',
      [STUDENT],
    );
    expect(row).toEqual({ admission_date: null, status_changed_at: null });
    const [flags] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      db.admin,
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.students'::regclass",
    );
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('the checks are NOT VALID: legacy rows exist, but every new row version must carry both values', async () => {
    const checks = await sql<{ conname: string; convalidated: boolean }>(
      db.admin,
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'app.students'::regclass AND conname LIKE 'students\\_%\\_ck' ORDER BY conname`,
    );
    expect(checks).toEqual([
      { conname: 'students_admission_date_ck', convalidated: false },
      { conname: 'students_status_changed_at_ck', convalidated: false },
    ]);

    // a status change on the legacy row is refused: it would write a row version with a NULL admission_date
    const blocked = await code(
      sql(db.admin, "UPDATE app.students SET status = 'ACTIVE' WHERE id = $1", [STUDENT]),
    );
    expect(blocked.code).toBe('23514');
    expect(blocked.message).toMatch(/students_admission_date_ck/);

    // a new student without admission_date is refused too
    const other = uuidv7();
    await sql(
      db.admin,
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'h', 'ACTIVE')`,
      [other, `n-${other}@legacy.test`],
    );
    await sql(
      db.admin,
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'N', 'ACTIVE', $1)`,
      [other, ORG, `n-${other}@legacy.test`],
    );
    const missing = await code(
      sql(
        db.admin,
        `INSERT INTO app.students (id, organization_id, user_id, admission_number) VALUES ($1, $2, $3, 'NEW-1')`,
        [uuidv7(), ORG, other],
      ),
    );
    expect(missing.code).toBe('23514');
  });

  // Covers the runtime role on a legacy row (status change and no-op status write, both refused while the dates are NULL).
  it('the runtime role cannot update a legacy row either, whatever it changes, until the row is backfilled', async () => {
    const asStaff = async (statement: string): Promise<{ code?: string; message?: string }> => {
      const c = new pg.Client({ connectionString: db.runtime });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                  set_config('app.actor_kind', 'STAFF', true)`,
          [ORG, USER],
        );
        return await code(c.query(statement, [STUDENT]));
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    // a status change, and a no-op status "change": both write a new row version that still has NULL dates
    for (const statement of [
      "UPDATE app.students SET status = 'ACTIVE' WHERE id = $1",
      'UPDATE app.students SET status = status WHERE id = $1',
    ]) {
      const err = await asStaff(statement);
      expect(err.code, statement).toBe('23514');
      expect(err.message, statement).toMatch(/students_(admission_date|status_changed_at)_ck/);
    }
  });

  it('validating the checks while a NULL remains is refused, even as the schema owner who cannot see tenant rows (row security does not hide rows from DDL validation)', async () => {
    const err = await code(
      sql(db.migrator, 'ALTER TABLE app.students VALIDATE CONSTRAINT students_admission_date_ck'),
    );
    expect(err.code).toBe('23514');
  });

  it('after an operator-style backfill of BOTH columns the checks validate', async () => {
    // Illustrative only: the real rule is operator-approved and applied outside the migration.
    await sql(
      db.admin,
      `UPDATE app.students SET admission_date = created_at::date, status_changed_at = created_at WHERE id = $1`,
      [STUDENT],
    );
    await sql(
      db.migrator,
      'ALTER TABLE app.students VALIDATE CONSTRAINT students_admission_date_ck',
    );
    await sql(
      db.migrator,
      'ALTER TABLE app.students VALIDATE CONSTRAINT students_status_changed_at_ck',
    );
    const checks = await sql<{ convalidated: boolean }>(
      db.admin,
      `SELECT convalidated FROM pg_constraint WHERE conrelid = 'app.students'::regclass AND conname LIKE 'students\\_%\\_ck'`,
    );
    expect(checks.every((c) => c.convalidated)).toBe(true);
  });
});
