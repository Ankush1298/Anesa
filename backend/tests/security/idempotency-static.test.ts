import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for the shared idempotency mechanism and the 0018 / 0019 migrations (no database needed).
const backend = resolve(import.meta.dirname, '../..');
const repo = resolve(backend, '..');
const mig = (name: string): string =>
  readFileSync(join(repo, 'database/migrations', name), 'utf8').replace(/--[^\n]*/g, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('0018 idempotency_keys: shape of the migration', () => {
  const sql = mig('0018_idempotency_keys.sql');

  it('is tenant- and principal-scoped, with composite tenant/user FK and a SHA-256 hash column', () => {
    expect(sql).toMatch(/PRIMARY KEY \(organization_id, user_id, key\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, user_id\)\s+REFERENCES app\.users \(organization_id, id\)/,
    );
    expect(sql).toMatch(/request_hash\s+char\(64\)[^,]*\^\[0-9a-f\]\{64\}\$/);
  });

  it('forces row security and adds a RESTRICTIVE per-principal policy', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FORCE\s+ROW LEVEL SECURITY/);
    const own = /CREATE POLICY idempotency_keys_own[^;]*;/.exec(sql)?.[0] ?? '';
    expect(own).toMatch(/AS RESTRICTIVE FOR ALL TO app_runtime/);
    expect(own).toMatch(/user_id = app\.current_user_id\(\)/);
  });

  it('grants the runtime role no DELETE, no table-wide UPDATE and nothing to PUBLIC', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
    expect(sql).not.toMatch(/GRANT\s+UPDATE\s+ON/i);
    expect(sql).not.toMatch(/\bPUBLIC\b/);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON app\.idempotency_keys TO app_runtime/);
    const update = /GRANT UPDATE \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    for (const fixed of ['organization_id', 'user_id', 'key']) {
      expect(update.split(',').map((c) => c.trim())).not.toContain(fixed);
    }
  });
});

describe('0019: the contract step of 0017', () => {
  const sql = mig('0019_students_required_dates_contract.sql');

  it('validates then tightens, and invents or backfills nothing', () => {
    expect(sql).toMatch(/VALIDATE CONSTRAINT students_admission_date_ck/);
    expect(sql).toMatch(/VALIDATE CONSTRAINT students_status_changed_at_ck/);
    expect(sql).toMatch(/ALTER COLUMN admission_date\s+SET NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN status_changed_at SET NOT NULL/);
    expect(sql).not.toMatch(/\bUPDATE\s+app\./i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/NO\s+FORCE|DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql.indexOf('VALIDATE CONSTRAINT')).toBeLessThan(sql.indexOf('SET NOT NULL'));
  });

  it('keeps a bounded lock wait', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });
});

describe('the existing migrations 0016 and 0017 are not edited by this phase (checksum integrity)', () => {
  // Pinned by SHA-256 of the files as committed in d135395. A deliberate future change must update this on purpose.
  it('their content is still the committed content', async () => {
    const { createHash } = await import('node:crypto');
    const sha = (n: string): string =>
      createHash('sha256')
        .update(readFileSync(join(repo, 'database/migrations', n)))
        .digest('hex');
    expect(sha('0016_person_record_exclusivity.sql')).toBe(
      'b01dcfda665b21d33329ac51bce3f8ea88a03a66554e094f5e4f99624cfb4b15',
    );
    expect(sha('0017_students_record_fields.sql')).toBe(
      '1c7ed43919dd68ab3adba91efb753bcc6b7b751a6b10d875c44704bc6df6a585',
    );
  });
});

describe('only the idempotency module writes app.idempotency_keys', () => {
  it('no other source file names the table', () => {
    const users = walk(join(backend, 'src'))
      .filter((f) => /idempotency_keys/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(backend.length + 1));
    expect(users).toEqual(['src/shared/idempotency/idempotency.ts']);
  });

  it('the module sends no SQL the tenant-tx guard rejects (no SET, no set_config, no advisory-lock or timeout control)', () => {
    const text = readFileSync(join(backend, 'src/shared/idempotency/idempotency.ts'), 'utf8');
    expect(text).not.toMatch(/set_config|pg_sleep|pg_advisory|SET LOCAL|lock_timeout\s*=/i);
    expect(text).not.toMatch(/\.query\(\s*`[^`]*\$\{/);
  });
});
