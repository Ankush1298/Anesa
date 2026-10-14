import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../../tools/db/migrate.js';
import { dropAll, freshDatabase, sql } from '../support/fresh-db.js';

// Migration 0020 (the database backstop of the person-identity invariant) and its ROLLOUT BOUNDARY on real databases:
// it is not a contract migration, yet the runner defers it behind the deferred contract migration 0019. Own throw-away
// databases from tests/support/fresh-db.ts; nothing here touches the shared integration database.

afterAll(dropAll);

const TRIGGERS = [
  'role_assignments_student_exclusive_ins',
  'role_assignments_student_exclusive_upd',
  'students_staff_role_exclusive_ins',
  'students_staff_role_exclusive_upd',
];
const triggersOf = async (admin: Parameters<typeof sql>[0]): Promise<string[]> =>
  (
    await sql<{ tgname: string }>(
      admin,
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname`,
      [TRIGGERS],
    )
  ).map((r) => r.tgname);
const ledgerOf = async (admin: Parameters<typeof sql>[0]): Promise<string[]> =>
  (
    await sql<{ version: string }>(
      admin,
      'SELECT version FROM platform.schema_migrations ORDER BY version',
    )
  ).map((r) => r.version);

describe('the rollout boundary', () => {
  it('ordinary run and --allow-contract 0009: 0019 AND 0020 stay deferred (blockedBy 0019) and the backstop triggers do NOT exist', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator }); // 0001-0008
    const step = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(step.applied.at(-1)).toBe('0018');
    expect(step.deferred).toEqual(['0019', '0020', '0021', '0022', '0023']);
    expect(step.blockedBy).toBe('0019');
    const again = await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    expect(again.applied).toEqual([]);
    expect(again.deferred).toEqual(['0019', '0020', '0021', '0022', '0023']);
    expect(await triggersOf(db.admin)).toEqual([]);
    expect(await ledgerOf(db.admin)).not.toContain('0020');
  }, 180_000);

  it('--allow-contract 0019 applies 0019 FIRST and 0020 right after it in the same invocation, and the triggers exist', async () => {
    const db = await freshDatabase();
    await migrate({ connectionString: db.migrator });
    await migrate({ connectionString: db.migrator, allowContract: ['0009'] });
    const last = await migrate({ connectionString: db.migrator, allowContract: ['0019'] });
    expect(last.applied).toEqual(['0019', '0020', '0021', '0022', '0023']);
    expect(last.deferred).toEqual([]);
    expect((await ledgerOf(db.admin)).slice(-6)).toEqual([
      '0018',
      '0019',
      '0020',
      '0021',
      '0022',
      '0023',
    ]);
    expect(await triggersOf(db.admin)).toEqual(TRIGGERS);
    const noop = await migrate({ connectionString: db.migrator, allowContract: ['0019'] });
    expect(noop.applied).toEqual([]);
  }, 180_000);

  it('with 0019 already in the ledger, a plain `db:migrate` (no flags) applies 0020, 0021, 0022 and 0023', async () => {
    const db = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig20-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => Number(x.slice(0, 4)) < 20)) {
      cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
    await migrate({ connectionString: db.migrator, dir, allowContract: ['0009', '0019'] });
    expect(await triggersOf(db.admin)).toEqual([]);
    const plain = await migrate({ connectionString: db.migrator });
    expect(plain.applied).toEqual(['0020', '0021', '0022', '0023']);
    expect(plain.deferred).toEqual([]);
    expect(await triggersOf(db.admin)).toEqual(TRIGGERS);
  }, 180_000);

  it('naming 0020 as a contract version is refused: it is not one', async () => {
    const db = await freshDatabase();
    await expect(
      migrate({ connectionString: db.migrator, allowContract: ['0020'] }),
    ).rejects.toThrow(/no contract migration with that exact version/);
  }, 60_000);
});
