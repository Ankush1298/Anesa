import { defineConfig } from 'vitest/config';

// Three projects = three CI gates:
//   unit        fast, no database
//   integration real PostgreSQL (embedded locally, service container in CI)
//   security    merge-blocking isolation / hygiene tests (S-gates); real PostgreSQL
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/global-db.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          globalSetup: ['tests/support/global-db.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
