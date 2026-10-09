/**
 * Keys that must never be persisted in audit `changes` / `metadata`. Matching is on the normalised key
 * (lower-case, letters and digits only), as a substring, so `new_password`, `passwordHash`, `X-Auth-Token`,
 * `clientSecret`, `db_credentials` and `Authorization` are all caught.
 */
const FORBIDDEN_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'csrf',
  'totp',
  'recoverycode',
  'sessionid', // a session id is carried in its own column, never inside free-form JSON
] as const;

const MAX_DEPTH = 6;
const MAX_NODES = 500;

export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return FORBIDDEN_FRAGMENTS.some((f) => k.includes(f));
}

/** Returns the first offending key path, or a structural problem, or null when the value is acceptable. */
export function findAuditMetadataProblem(value: unknown): string | null {
  let nodes = 0;
  const walk = (v: unknown, path: string, depth: number): string | null => {
    if (++nodes > MAX_NODES) return `${path || '(root)'}: too many nodes`;
    if (depth > MAX_DEPTH) return `${path || '(root)'}: nested too deeply`;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? null : `${path}: non-finite number`;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const p = walk(v[i], `${path}[${i}]`, depth + 1);
        if (p) return p;
      }
      return null;
    }
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) return `${path}: not a plain object`;
      for (const [k, child] of Object.entries(v)) {
        if (isSensitiveKey(k))
          return `${path ? `${path}.` : ''}${k}: key is not allowed in audit data`;
        const p = walk(child, path ? `${path}.${k}` : k, depth + 1);
        if (p) return p;
      }
      return null;
    }
    return `${path}: unsupported value type`;
  };
  return walk(value, '', 0);
}
