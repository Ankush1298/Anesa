import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A failing test must ALWAYS produce a non-zero exit code, including when the backend's embedded-PostgreSQL
// support module is loaded. Regression for: `embedded-postgres` -> `async-exit-hook` registers a
// `beforeExit` handler that calls process.exit(0), which overrode Vitest's process.exitCode = 1, so
// `pnpm test` / `pnpm run verify` could report success while tests had failed.
const backend = resolve(import.meta.dirname, '../..');
const config = join(backend, 'tests/fixtures/exit-code/vitest.config.ts');
const vitestMjs = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

function run(command: string, args: string[], fixture: 'fail' | 'pass') {
  const env: NodeJS.ProcessEnv = { ...process.env, EXIT_CODE_FIXTURE: fixture, CI: '1' };
  delete env['TEST_DATABASE_URL'];
  const r = spawnSync(command, args, { cwd: backend, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, error: r.error };
}

describe('the test runner reports failure with a non-zero exit code', () => {
  it('the vitest entry point and fixture exist', () => {
    expect(existsSync(vitestMjs)).toBe(true);
    expect(existsSync(config)).toBe(true);
  });

  it('direct vitest: a failing test exits non-zero even though the embedded-postgres module is loaded', () => {
    const r = run(process.execPath, [vitestMjs, 'run', '--config', config], 'fail');
    expect(r.error).toBeUndefined();
    expect(r.out).toMatch(/1 failed/); // it really failed...
    expect(r.status, r.out.slice(-600)).not.toBe(0); // ...and the process says so
  });

  it('through pnpm: the failure survives the package-manager layer used by `pnpm test` / `pnpm run verify`', () => {
    // npm_execpath is a JS file for npm-style installs but a native executable for the standalone pnpm.
    const exec = process.env['npm_execpath'];
    const args = ['exec', 'vitest', 'run', '--config', config];
    const r =
      exec && /pnpm/.test(exec)
        ? /\.[cm]?js$/.test(exec)
          ? run(process.execPath, [exec, ...args], 'fail')
          : run(exec, args, 'fail')
        : run('pnpm', args, 'fail');
    expect(r.error, 'pnpm must be available to run this gate').toBeUndefined();
    expect(r.out).toMatch(/1 failed/);
    expect(r.status, r.out.slice(-600)).not.toBe(0);
  });

  it('control: the same fixture passes (exit 0) when its assertion holds, so the harness can succeed', () => {
    const r = run(process.execPath, [vitestMjs, 'run', '--config', config], 'pass');
    expect(r.out).toMatch(/1 passed/);
    expect(r.out).not.toMatch(/TypeError|done is not a function/); // no exit-hook crash after the run
    expect(r.status, r.out.slice(-600)).toBe(0);
  });
});
