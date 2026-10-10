import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  SETTING_DEFINITIONS,
  SETTING_KEY_MAX_LENGTH,
  SETTING_KEY_PATTERN,
  findSettingDefinition,
  isValidSettingValue,
  parseIfMatch,
  computeCollectionETag,
} from '../../src/shared/settings/index.js';

// The settings registry (docs/architecture/v3/02 §4.2): no database needed.
const KEY_RE = new RegExp(SETTING_KEY_PATTERN);
const def = (key: string) => {
  const d = findSettingDefinition(key);
  if (!d) throw new Error(`setting ${key} is not registered`);
  return d;
};

describe('settings registry: structure', () => {
  it('registers exactly the keys whose type the architecture states completely (no invented keys)', () => {
    expect(SETTING_DEFINITIONS.map((d) => d.key).sort()).toEqual([
      'guardian.academic_visibility',
      'guardian.notification_policy',
      'identity.age_of_majority',
      'identity.dob_required',
    ]);
  });

  it('keys are unique, well-formed and within the 100-character column limit', () => {
    const keys = SETTING_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(k, k).toMatch(KEY_RE);
      expect(k.length, k).toBeLessThanOrEqual(SETTING_KEY_MAX_LENGTH);
    }
  });

  it('the only registered default is the one the document states (identity.age_of_majority = 18)', () => {
    const withDefault = SETTING_DEFINITIONS.filter((d) => d.default !== undefined);
    expect(withDefault.map((d) => [d.key, d.default])).toEqual([['identity.age_of_majority', 18]]);
  });

  it('every registered default satisfies its own schema', () => {
    for (const d of SETTING_DEFINITIONS) {
      if (d.default !== undefined) expect(isValidSettingValue(d, d.default), d.key).toBe(true);
    }
  });

  it('the key pattern rejects spellings the database and routes must never see', () => {
    for (const bad of [
      '',
      'Identity.age_of_majority',
      '.identity',
      'identity.',
      'identity..x',
      'identity.age-of-majority',
      '1identity',
      'identity age',
      "identity.x'; DROP TABLE app.organizations;--",
      '../etc/passwd',
    ]) {
      expect(KEY_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('settings registry: lookup is exact', () => {
  it('finds registered keys and nothing else, whatever the spelling or prototype tricks', () => {
    expect(findSettingDefinition('identity.age_of_majority')).toBeDefined();
    for (const bad of [
      'Identity.age_of_majority',
      ' identity.age_of_majority',
      'identity.age_of_majority ',
      'identity.age_of_majority\n',
      'identity.unknown_dob_policy', // referenced by doc 02 §4.4 but not completely specified: not registered
      'terminology',
      'security.password_policy',
      '__proto__',
      'constructor',
      'toString',
      '',
    ]) {
      expect(findSettingDefinition(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('settings registry: value validation', () => {
  it('identity.age_of_majority accepts integers 0..150 only', () => {
    const d = def('identity.age_of_majority');
    for (const ok of [0, 1, 16, 18, 21, 150])
      expect(isValidSettingValue(d, ok), String(ok)).toBe(true);
    for (const bad of [
      -1,
      151,
      18.5,
      1e9,
      '18',
      null,
      true,
      false,
      [],
      {},
      [18],
      { v: 18 },
      undefined,
    ]) {
      expect(isValidSettingValue(d, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('identity.dob_required accepts booleans only (no truthy coercion)', () => {
    const d = def('identity.dob_required');
    expect(isValidSettingValue(d, true)).toBe(true);
    expect(isValidSettingValue(d, false)).toBe(true);
    for (const bad of ['true', 'false', 1, 0, null, [], {}, undefined]) {
      expect(isValidSettingValue(d, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it.each([
    ['guardian.notification_policy', ['NEVER', 'MINORS_ONLY', 'ALWAYS_WHEN_ENABLED']],
    ['guardian.academic_visibility', ['MINORS_ONLY', 'ALWAYS_WHEN_LINKED', 'NEVER']],
  ])('%s accepts exactly its documented values, case-sensitively', (key, allowed) => {
    const d = def(key);
    for (const v of allowed) expect(isValidSettingValue(d, v), v).toBe(true);
    const all = new Set(['NEVER', 'MINORS_ONLY', 'ALWAYS_WHEN_ENABLED', 'ALWAYS_WHEN_LINKED']);
    for (const v of all) {
      expect(isValidSettingValue(d, v), `${key} ${v}`).toBe(allowed.includes(v));
    }
    for (const bad of [
      'never',
      'Never',
      'ALWAYS',
      '',
      ' NEVER',
      'NEVER ',
      1,
      true,
      null,
      ['NEVER'],
      {},
    ]) {
      expect(isValidSettingValue(d, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('never throws on hostile input shapes', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    for (const d of SETTING_DEFINITIONS) {
      for (const v of [Symbol('x'), 10n, () => 1, cyc, new Date(), /x/, NaN, Infinity]) {
        expect(() => isValidSettingValue(d, v)).not.toThrow();
        expect(isValidSettingValue(d, v)).toBe(false);
      }
    }
  });
});

describe('settings concurrency: parseIfMatch', () => {
  it('throws 428 PRECONDITION_REQUIRED when header is missing or empty', () => {
    for (const missing of [undefined, '', '   ']) {
      try {
        parseIfMatch(missing);
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(428);
        expect((err as AppError).code).toBe('PRECONDITION_REQUIRED');
      }
    }
  });

  it('parses wildcard * and "*" into { type: "exists" }', () => {
    expect(parseIfMatch('*')).toEqual({ type: 'exists' });
    expect(parseIfMatch('"*"')).toEqual({ type: 'exists' });
  });

  it('parses 0, "0", null, "null" into { type: "initial" }', () => {
    expect(parseIfMatch('0')).toEqual({ type: 'initial' });
    expect(parseIfMatch('"0"')).toEqual({ type: 'initial' });
    expect(parseIfMatch('null')).toEqual({ type: 'initial' });
    expect(parseIfMatch('"null"')).toEqual({ type: 'initial' });
  });

  it('parses valid positive versions (quoted, unquoted)', () => {
    expect(parseIfMatch('1')).toEqual({ type: 'version', version: 1 });
    expect(parseIfMatch('"1"')).toEqual({ type: 'version', version: 1 });
    expect(parseIfMatch('"42"')).toEqual({ type: 'version', version: 42 });
    expect(parseIfMatch('100')).toEqual({ type: 'version', version: 100 });
  });

  it('rejects weak entity tags with 400 BAD_REQUEST per RFC 9110 strong comparison', () => {
    for (const weak of ['W/"1"', 'W/"100"', 'W/"0"', 'W/*']) {
      try {
        parseIfMatch(weak);
        expect.unreachable(`should have thrown on: ${weak}`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).code).toBe('BAD_REQUEST');
      }
    }
  });

  it('throws 400 BAD_REQUEST on malformed headers', () => {
    for (const bad of ['abc', '"abc"', '-1', '"-1"', '1.5', '""', 'W/""', '01', '1, 2']) {
      try {
        parseIfMatch(bad);
        expect.unreachable(`should have thrown on: ${bad}`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).code).toBe('BAD_REQUEST');
      }
    }
  });
});

describe('settings concurrency: computeCollectionETag', () => {
  it('computes deterministic weak ETags matching by content', () => {
    const list1 = [
      { key: 'guardian.academic_visibility', version: null },
      { key: 'identity.age_of_majority', version: 1 },
    ];
    const list2 = [
      { key: 'guardian.academic_visibility', version: null },
      { key: 'identity.age_of_majority', version: 1 },
    ];
    const etag1 = computeCollectionETag(list1);
    const etag2 = computeCollectionETag(list2);
    expect(etag1.startsWith('W/"')).toBe(true);
    expect(etag1).toBe(etag2);

    const list3 = [
      { key: 'guardian.academic_visibility', version: null },
      { key: 'identity.age_of_majority', version: 2 },
    ];
    expect(computeCollectionETag(list3)).not.toBe(etag1);
  });
});
