import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gate: the production `pnpm seed:dev` entry point must never pass the test-only safety bypasses
// (allowTestDb / allowContainerTestDb / disposableMarker) into the verification or probe functions.
// Those options relax the loopback / campusos_dev / port guards and are for the disposable test harness only.
// No database needed.
const source = readFileSync(resolve(import.meta.dirname, '../../scripts/seed-dev.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('production dev-seed CLI entry point does not opt into test-only bypasses', () => {
  it('never references allowTestDb, allowContainerTestDb, or disposableMarker', () => {
    for (const key of ['allowTestDb', 'allowContainerTestDb', 'disposableMarker']) {
      expect(source, `seed-dev.ts must not reference ${key}`).not.toContain(key);
    }
  });

  it('calls verifyLocalDevDatabaseUrl and probeLocalDevDatabase with no options argument', () => {
    // Single identifier argument, no comma => no options object can carry a bypass flag.
    expect(source).toMatch(/\bverifyLocalDevDatabaseUrl\(\s*[A-Za-z0-9_.]+\s*\)/);
    expect(source).toMatch(/\bprobeLocalDevDatabase\(\s*[A-Za-z0-9_.]+\s*\)/);
    // And neither call site is given a second argument.
    expect(source).not.toMatch(/\bverifyLocalDevDatabaseUrl\([^)]*,/);
    expect(source).not.toMatch(/\bprobeLocalDevDatabase\([^)]*,/);
  });
});
