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
});
