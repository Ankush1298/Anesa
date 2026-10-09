import { describe, expect, it, vi } from 'vitest';

// Regression: with TEST_DATABASE_URL several vitest projects share one server and each project's globalSetup lives in
// its OWN module graph. The role passwords must therefore be shared through something other than module state.
describe('rolePasswords', () => {
  it('returns the same passwords to independent copies of the module (as separate projects get)', async () => {
    vi.resetModules();
    const first = (await import('../support/role-passwords.js')).rolePasswords();
    vi.resetModules();
    const second = (await import('../support/role-passwords.js')).rolePasswords();
    expect(second).toEqual(first);
    expect(first.runtime).not.toBe(first.migrator);
    expect(first.runtime).toMatch(/^[0-9a-f]{36}$/);
  });
});
