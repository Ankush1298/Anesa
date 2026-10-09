import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPublicConfig, PublicConfigError } from '../src/config/env';

const root = resolve(import.meta.dirname, '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const src = walk(resolve(root, 'src')).map((p) => ({
  path: relative(root, p),
  text: readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''),
}));

describe('the browser code can never touch the session credential or persist secrets', () => {
  it.each([
    ['document.cookie', /document\s*\.\s*cookie/],
    ['localStorage', /\blocalStorage\b/],
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['cookie store', /\bcookieStore\b/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML assignment', /\.innerHTML\s*=/],
    ['eval / Function constructor', /\beval\s*\(|new\s+Function\s*\(/],
    ['console output', /\bconsole\s*\./],
    ['the session cookie name', /session_token/],
    ['credentials: include', /credentials\s*:\s*['"]include['"]/],
    ['absolute backend URLs', /https?:\/\/(?:127\.0\.0\.1|localhost)/],
    [
      'third-party trackers',
      /google-analytics|gtag\(|googletagmanager|segment\.com|hotjar|mixpanel|sentry|plausible/i,
    ],
  ])('src contains no %s', (_name, re) => {
    expect(src.filter((f) => re.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('only the API client reads Set-Cookie/Cookie semantics: nothing sets a Cookie or Authorization header by hand', () => {
    expect(
      src.filter((f) => /['"]cookie['"]|['"]authorization['"]/i.test(f.text)).map((f) => f.path),
    ).toEqual([]);
  });

  it('the CSRF token is held in one place (the client closure) and never stored or put in the DOM/URL', () => {
    const users = src
      .filter((f) => /csrfToken|csrf_token/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      'src/lib/api/auth-api.ts',
      'src/lib/api/client.ts',
      'src/lib/api/schemas.ts',
    ]);
  });

  it('index.html is private: noindex, no third-party scripts/fonts; robots.txt disallows all', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow/);
    expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
    expect([...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)]).toEqual([]);
    expect(readFileSync(resolve(root, 'public/robots.txt'), 'utf8')).toMatch(
      /User-agent: \*\s+Disallow: \/\s*$/m,
    );
  });

  it('there is exactly one favicon and it is local', () => {
    expect(readFileSync(resolve(root, 'public/favicon.svg'), 'utf8')).toMatch(/<svg/);
  });
});

describe('public configuration', () => {
  it('defaults to the same-origin /api prefix', () => {
    expect(loadPublicConfig({})).toEqual({ apiBasePath: '/api' });
    expect(loadPublicConfig({ VITE_API_BASE_PATH: '' })).toEqual({ apiBasePath: '/api' });
    expect(loadPublicConfig({ VITE_API_BASE_PATH: '/' })).toEqual({ apiBasePath: '' });
    expect(loadPublicConfig({ VITE_API_BASE_PATH: '/campus/api' })).toEqual({
      apiBasePath: '/campus/api',
    });
  });

  it.each([
    'https://evil.test/api',
    '//evil.test',
    'api',
    '/api/',
    '/a b',
    '/../x',
    'javascript:alert(1)',
    '/api?x=1',
  ])('rejects %s (only a same-origin path is allowed) without echoing it', (bad) => {
    const run = () => loadPublicConfig({ VITE_API_BASE_PATH: bad });
    expect(run).toThrow(PublicConfigError);
    try {
      run();
    } catch (e) {
      expect((e as Error).message).not.toContain('evil.test');
    }
  });
});
