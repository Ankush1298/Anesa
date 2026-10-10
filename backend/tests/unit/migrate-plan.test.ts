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

  it('the opt-in does not reorder: on an empty ledger (fresh database) earlier migrations still run first, in one pass', () => {
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
    expect(versions(plan.deferred)).toEqual(['0009', '0010', '0011', '0012', '0013']);
    expect(versions(plan.run)).toEqual(all.slice(0, 8).map((m) => m.version));
  });

  it('loadMigrations still enforces contiguous versions regardless of the suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campusos-plan-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1');
    writeFileSync(join(dir, '0003_b_contract.sql'), 'SELECT 1');
    expect(() => loadMigrations(dir)).toThrow(/contiguous/);
  });
});

// PHASE BOUNDARY (F2.11): on an existing database the contract migration must be the first thing an invocation
// applies. The ledger is the only input, so these tests prove the planner's decision, not that the application was
// deployed or the writers drained (that remains the operator's responsibility).
describe('migration plan: phase boundary', () => {
  const REFUSED = /cannot run in the same invocation as pending/;

  it('refuses the contract migration while an earlier migration is pending on an existing database', () => {
    // 0001 applied; 0002 (expand) pending; naming 0003 must not also apply 0002
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(REFUSED);
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(/pending 0002\./);
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(/Nothing was applied/);
  });

  it('the refusal tells the operator the two-step order and keeps the exact-version confirmation', () => {
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(
      /pnpm db:migrate`.*then run `pnpm db:migrate --allow-contract 0003`/s,
    );
  });

  it('the ordinary run on the same ledger applies only the expand migration and still defers the rest', () => {
    const plan = planMigrations(M, applied('0001'));
    expect(versions(plan.run)).toEqual(['0002']);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']);
  });

  it('allows the contract migration once everything before it is applied (and later ones follow)', () => {
    const plan = planMigrations(M, applied('0001', '0002'), ['0003']);
    expect(versions(plan.run)).toEqual(['0003', '0004']);
  });

  it('naming an already-applied contract migration is a harmless no-op', () => {
    const plan = planMigrations(M, applied('0001', '0002', '0003', '0004'), ['0003']);
    expect(plan.run).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('an empty ledger (brand-new database) may be built in one pass', () => {
    expect(versions(planMigrations(M, new Map(), ['0003']).run)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
  });

  it('every contract migration needs its own invocation: a second one behind other work is refused', () => {
    const two = [
      mig('0001', 'base'),
      mig('0002', 'first_contract'),
      mig('0003', 'expand_again'),
      mig('0004', 'second_contract'),
    ];
    const done = new Map([['0001', two[0]!.checksum]]);
    // 0002 is first (allowed) but 0004 follows 0002 and 0003 in the same invocation
    expect(() => planMigrations(two, done, ['0002', '0004'])).toThrow(REFUSED);
    // separate invocations are fine
    const d3 = new Map(two.slice(0, 3).map((m) => [m.version, m.checksum]));
    expect(versions(planMigrations(two, done, ['0002']).run)).toEqual(['0002', '0003']);
    expect(versions(planMigrations(two, d3, ['0004']).run)).toEqual(['0004']);
  });

  it('a ledger that is not a contiguous prefix is refused before anything is planned', () => {
    // 0003 recorded but 0002 missing: out-of-order, cannot be produced by the runner
    expect(() => planMigrations(M, applied('0001', '0003'))).toThrow(/not a contiguous prefix/);
    expect(() => planMigrations(M, applied('0003'), ['0003'])).toThrow(/not a contiguous prefix/);
    expect(() => planMigrations(M, applied('0002'))).toThrow(/0002 is recorded but 0001 is not/);
  });

  describe('against the real migrations 0007 / 0008 / 0009', () => {
    const all = loadMigrations();
    const upTo = (n: number): Map<string, string> =>
      new Map(all.filter((m) => Number(m.version) <= n).map((m) => [m.version, m.checksum]));

    it('ledger at 0007: the ordinary run applies 0008 and defers 0009', () => {
      const plan = planMigrations(all, upTo(7));
      expect(versions(plan.run)).toEqual(['0008']);
      expect(versions(plan.deferred)).toEqual(['0009', '0010', '0011', '0012', '0013']);
    });

    it('ledger at 0007: --allow-contract 0009 is REFUSED, so 0008 and 0009 are not run in one invocation', () => {
      expect(() => planMigrations(all, upTo(7), ['0009'])).toThrow(REFUSED);
      expect(() => planMigrations(all, upTo(7), ['0009'])).toThrow(/pending 0008\./);
    });

    it('ledger anywhere before 0008: --allow-contract 0009 is refused, whatever else is pending', () => {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        expect(() => planMigrations(all, upTo(n), ['0009']), `ledger at 000${n}`).toThrow(REFUSED);
      }
    });

    it('ledger at 0008: --allow-contract 0009 runs 0009, 0010, 0011, 0012, and 0013; without the flag it stays deferred', () => {
      expect(versions(planMigrations(all, upTo(8), ['0009']).run)).toEqual([
        '0009',
        '0010',
        '0011',
        '0012',
        '0013',
      ]);
      const ordinary = planMigrations(all, upTo(8));
      expect(ordinary.run).toEqual([]);
      expect(versions(ordinary.deferred)).toEqual(['0009', '0010', '0011', '0012', '0013']);
    });

    it('ledger at 0009: runs pending ordinary migrations 0010, 0011, 0012, and 0013; ledger at 0013 has nothing to run', () => {
      for (const allow of [[], ['0009']]) {
        const plan = planMigrations(all, upTo(9), allow);
        expect(versions(plan.run)).toEqual(['0010', '0011', '0012', '0013']);
        expect(plan.deferred).toEqual([]);
      }
      for (const allow of [[], ['0009']]) {
        const plan = planMigrations(all, upTo(13), allow);
        expect(plan.run).toEqual([]);
        expect(plan.deferred).toEqual([]);
      }
    });

    it('empty ledger: a brand-new database is built in one pass when 0009 is named', () => {
      expect(versions(planMigrations(all, new Map(), ['0009']).run)).toEqual(
        all.map((m) => m.version),
      );
    });

    it('inconsistent ledgers are refused: 0009 without 0008, a gap, or a version missing from source control', () => {
      const without0008 = upTo(9);
      without0008.delete('0008');
      expect(() => planMigrations(all, without0008, ['0009'])).toThrow(/not a contiguous prefix/);
      const gap = upTo(7);
      gap.delete('0004');
      expect(() => planMigrations(all, gap)).toThrow(/not a contiguous prefix/);
      expect(() => planMigrations(all, new Map([...upTo(13), ['0014', 'x']]))).toThrow(
        /missing from source control/,
      );
    });

    it('a changed checksum is still reported as drift, not as a phase problem', () => {
      const drifted = upTo(8);
      drifted.set('0008', 'f'.repeat(64));
      expect(() => planMigrations(all, drifted, ['0009'])).toThrow(/checksum drift/);
    });
  });
});
