import { z } from 'zod';
import {
  CURSOR_KEY_ID_PATTERN,
  CURSOR_MAX_KEYS,
  isCanonicalCursorKey,
} from '../shared/pagination/index.js';

/**
 * Wraps a secret value so it cannot be printed or serialised by accident
 * (logs, JSON responses, util.inspect). The only way to read it is `.reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED]';
  }
}

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),
  DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  TRUST_PROXY: booleanString,
  // Comma-separated browser origins allowed to call state-changing endpoints (CSRF origin check).
  APP_ORIGINS: z.string().default(''),
  // Optional cursor-codec keys: both or neither (see parseCursorKeys). Left undefined, not defaulted, so an explicitly
  // supplied empty string can be told apart from an absent variable and refused.
  CURSOR_KEYS: z.string().optional(),
  CURSOR_ACTIVE_KEY_ID: z.string().optional(),
});

/** Parses APP_ORIGINS: exact origins only (scheme://host[:port]), no paths, no wildcards. */
function parseOrigins(raw: string, problems: string[]): string[] {
  const out: string[] = [];
  for (const item of raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    try {
      const u = new URL(item);
      if (
        (u.protocol !== 'https:' && u.protocol !== 'http:') ||
        u.origin !== item ||
        item.includes('*')
      ) {
        throw new Error();
      }
      out.push(u.origin);
    } catch {
      problems.push('APP_ORIGINS: each entry must be an exact origin like https://app.example.edu');
      break;
    }
  }
  return out;
}

export interface CursorConfig {
  readonly activeKeyId: string;
  /** Every configured key, active and retiring, by ID. Values are canonical unpadded base64url of 32 bytes. */
  readonly keys: ReadonlyMap<string, Secret>;
}

/**
 * CURSOR_KEYS is `<keyId>:<key>` entries separated by commas (no whitespace is trimmed); CURSOR_ACTIVE_KEY_ID names the
 * key used to issue new cursors, every other key only decodes. Both variables or neither: absent means cursor
 * configuration is absent and nothing else changes. Errors name the variable and the rule, never a value.
 */
function parseCursorKeys(
  rawKeys: string | undefined,
  rawActive: string | undefined,
  problems: string[],
): CursorConfig | undefined {
  if (rawKeys === undefined && rawActive === undefined) return undefined;
  if (rawKeys === undefined || rawActive === undefined || rawKeys === '' || rawActive === '') {
    if (rawKeys === undefined)
      problems.push('CURSOR_KEYS: required when CURSOR_ACTIVE_KEY_ID is set');
    if (rawActive === undefined)
      problems.push('CURSOR_ACTIVE_KEY_ID: required when CURSOR_KEYS is set');
    if (rawKeys === '') problems.push('CURSOR_KEYS: must not be empty');
    if (rawActive === '') problems.push('CURSOR_ACTIVE_KEY_ID: must not be empty');
    return undefined;
  }

  const before = problems.length;
  const entries = rawKeys.split(',');
  if (entries.length > CURSOR_MAX_KEYS) {
    problems.push(`CURSOR_KEYS: at most ${CURSOR_MAX_KEYS} keys are allowed`);
    return undefined;
  }
  const keys = new Map<string, Secret>();
  const seenMaterial = new Set<string>();
  entries.forEach((entry, index) => {
    const n = index + 1;
    const parts = entry.split(':');
    const id = parts[0];
    const key = parts[1];
    if (parts.length !== 2 || id === undefined || key === undefined) {
      problems.push(
        `CURSOR_KEYS: entry ${n} must be <keyId>:<key> (empty entries are not allowed)`,
      );
    } else if (!CURSOR_KEY_ID_PATTERN.test(id)) {
      problems.push(
        `CURSOR_KEYS: entry ${n} key ID must be 1 to 16 letters, digits, "-" or "_", starting with a letter or digit`,
      );
    } else if (!isCanonicalCursorKey(key)) {
      problems.push(
        `CURSOR_KEYS: entry ${n} key must be the canonical unpadded base64url encoding of exactly 32 bytes`,
      );
    } else if (keys.has(id)) {
      problems.push(`CURSOR_KEYS: entry ${n} repeats a key ID`);
    } else if (seenMaterial.has(key)) {
      problems.push(`CURSOR_KEYS: entry ${n} repeats key material`);
    } else {
      seenMaterial.add(key);
      keys.set(id, new Secret(key));
    }
  });

  if (!CURSOR_KEY_ID_PATTERN.test(rawActive)) {
    problems.push(
      'CURSOR_ACTIVE_KEY_ID: must be 1 to 16 letters, digits, "-" or "_", starting with a letter or digit',
    );
  } else if (problems.length === before && !keys.has(rawActive)) {
    problems.push('CURSOR_ACTIVE_KEY_ID: must name one of the keys in CURSOR_KEYS');
  }
  return problems.length === before ? { activeKeyId: rawActive, keys } : undefined;
}

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly trustProxy: boolean;
  /** Exact browser origins allowed to send state-changing requests. Empty = same-host only (dev). */
  readonly allowedOrigins: readonly string[];
  readonly database: {
    readonly url: Secret;
    readonly ssl: boolean;
    readonly poolMax: number;
  };
  /** Present only when CURSOR_KEYS and CURSOR_ACTIVE_KEY_ID are both configured. Nothing reads it yet. */
  readonly cursor?: CursorConfig;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates configuration and fails fast. Error messages name the variable and the rule that
 * failed — never the supplied value (values may be secrets).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;

  const problems: string[] = [];
  const allowedOrigins = parseOrigins(e.APP_ORIGINS, problems);
  const cursor = parseCursorKeys(e.CURSOR_KEYS, e.CURSOR_ACTIVE_KEY_ID, problems);
  if (e.NODE_ENV === 'production') {
    if (allowedOrigins.length === 0) {
      problems.push('APP_ORIGINS: required in production (CSRF origin allow-list)');
    } else if (allowedOrigins.some((o) => !o.startsWith('https://'))) {
      problems.push('APP_ORIGINS: must be https:// origins in production');
    }
    if (e.DATABASE_SSL !== 'require') {
      problems.push('DATABASE_SSL: must be "require" in production');
    }
    if (e.HOST === '0.0.0.0' && !e.TRUST_PROXY) {
      problems.push('HOST: binding 0.0.0.0 in production requires TRUST_PROXY=true (behind proxy)');
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    allowedOrigins,
    database: {
      url: new Secret(e.DATABASE_URL),
      ssl: e.DATABASE_SSL === 'require',
      poolMax: e.DATABASE_POOL_MAX,
    },
    ...(cursor ? { cursor } : {}),
  };
}
