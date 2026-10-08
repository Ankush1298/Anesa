/**
 * Lightweight repository secret scan (merge gate). It complements, not replaces, GitHub secret
 * scanning / push protection. Scans every non-ignored file (tracked or not) so a secret is caught
 * before the first commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

const RULES: { name: string; re: RegExp }[] = [
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // scheme://user:password@host with a real-looking password
  { name: 'url-embedded-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/i },
  {
    name: 'assigned-secret',
    re: /\b(?:password|passwd|secret|api[_-]?key|token|private[_-]?key)\b\s*[:=]\s*['"]?([^\s'"#]{8,})/i,
  },
];

const PLACEHOLDER =
  /^(?:pass(?:word)?|secret|token|xxx+|\$\(.*|change[_-]?me[\w-]*|replace[_-]?me|your[_-].*|example.*|placeholder.*|<.*>|\$\{.*\}|\$[A-Z_]+|x{3,}|\*{3,}|\.{3}|\[redacted\])$/i;

const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|pdf|woff2?|zip|gz|lock|tsbuildinfo)$/i;
const SKIP_PATH = /^(?:pnpm-lock\.yaml|docs\/archive\/)/;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // Explicit, reviewable opt-out for deliberate fake values in tests (never use in application code).
    if (line.includes('secret-scan:allow')) return;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const captured = m[1];
      if (captured !== undefined && isPlaceholder(captured)) continue;
      // Values read from env/config at runtime or typed as identifiers are not literals.
      if (
        rule.name === 'assigned-secret' &&
        captured !== undefined &&
        /^[A-Za-z_$][\w$]*(?:[.(]|[;,)]*$)/.test(captured) &&
        !/\d{3,}/.test(captured)
      )
        continue;
      findings.push({ file, line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

export function listCandidateFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.length > 0 && !BINARY_EXT.test(f) && !SKIP_PATH.test(f));
}

/** Files that must never exist in the repo (outside .gitignore): real env files and key material. */
export function forbiddenFiles(files: string[]): string[] {
  return files.filter((f) =>
    /(^|\/)\.env(\..+)?$/.test(f) && !/(^|\/)\.env\.example$/.test(f)
      ? true
      : /\.(?:pem|key|p12|pfx)$/.test(f),
  );
}

export function scanRepo(root: string): { findings: Finding[]; forbidden: string[] } {
  const files = listCandidateFiles(root);
  const findings: Finding[] = [];
  for (const f of files) {
    const abs = resolve(root, f);
    if (statSync(abs).size > 1_000_000) continue;
    findings.push(...scanText(f, readFileSync(abs, 'utf8')));
  }
  return { findings, forbidden: forbiddenFiles(files) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, '../..');
  const { findings, forbidden } = scanRepo(root);
  // Output never includes matched text — only location and rule.
  for (const f of findings) console.error(`secret-scan: ${f.file}:${f.line} [${f.rule}]`);
  for (const f of forbidden) console.error(`secret-scan: forbidden file present: ${f}`);
  if (findings.length > 0 || forbidden.length > 0) process.exit(1);
  console.log('secret-scan: no findings');
}
