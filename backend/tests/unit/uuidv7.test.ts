import { describe, expect, it } from 'vitest';
import { isUuidV7, uuidv7 } from '../../src/shared/ids/uuidv7.js';

describe('uuidv7', () => {
  it('has version 7 and RFC variant bits', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7();
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect('89ab').toContain(id[19]);
    }
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    // a far-future instant, so the generator's monotonic clamp (never go backwards) cannot interfere
    const ms = 4_000_000_000_123;
    const id = uuidv7(ms);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms);
  });

  it('is strictly increasing (sortable) even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_000_000_000_000));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never moves backwards when the clock does', () => {
    const a = uuidv7(5_000_000_000_000);
    const b = uuidv7(1_000_000_000_000);
    expect(b > a).toBe(true);
  });

  it('rejects non-v7 and non-string values', () => {
    expect(isUuidV7('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
    expect(isUuidV7(undefined)).toBe(false);
    expect(isUuidV7(' 01939a00-0000-7000-8000-000000000a01')).toBe(false);
  });
});
