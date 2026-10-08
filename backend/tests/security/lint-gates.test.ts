import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// S-1: architecture rules are enforced by the linter, so a violation cannot merge.
const root = resolve(import.meta.dirname, '../../..');
// Probe files are virtual (not in tsconfig), so type-aware rules are switched off; the architecture
// rules under test are plain ESLint rules and stay active.
const eslint = new ESLint({ cwd: root, overrideConfig: [tseslint.configs.disableTypeChecked] });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('architecture lint gates (S-1)', () => {
  it('forbids importing the raw database driver outside shared/database', async () => {
    const ids = await ruleIds(
      "import pg from 'pg';\nexport const x = pg;\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(ids).toContain('no-restricted-imports');
  });

  it('allows the driver inside shared/database', async () => {
    const ids = await ruleIds(
      "import pg from 'pg';\nexport const x = pg;\n",
      'backend/src/shared/database/probe.ts',
    );
    expect(ids).not.toContain('no-restricted-imports');
  });

  it('forbids reading process.env outside the config loader', async () => {
    const ids = await ruleIds(
      "export const x = process.env['A'];\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(ids).toContain('no-restricted-syntax');
  });

  it('forbids console logging in application code', async () => {
    const ids = await ruleIds("console.log('x');\n", 'backend/src/modules/health/probe.ts');
    expect(ids).toContain('no-console');
  });

  it('forbids application modules from reaching the pool or tx internals directly', async () => {
    const pool = await ruleIds(
      "import { createPool } from '../../shared/database/pool.js';\nexport const x = createPool;\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(pool).toContain('no-restricted-imports');
    const tx = await ruleIds(
      "import { openTenantTx } from '../../shared/database/tenant-tx.js';\nexport const x = openTenantTx;\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(tx).toContain('no-restricted-imports');
  });

  it('allows application modules to use the public database facade', async () => {
    const ids = await ruleIds(
      "import { Database } from '../../shared/database/index.js';\nexport const x = Database;\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(ids).not.toContain('no-restricted-imports');
  });

  it('forbids business modules from issuing a TrustedContext (only src/modules/auth may)', async () => {
    const code =
      "import { issueTrustedContext } from '../../shared/tenancy/issue-trusted-context.js';\nexport const x = issueTrustedContext;\n";
    expect(await ruleIds(code, 'backend/src/modules/health/probe.ts')).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds(code, 'backend/src/modules/auth/probe.ts')).not.toContain(
      'no-restricted-imports',
    );
  });

  it('forbids application code from importing migration / bootstrap tooling', async () => {
    const ids = await ruleIds(
      "import { migrate } from '../../../tools/db/migrate.js';\nexport const x = migrate;\n",
      'backend/src/modules/health/probe.ts',
    );
    expect(ids).toContain('no-restricted-imports');
  });
});
