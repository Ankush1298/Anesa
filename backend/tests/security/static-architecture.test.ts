import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const backend = resolve(import.meta.dirname, '../..');
const root = resolve(backend, '..');
const src = resolve(backend, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(backend, p);
const srcFiles = walk(src).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));

describe('runtime code can only reach PostgreSQL through the tenant-scoped abstraction (S-1, S-3)', () => {
  it("only src/shared/database/** imports the 'pg' driver", () => {
    const offenders = srcFiles.filter(
      (f) =>
        /from ['"]pg['"]|require\(['"]pg['"]\)/.test(f.text) &&
        !f.path.startsWith('src/shared/database/'),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('the transaction context is written in exactly one place, and only transaction-locally', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const users = srcFiles.filter((f) => /set_config\s*\(/.test(strip(f.text)));
    expect(users.map((f) => f.path)).toEqual(['src/shared/database/database.ts']);
    const text = readFileSync(resolve(backend, 'src/shared/database/database.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const calls = text.match(/set_config\([^)]*\)/g) ?? [];
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toMatch(/, true\)$/); // is_local = true
  });

  it('nothing in src builds SQL by string concatenation or interpolation', () => {
    const bad = srcFiles.filter(
      (f) => !f.path.startsWith('src/shared/database/') && /\.query\(\s*`[^`]*\$\{/.test(f.text),
    );
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  it('application code has no path to the migration role, the admin role, or the tooling', () => {
    const forbidden =
      /MIGRATION_DATABASE_URL|DATABASE_ADMIN_URL|\btools\/db\b|bootstrapDatabase|from ['"][^'"]*\/tools\//;
    expect(srcFiles.filter((f) => forbidden.test(f.text)).map((f) => f.path)).toEqual([]);
    // the only mention of the owner role is the startup check that REFUSES to run as it
    const mention = srcFiles.filter((f) =>
      /app_migrator/.test(f.text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    );
    expect(mention.map((f) => f.path)).toEqual(['src/shared/database/runtime-role.ts']);
  });

  it('the runtime configuration cannot even carry the migration/admin credentials', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://app_runtime:change_me_runtime@127.0.0.1:5432/db',
      MIGRATION_DATABASE_URL: 'postgresql://app_migrator:change_me_migrator@127.0.0.1:5432/db',
      DATABASE_ADMIN_URL: 'postgresql://root:change_me_admin@127.0.0.1:5432/db',
    });
    expect(JSON.stringify(cfg)).not.toMatch(/migrator|admin|MIGRATION/i);
    expect(Object.keys(cfg.database).sort()).toEqual(['poolMax', 'ssl', 'url']);
  });

  it('the server verifies the runtime role before it starts listening', () => {
    const server = readFileSync(resolve(src, 'server.ts'), 'utf8');
    expect(server.indexOf('verifyRuntimeRole()')).toBeGreaterThan(-1);
    expect(server.indexOf('verifyRuntimeRole()')).toBeLessThan(server.indexOf('.listen('));
  });

  it('the trusted-context issuer is imported by nothing in src except the tenancy layer itself', () => {
    const importers = srcFiles.filter(
      (f) =>
        /from ['"][^'"]*issue-trusted-context/.test(f.text) &&
        !f.path.includes('issue-trusted-context') &&
        !f.path.startsWith('src/modules/auth/'),
    );
    expect(importers.map((f) => f.path)).toEqual([]);
  });
});

describe('migrations are RLS-safe by construction (static pre-check of the SQL files)', () => {
  const dir = resolve(root, 'database/migrations');
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));
  const all = sql.map((s) => s.text).join('\n');

  it('every CREATE TABLE app.* is followed by ENABLE and FORCE ROW LEVEL SECURITY', () => {
    const tables = [...all.matchAll(/CREATE TABLE app\.([a-z_]+)/g)].map((m) => m[1] as string);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(all, `${t} ENABLE`).toMatch(
        new RegExp(`ALTER TABLE app\\.${t}\\s+ENABLE ROW LEVEL SECURITY`),
      );
      expect(all, `${t} FORCE`).toMatch(
        new RegExp(`ALTER TABLE app\\.${t}\\s+FORCE\\s+ROW LEVEL SECURITY`),
      );
    }
  });

  it('nothing is created in public, nothing is granted to PUBLIC, and no policy is USING (true)', () => {
    expect(all).not.toMatch(/CREATE (TABLE|FUNCTION|VIEW|SEQUENCE) public\./i);
    expect(all.replace(/--.*$/gm, '')).not.toMatch(/\bTO PUBLIC\b/i);
    expect(all.replace(/--.*$/gm, '')).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(all.replace(/--.*$/gm, '')).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
  });

  it('every SECURITY DEFINER function pins its search_path', () => {
    for (const { f, text } of sql) {
      for (const m of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\$\$[\s\S]*?\$\$/g)) {
        if (/SECURITY DEFINER/i.test(m[0])) expect(m[0], f).toMatch(/SET search_path\s*=/i);
      }
    }
  });

  it("migrations never create roles, extensions or alter role attributes (that is the superuser bootstrap's job)", () => {
    expect(all.replace(/--.*$/gm, '')).not.toMatch(
      /\b(CREATE|ALTER) ROLE\b|\bCREATE EXTENSION\b|\bBYPASSRLS\b|\bSUPERUSER\b/i,
    );
  });
});
