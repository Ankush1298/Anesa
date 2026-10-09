// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';

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
    files: ['**/*.ts', '**/*.tsx'],
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
  // Browser app: accessibility + hooks rules, and hard bans on anything that could expose or persist
  // the session or secrets (the matching static tests live in apps/web/tests/security-static.test.ts).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/set-state-in-effect': 'off', // session restore legitimately sets state from an effect
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'No client-side persistence of identity or tokens.' },
        { name: 'sessionStorage', message: 'No client-side persistence of identity or tokens.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'document',
          property: 'cookie',
          message: 'The session cookie is HttpOnly; never touch cookies.',
        },
      ],
      'react/no-danger': 'off',
    },
  },
  {
    files: ['apps/web/tests/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': 'off' }, // tests prove nothing reads storage by writing to it
  },
  {
    files: ['apps/web/vite.config.ts', 'apps/web/scripts/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
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
