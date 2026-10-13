import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { invalid, parseDate, parseReason } from '../../src/modules/people/validation.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? `${e.statusCode}:${e.code}` : 'other';
  }
  return undefined;
}

// These are the helpers the employee service always had, moved so the students service shares them. The cases pin the
// behaviour the employee routes depend on.
describe('shared people validation (extracted from the employee service)', () => {
  it('invalid() is a 400 VALIDATION_ERROR', () => {
    const e = invalid('nope');
    expect([e.statusCode, e.code, e.message]).toEqual([400, 'VALIDATION_ERROR', 'nope']);
  });

  it('parseDate accepts real calendar dates from 1900 to 2200 and returns them unchanged', () => {
    for (const d of ['2024-02-29', '1900-01-01', '2200-12-31', '2024-07-01']) {
      expect(parseDate(d, 'f')).toBe(d);
    }
  });

  it.each([
    '2023-02-29',
    '2024-13-01',
    '2024-00-10',
    '2024-04-31',
    '1899-12-31',
    '2201-01-01',
    '2024-7-1',
    '2024-07-01T00:00:00Z',
    ' 2024-07-01',
    '',
  ])('parseDate rejects %j', (value) => {
    expect(code(() => parseDate(value, 'joiningDate'))).toBe('400:VALIDATION_ERROR');
  });

  it('parseDate rejects non-strings and names the field', () => {
    expect(code(() => parseDate(20240701, 'x'))).toBe('400:VALIDATION_ERROR');
    expect(code(() => parseDate(null, 'x'))).toBe('400:VALIDATION_ERROR');
    expect(() => parseDate('bad', 'leavingDate')).toThrow(/leavingDate/);
  });

  it('parseReason trims and enforces 5..500 characters', () => {
    expect(parseReason('  Initial onboarding  ')).toBe('Initial onboarding');
    expect(parseReason('x'.repeat(500))).toHaveLength(500);
    for (const bad of ['abcd', '    abcd   ', 'x'.repeat(501), '', undefined, null, 12345]) {
      expect(
        code(() => parseReason(bad)),
        String(bad),
      ).toBe('400:VALIDATION_ERROR');
    }
  });

  // Regression pins for the Employee API: these exact messages are what the employee service produced when the helpers
  // were inline (compared against the pre-extraction source over 56 inputs, no differences).
  it('keeps the exact messages the employee API has always returned', () => {
    const msg = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(msg(() => parseDate('2024-02-30', 'joiningDate'))).toBe(
      'joiningDate must be a real calendar date (YYYY-MM-DD) between 1900 and 2200.',
    );
    expect(msg(() => parseDate('', 'leavingDate'))).toBe(
      'leavingDate must be a real calendar date (YYYY-MM-DD) between 1900 and 2200.',
    );
    expect(msg(() => parseReason('     '))).toBe('Reason must be 5 to 500 characters.');
    expect(msg(() => parseReason(undefined))).toBe('Reason must be 5 to 500 characters.');
  });
});
