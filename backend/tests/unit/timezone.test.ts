import { describe, expect, it } from 'vitest';
import { hasAcceptableTimezoneShape } from '../../src/modules/organization/timezone.js';

// The shape filter is only the first half of the policy; membership in the server's tz database is checked in
// tests/integration/campus.test.ts against a real PostgreSQL.
describe('campus timezone shape filter', () => {
  it.each([
    'UTC',
    'Asia/Kolkata',
    'Europe/London',
    'America/Argentina/Buenos_Aires',
    'America/Port-au-Prince',
    'Africa/Abidjan',
    'Asia/Calcutta',
    'US/Pacific',
  ])('accepts %s', (tz) => expect(hasAcceptableTimezoneShape(tz)).toBe(true));

  it.each([
    ['abbreviation', 'IST'],
    ['abbreviation', 'PST'],
    ['abbreviation', 'EST'],
    ['legacy single token', 'EST5EDT'],
    ['legacy single token', 'CET'],
    ['legacy single token', 'GMT'],
    ['Factory', 'Factory'],
    ['POSIX offset', 'UTC+5'],
    ['POSIX offset', 'GMT+5:30'],
    ['POSIX offset', '<+0530>-5:30'],
    ['Etc family', 'Etc/GMT+5'],
    ['Etc family', 'Etc/UTC'],
    ['posix tree', 'posix/Asia/Kolkata'],
    ['right tree', 'right/UTC'],
    ['wrong case', 'asia/kolkata'],
    ['wrong case', 'utc'],
    ['empty', ''],
    ['whitespace', ' Asia/Kolkata'],
    ['trailing newline', 'Asia/Kolkata\n'],
    ['SQL-ish', "Asia/Kolkata'; DROP TABLE app.campuses;--"],
    ['path traversal', '../etc/passwd'],
    ['empty segment', 'Asia//Kolkata'],
    ['one char area', 'A/B'],
    ['over 64 chars', `Asia/${'A'.repeat(60)}`],
  ])('rejects %s: %j', (_why, tz) => expect(hasAcceptableTimezoneShape(tz)).toBe(false));

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 5, {}, ['UTC']])
      expect(hasAcceptableTimezoneShape(v)).toBe(false);
  });

  it('accepts a 64-character name and rejects 65 (the database CHECK bound)', () => {
    const at = (n: number): string => `Asia/${'A'.repeat(n - 5)}`;
    expect(hasAcceptableTimezoneShape(at(64))).toBe(true);
    expect(hasAcceptableTimezoneShape(at(65))).toBe(false);
  });
});
