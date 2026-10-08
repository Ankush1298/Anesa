import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

// ADR-016 / ADR-022: face & biometric attendance is a deferred, isolated optional module.
// Nothing about it may be wired into the build, compose or CI.
const FACE = /face[-_ ]?(service|attendance|recognition)|insightface|rekognition/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.data'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('deferred modules are excluded from build, compose and CI (ADR-016)', () => {
  it('workspace config does not include the face service', () => {
    expect(read('pnpm-workspace.yaml').replace(/^\s*#.*$/gm, '')).not.toMatch(FACE);
  });

  it('docker compose does not run a face service', () => {
    const compose = read('infrastructure/docker/docker-compose.yml').replace(/^\s*#.*$/gm, '');
    expect(compose).not.toMatch(FACE);
  });

  it('CI workflows do not build or test a face service', () => {
    const dir = resolve(root, '.github/workflows');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), 'utf8').replace(/^\s*#.*$/gm, ''), f).not.toMatch(FACE);
    }
  });

  it('backend source and dependencies contain no face/biometric code', () => {
    const pkg = read('backend/package.json');
    expect(pkg).not.toMatch(FACE);
    for (const f of walk(resolve(root, 'backend/src'))) {
      expect(f).not.toMatch(/face|biometric/i);
    }
  });

  it('the deferred service directory is clearly marked', () => {
    expect(existsSync(resolve(root, 'services/face-service/DEFERRED.md'))).toBe(true);
  });
});
