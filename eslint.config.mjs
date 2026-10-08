// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'Raw DB access is restricted to src/shared/database (tenant-scoped access only). See ADR-019.',
            },
          ],
          patterns: [
            {
              group: ['pg/*', 'postgres', 'postgres/*'],
              message: 'Raw DB access is restricted to src/shared/database.',
            },
          ],
        },
      ],
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
  // shared/database is the only place allowed to import the driver.
  {
    files: [
      'backend/src/shared/database/**/*.ts',
      'backend/tests/support/**/*.ts',
      'backend/scripts/**/*.ts', // dev/CI harnesses, never imported by application code
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
      'backend/vitest.config.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Scripts and CLIs may print.
  {
    files: ['backend/scripts/**/*.ts', 'backend/tests/support/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
