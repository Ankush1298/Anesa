import { defineConfig } from 'vitest/config';

// Standalone config used ONLY by tests/security/test-runner-exit-code.test.ts (never part of a normal run:
// the backend projects only include tests/unit|integration|security|security-db).
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['*.test.ts'],
    globalSetup: ['./global-setup.ts'],
  },
});
