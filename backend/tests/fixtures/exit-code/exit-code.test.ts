import { expect, it } from 'vitest';

// PASS mode proves the harness can succeed; the default mode fails on purpose.
it('fixture test (fails unless EXIT_CODE_FIXTURE=pass)', () => {
  expect(process.env['EXIT_CODE_FIXTURE'] === 'pass' ? 1 : 2).toBe(1);
});
