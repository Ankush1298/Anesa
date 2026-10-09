import { z } from 'zod';

/**
 * The ONLY public configuration of the browser app. Everything under VITE_ is embedded in the
 * bundle and visible to every visitor, so it may hold nothing secret; the schema accepts only a
 * same-origin path (never an absolute URL), which keeps cookies and CSRF checks same-origin by
 * construction and makes it impossible to point the client at another host by configuration.
 */
const PublicEnvSchema = z.object({
  VITE_API_BASE_PATH: z
    .string()
    .regex(/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/, 'must be a same-origin path like /api')
    .default('/api'),
});

export interface PublicConfig {
  /** Same-origin path prefix of the API, without a trailing slash ("" means the origin root). */
  readonly apiBasePath: string;
}

export class PublicConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid public configuration: ${problems.join('; ')}`);
    this.name = 'PublicConfigError';
  }
}

export function loadPublicConfig(source: Record<string, unknown>): PublicConfig {
  const parsed = PublicEnvSchema.safeParse({
    VITE_API_BASE_PATH:
      source['VITE_API_BASE_PATH'] === '' ? undefined : source['VITE_API_BASE_PATH'],
  });
  if (!parsed.success) {
    // names the variable and the rule, never the supplied value
    throw new PublicConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const base = parsed.data.VITE_API_BASE_PATH;
  return { apiBasePath: base === '/' ? '' : base };
}
