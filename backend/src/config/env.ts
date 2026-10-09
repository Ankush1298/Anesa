import { z } from 'zod';

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
  };
}
