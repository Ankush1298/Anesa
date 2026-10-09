import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contractVersions,
  isContractMigration,
  loadMigrations,
  planMigrations,
  type Migration,
} from '../../tools/db/migrate.js';

// The expand/contract gate, as a pure function (no database): see docs/architecture/v3/18-academic-structure-f21.md.
const mig = (version: string, name: string): Migration => ({
  version,
  name,
  sql: `-- ${version}`,
  checksum: `sum-${version}`.padEnd(64, '0'),
});
const M = [
  mig('0001', 'base'),
  mig('0002', 'expand'),
  mig('0003', 'tighten_contract'),
  mig('0004', 'later_feature'),
];
const applied = (...versions: string[]): Map<string, string> =>
  new Map(versions.map((v) => [v, M.find((m) => m.version === v)!.checksum]));
const versions = (ms: readonly Migration[]): string[] => ms.map((m) => m.version);

describe('migration plan: contract gate', () => {
  it('only a name ending in _contract designates a contract migration', () => {
    expect(isContractMigration({ name: 'tighten_contract' })).toBe(true);
    expect(isContractMigration({ name: 'contract_notes' })).toBe(false);
    expect(isContractMigration({ name: 'contracts' })).toBe(false);
  });

  it('by default it runs everything before the contract migration and defers it AND everything after it', () => {
    const plan = planMigrations(M, new Map());
    expect(versions(plan.run)).toEqual(['0001', '0002']);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']); // 0004 must not run ahead of 0003
  });

  it('a deferred contract migration stays deferred on every later ordinary run', () => {
    const plan = planMigrations(M, applied('0001', '0002'));
    expect(plan.alreadyApplied).toEqual(['0001', '0002']);
    expect(plan.run).toEqual([]);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']);
  });

  it('naming the exact version runs it, in order, followed by the later migrations', () => {
    const plan = planMigrations(M, applied('0001', '0002'), ['0003']);
    expect(versions(plan.run)).toEqual(['0003', '0004']);
    expect(plan.deferred).toEqual([]);
  });

  it('the opt-in does not reorder: earlier pending migrations still run first', () => {
    expect(versions(planMigrations(M, new Map(), ['0003']).run)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
  });

  it('a wrong, malformed, wildcard or non-contract opt-in is an error and authorises nothing', () => {
    for (const bad of ['0004', '0001', '0099', '3', '0003 ', '0003,0004', 'all', '*', '']) {
      expect(() => planMigrations(M, new Map(), [bad]), JSON.stringify(bad)).toThrow(
        /no contract migration with that exact version/,
      );
    }
  });

  it('already-applied contract migrations need no opt-in and are not re-run', () => {
    const plan = planMigrations(M, applied('0001', '0002', '0003', '0004'));
    expect(plan.run).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.alreadyApplied).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('checksum drift and a migration missing from source control are errors, even behind a blocked one', () => {
    const drifted = new Map([['0001', 'f'.repeat(64)]]);
    expect(() => planMigrations(M, drifted)).toThrow(/checksum drift/);
    expect(() => planMigrations(M, new Map([['0009', 'x']]))).toThrow(
      /missing from source control/,
    );
  });

  it('the real migration directory designates 0009 (and only 0009) as a contract migration', () => {
    expect(contractVersions()).toEqual(['0009']);
    const all = loadMigrations();
    const plan = planMigrations(all, new Map());
    expect(versions(plan.deferred)).toEqual(['0009']);
    expect(versions(plan.run)).toEqual(all.slice(0, 8).map((m) => m.version));
  });

  it('loadMigrations still enforces contiguous versions regardless of the suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campusos-plan-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1');
    writeFileSync(join(dir, '0003_b_contract.sql'), 'SELECT 1');
    expect(() => loadMigrations(dir)).toThrow(/contiguous/);
  });
});
