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
    const tables = [...all.matchAll(/CREATE TABLE app\.([a-z0-9_]+)/g)].map((m) => m[1] as string);
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

// ---------------------------------------------------------------------------------------------
// Slice 3: authorization guardrails (06 §2, 10 §4). These are static; behaviour is proven elsewhere.
// ---------------------------------------------------------------------------------------------
describe('authorization architecture guardrails (Slice 3)', () => {
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const code = srcFiles.map((f) => ({ path: f.path, text: stripComments(f.text) }));
  const inAuthz = (p: string): boolean => p.startsWith('src/shared/authorization/');
  const modules = code.filter((f) => f.path.startsWith('src/modules/'));

  it('a TrustedContext is never forged: no casts to it, no registry access, issuer only used by the auth layer', () => {
    const forged = code.filter(
      (f) =>
        !f.path.startsWith('src/shared/tenancy/') &&
        /\bas\s+(?:unknown\s+as\s+)?TrustedContext\b|:\s*TrustedContext\s*=\s*\{|registerIssued/.test(
          f.text,
        ),
    );
    expect(forged.map((f) => f.path)).toEqual([]);
    const registry = code.filter(
      (f) => /context-registry/.test(f.text) && !f.path.startsWith('src/shared/tenancy/'),
    );
    expect(registry.map((f) => f.path)).toEqual([]);
  });

  it('only the authorization layer touches the authorization tables', () => {
    const offenders = code.filter(
      (f) =>
        !inAuthz(f.path) &&
        /\b(?:app\.)?(role_assignments|role_permissions)\b|\bapp\.roles\b|platform\.permissions/.test(
          f.text,
        ),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('routes and hooks contain no ad hoc role checks (no role names, no actorKind/role comparisons)', () => {
    const roleNames =
      /['"`](STUDENT|FACULTY|STAFF|HOD|DEPARTMENT_ADMIN|CAMPUS_ADMIN|COLLEGE_ADMIN|REGISTRAR|admin|ADMIN|superuser)['"`]/;
    const adhoc = /\.role\b|\.roles\b|\brole\s*(?:===|!==|==|!=)|actorKind\s*(?:===|!==|==|!=)/;
    const offenders = modules.filter(
      (f) => !f.path.endsWith('auth.service.ts') && (roleNames.test(f.text) || adhoc.test(f.text)),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
    // role names appear in code only in the role matrix and the DB-facing authorization layer
    const outside = code.filter(
      (f) =>
        !inAuthz(f.path) &&
        roleNames.test(f.text) &&
        !/\bSTUDENT\b|\bSTAFF\b/.test(f.text.replace(roleNames, '')),
    );
    expect(outside.map((f) => f.path)).toEqual([]);
  });

  it('request data (body/query/params/headers) never supplies tenant, identity, role, permission or scope', () => {
    const trusted =
      /\b(?:req|request)\.(?:body|query|params|headers)\b[^;]*?(?:tenant[_-]?id|user[_-]?id|student[_-]?id|organization[_-]?id|campus[_-]?id|department[_-]?id|\brole|\bpermission|\bscope|actor[_-]?kind)/i;
    expect(code.filter((f) => !inAuthz(f.path) && trusted.test(f.text)).map((f) => f.path)).toEqual(
      [],
    );
    // the trusted context is attached in exactly one place
    const writers = code.filter((f) => /\.tenantContext\s*=[^=]/.test(f.text));
    expect(writers.map((f) => f.path)).toEqual(['src/modules/auth/auth.hook.ts']);
    // login may read the tenant *slug* only, and it is checked against the identity's memberships
    const login = readFileSync(resolve(src, 'modules/auth/auth.service.ts'), 'utf8');
    expect(login).toMatch(/memberships\.find\(\(m\) => m\.org_slug === selectedTenantSlug\)/);
  });

  it('the tenant-less database door (withSystem) is used by the authentication layer only', () => {
    const users = code.filter(
      (f) => /\.withSystem\b/.test(f.text) && !f.path.startsWith('src/shared/database/'),
    );
    expect(users.map((f) => f.path).sort()).toEqual(['src/modules/auth/auth.service.ts']);
  });

  it('the session token is an opaque random value: no permissions, roles or scopes are put in it', () => {
    // (auth.hook.ts is the authorization wiring and legitimately names `config.permission`)
    const auth = code.filter(
      (f) => f.path.startsWith('src/modules/auth/') && !f.path.endsWith('auth.hook.ts'),
    );
    expect(
      auth
        .filter((f) =>
          /ROLE_MATRIX|role_permissions|PERMISSION_CATALOG|\.permissions?\b/.test(f.text),
        )
        .map((f) => f.path),
    ).toEqual([]);
    const repo = readFileSync(resolve(src, 'modules/auth/auth.repository.ts'), 'utf8');
    expect(repo).toMatch(/randomBytes\(32\)\.toString\('base64url'\)/);
    expect(repo).not.toMatch(/jwt|jsonwebtoken|sign\(/i);
    const routes = readFileSync(resolve(src, 'modules/auth/auth.routes.ts'), 'utf8');
    expect(routes.match(/reply\.cookie\(\s*SESSION_COOKIE,\s*result\.sessionToken,/g)?.length).toBe(
      1,
    );
  });

  it('every permission string used in src is drawn from the central catalog', async () => {
    const { PERMISSION_CODES } = await import('../../src/shared/authorization/catalog.js');
    const used: string[] = [];
    for (const f of code) {
      for (const m of f.text.matchAll(/permission:\s*'([^']+)'/g)) used.push(m[1]!);
      for (const m of f.text.matchAll(
        /\.(?:assert|hasPermission)\(\s*[^,()]+,\s*[^,()]+,\s*'([^']+)'/g,
      ))
        used.push(m[1]!);
    }
    expect(used.length).toBeGreaterThan(2);
    for (const p of used) expect(PERMISSION_CODES.has(p), p).toBe(true);
    // permission literals never appear outside the catalog/matrix/routes as free-floating strings
    const literal = /['"]((?:session|student|org|role)\.[a-z_]+(?:\.[a-z_]+)?)['"]/g;
    const stray = code.filter(
      (f) =>
        !inAuthz(f.path) &&
        ![...f.text.matchAll(literal)].every((m) => PERMISSION_CODES.has(m[1]!)),
    );
    expect(stray.map((f) => f.path)).toEqual([]);
  });

  it('the authorization is applied centrally: the hook calls the engine, and routes cannot opt out silently', () => {
    const hook = readFileSync(resolve(src, 'modules/auth/auth.hook.ts'), 'utf8');
    expect(hook).toMatch(/addHook\('preHandler'/);
    expect(hook).toMatch(/AuthorizationEngine\.(assert|hasPermission)\(/);
    const app = readFileSync(resolve(src, 'app.ts'), 'utf8');
    expect(app).toMatch(/addHook\('onRoute'/);
    // `public: true` is an explicit allowlist: only health and the login/logout endpoints
    const publicRoutes = code
      .filter((f) => /public:\s*true/.test(f.text) && !f.path.endsWith('app.ts'))
      .map((f) => f.path)
      .sort();
    expect(publicRoutes).toEqual([
      'src/modules/auth/auth.routes.ts',
      'src/modules/health/health.routes.ts',
    ]);
    expect([
      ...(code.find((f) => f.path.endsWith('auth.routes.ts'))?.text.matchAll(/public:\s*true/g) ??
        []),
    ]).toHaveLength(2);
    expect([
      ...(code.find((f) => f.path.endsWith('health.routes.ts'))?.text.matchAll(/public:\s*true/g) ??
        []),
    ]).toHaveLength(2);
  });

  it('the assigned-resolver registry is written only from modules (never from request paths) and tests', () => {
    const writers = code.filter(
      (f) => /registerAssignedResolver\(/.test(f.text) && !inAuthz(f.path),
    );
    expect(writers.every((f) => f.path.startsWith('src/modules/'))).toBe(true);
  });

  it('CSRF and cookie hygiene: no placeholder secret, hook wired, constant-time compare, one cookie definition', () => {
    const app = readFileSync(resolve(src, 'app.ts'), 'utf8');
    expect(stripComments(app)).not.toMatch(/fastifyCookie[^)]*secret|change_me/i);
    expect(
      code.filter((f) => /change_me|placeholder_secret/i.test(f.text)).map((f) => f.path),
    ).toEqual([]);
    const hook = stripComments(readFileSync(resolve(src, 'modules/auth/auth.hook.ts'), 'utf8'));
    expect(hook).toMatch(/assertOrigin\(request, opts\.allowedOrigins\)/);
    expect(hook).toMatch(/assertCsrfToken\(request, token\)/);
    expect(hook.indexOf('assertOrigin')).toBeLessThan(hook.indexOf('validateSession')); // origin first
    expect(readFileSync(resolve(src, 'modules/auth/csrf.ts'), 'utf8')).toMatch(/timingSafeEqual/);
    // the session cookie's attributes are defined once and reused by set and clear
    const routes = stripComments(readFileSync(resolve(src, 'modules/auth/auth.routes.ts'), 'utf8'));
    expect(routes).toMatch(/clearCookie\(SESSION_COOKIE, SESSION_COOKIE_ATTRS\)/);
    expect(routes).toMatch(/\.\.\.SESSION_COOKIE_ATTRS/);
    expect(routes).not.toMatch(/httpOnly|sameSite|secure:/);
    const attrs = readFileSync(resolve(src, 'modules/auth/session-cookie.ts'), 'utf8');
    expect(attrs).toMatch(/httpOnly: true/);
    expect(attrs).toMatch(/secure: true/);
    expect(attrs).toMatch(/sameSite: 'lax'/);
  });

  it('state-changing routes: only login and logout are public; health exposes GET only', () => {
    const health = readFileSync(resolve(src, 'modules/health/health.routes.ts'), 'utf8');
    expect(health).not.toMatch(/app\.(post|put|patch|delete)\(/);
    const auth = stripComments(readFileSync(resolve(src, 'modules/auth/auth.routes.ts'), 'utf8'));
    const unsafePublic = [
      ...auth.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'[\s\S]*?public: true/g),
    ].map((m) => m[2]);
    expect(unsafePublic.sort()).toEqual(['/auth/login', '/auth/logout']);
  });
});

// ---------------------------------------------------------------------------------------------
// F1: audit foundation (ADR-008). Behaviour is proven in security-db/audit-events.test.ts and
// integration/role-audit.test.ts; these are the static guardrails.
// ---------------------------------------------------------------------------------------------
describe('audit guardrails (F1)', () => {
  const strip = (x: string): string => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('only src/shared/audit touches the audit table (single writer)', () => {
    const offenders = srcFiles.filter(
      (f) => !f.path.startsWith('src/shared/audit/') && /audit_events/.test(strip(f.text)),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('role grant and revoke record an audit event through the helper, inside the same tx they were given', () => {
    const text = strip(readFileSync(resolve(src, 'shared/authorization/assignments.ts'), 'utf8'));
    expect(text).toMatch(/import \{[^}]*recordAudit[^}]*\} from '\.\.\/audit\/index\.js'/);
    expect(text).toMatch(/recordAudit\(\s*tx,\s*ctx,\s*\{\s*action: 'role\.assignment\.grant'/);
    expect(text).toMatch(/recordAudit\(\s*tx,\s*ctx,\s*\{\s*action: 'role\.assignment\.revoke'/);
    expect(text).not.toMatch(/withTenant|withSystem/); // never opens its own transaction
    expect(text).toMatch(/normaliseReason\(/);
  });

  it('the helper never writes occurred_at, never accepts a request body, and has no read path', () => {
    const text = strip(readFileSync(resolve(src, 'shared/audit/record.ts'), 'utf8'));
    expect(text).not.toMatch(/occurred_at/);
    expect(text).not.toMatch(/\bSELECT\b|\bUPDATE\b|\bDELETE\b/);
    expect(text).not.toMatch(/\bbody\b/);
  });

  it('migration 0007: no extension, no DEFAULT partition, no read/modify/truncate grant on audit rows', () => {
    const sql = strip(
      readFileSync(resolve(root, 'database/migrations/0007_audit_events.sql'), 'utf8').replace(
        /--.*$/gm,
        '',
      ),
    );
    expect(sql).not.toMatch(/CREATE EXTENSION/i);
    expect(sql).not.toMatch(/PARTITION OF[^;]*\bDEFAULT\b/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(SELECT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*audit_events/i);
    expect(sql).toMatch(/PARTITION BY RANGE \(occurred_at\)/);
    expect(sql).toMatch(/PRIMARY KEY \(id, occurred_at\)/);
  });
});
