import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  forbiddenFiles,
  listCandidateFiles,
  scanRepo,
  scanText,
} from '../../scripts/check-secrets.js';

const root = resolve(import.meta.dirname, '../../..');

describe('secrets hygiene (S-14)', () => {
  it('the repository contains no secret-looking literals', () => {
    const { findings } = scanRepo(root);
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}`)).toEqual([]);
  });

  it('no real env files or key material are present outside .gitignore', () => {
    expect(forbiddenFiles(listCandidateFiles(root))).toEqual([]);
  });

  it('.gitignore excludes .env files but keeps .env.example', () => {
    const gi = readFileSync(resolve(root, '.gitignore'), 'utf8').split('\n');
    expect(gi).toContain('.env');
    expect(gi).toContain('.env.*');
    expect(gi).toContain('!.env.example');
    expect(gi).toContain('.data/');
  });

  it('.env.example holds placeholders only', () => {
    const text = readFileSync(resolve(root, '.env.example'), 'utf8');
    expect(scanText('.env.example', text)).toEqual([]);
    expect(text).toContain('change_me');
  });

  describe('scanner self-test (it must actually detect things)', () => {
    const fakeAws = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const fakeKeyHeader = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    const cases: [string, string][] = [
      ['aws key', `key = "${fakeAws}"`],
      ['private key', fakeKeyHeader],
      ['url password', 'postgres://admin:Tr0ub4dor9xyz@db.example.com/app'], // secret-scan:allow (deliberate test fixture)
      ['assigned secret', 'API_KEY = "a8f5f167f44f4964e6c998dee827110c"'], // secret-scan:allow (deliberate test fixture)
    ];
    it.each(cases)('flags %s', (_name, text) => {
      expect(scanText('x.ts', text).length).toBeGreaterThan(0);
    });
    it('ignores placeholders', () => {
      expect(scanText('x.env', 'DATABASE_URL=postgresql://u:change_me@h/db')).toEqual([]);
    });
  });
});
