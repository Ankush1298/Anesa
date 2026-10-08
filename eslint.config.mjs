// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PG_PATH = {
  name: 'pg',
  message:
    'Raw DB access is restricted to src/shared/database (tenant-scoped access only). See ADR-019.',
};
const PG_PATTERN = {
  group: ['pg/*', 'postgres', 'postgres/*'],
  message: 'Raw DB access is restricted to src/shared/database.',
};
const BASE_IMPORT_RULES = { paths: [PG_PATH], patterns: [PG_PATTERN] };

// Application modules may use the database ONLY through shared/database/index.js, and may never
// import the trusted-context issuer (only the authentication layer, src/modules/iam, may).
const MODULE_IMPORT_RULES = {
  paths: [PG_PATH],
  patterns: [
    PG_PATTERN,
    {
      group: ['**/shared/database/*', '!**/shared/database/index.js'],
      message:
        'Import the database layer via shared/database/index.js only (no pool, no tx internals).',
    },
    {
      group: ['**/issue-trusted-context*', '**/context-registry*'],
      message:
        'Only the authentication layer (src/modules/auth) may issue a TrustedContext. Never build one from request data.',
    },
    {
      group: ['**/tools/**', '**/database/migrations/**'],
      message: 'Migration/bootstrap tooling must never be imported by application code.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.data/**',
      'docs/**',
      'services/**',
      'deferred/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // --- Architecture gates (security architecture S-1) ---------------------------------
      // Raw database drivers are importable only inside shared/database (see override below).
      'no-restricted-imports': ['error', BASE_IMPORT_RULES],
      // Configuration is read once, validated, in config/env.ts. Nothing else touches process.env.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read configuration via the validated config object, not process.env.',
        },
      ],
    },
  },
  // Application modules: stricter import rules (S-1)
  {
    files: ['backend/src/modules/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', MODULE_IMPORT_RULES] },
  },
  // The authentication layer is the one place allowed to issue a TrustedContext (still no driver).
  {
    files: ['backend/src/modules/auth/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...MODULE_IMPORT_RULES,
          patterns: MODULE_IMPORT_RULES.patterns.filter(
            (p) => !p.group.includes('**/issue-trusted-context*'),
          ),
        },
      ],
    },
  },
  // shared/database is the only place allowed to import the driver.
  {
    files: [
      'backend/src/shared/database/**/*.ts',
      'backend/tests/support/**/*.ts',
      'backend/tests/security-db/**/*.ts', // raw runtime-role connections are the point of these tests
      'backend/tests/integration/**/*.ts',
      'backend/scripts/**/*.ts', // dev/CI harnesses, never imported by application code
      'backend/tools/**/*.ts', // superuser bootstrap + migration runner, never imported by src/
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  // The config loader and test/CLI harnesses legitimately read process.env.
  {
    files: [
      'backend/src/config/env.ts',
      'backend/src/server.ts',
      'backend/tests/**/*.ts',
      'backend/scripts/**/*.ts',
      'backend/tools/**/*.ts',
      'backend/vitest.config.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Scripts and CLIs may print.
  {
    files: ['backend/scripts/**/*.ts', 'backend/tools/**/*.ts', 'backend/tests/support/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
