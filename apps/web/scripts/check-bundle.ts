/**
 * Scans the production build (apps/web/dist) for anything that must never reach a browser:
 * secrets, server-only configuration, source maps, absolute backend URLs, trackers.
 * Exit 1 on any finding. Output names the file and rule only, never the matched text.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');

// backend-origin: any 127.0.0.1, or localhost WITH a port (a dev API address). A bare http://localhost is
// react-router's internal URL-parsing placeholder and is not an address of ours.
const RULES: { name: string; re: RegExp }[] = [
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'url-embedded-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i },
  { name: 'database-url', re: /postgres(?:ql)?:\/\//i },
  {
    name: 'server-env-name',
    re: /DATABASE_(?:ADMIN_)?URL|MIGRATION_DATABASE_URL|POSTGRES_PASSWORD|DEV_API_ORIGIN/,
  },
  { name: 'session-cookie-name', re: /session_token/ },
  { name: 'backend-origin', re: /127\.0\.0\.1|https?:\/\/localhost:\d+/ },
  { name: 'source-map-reference', re: /sourceMappingURL=/ },
  {
    name: 'tracker',
    re: /google-analytics|googletagmanager|gtag\(|mixpanel|hotjar|segment\.com|sentry\.io/i,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(dist)) {
  console.error('check-bundle: apps/web/dist not found; run the web build first');
  process.exit(1);
}

const files = walk(dist);
const problems: string[] = [];
for (const file of files) {
  const rel = relative(dist, file);
  if (/\.map$/.test(file)) problems.push(`${rel} [source-map-file]`);
  if (/\.(?:png|jpe?g|gif|ico|webp|woff2?)$/i.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const rule of RULES) if (rule.re.test(text)) problems.push(`${rel} [${rule.name}]`);
}
for (const p of problems) console.error(`check-bundle: ${p}`);
if (problems.length > 0) process.exit(1);
console.log(`check-bundle: ${files.length} files scanned, no findings`);
