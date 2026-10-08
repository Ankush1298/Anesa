import { defineConfig } from 'vitest/config';

// Three projects = three CI gates:
//   unit        fast, no database
//   integration real PostgreSQL (embedded locally, service container in CI)
//   security    merge-blocking static/hygiene gates, no database
//   security-db merge-blocking tenant/student isolation proofs; real PostgreSQL 16
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
        // static security gates: no database needed
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
        },
      },
      {
        // tenant / student isolation proofs against a REAL PostgreSQL server (16.x)
        test: {
          name: 'security-db',
          include: ['tests/security-db/**/*.test.ts'],
          globalSetup: ['tests/support/global-db.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
