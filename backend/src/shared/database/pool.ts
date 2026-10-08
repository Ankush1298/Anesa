import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  ssl: boolean;
  max: number;
  applicationName?: string;
  onError?: (err: Error) => void;
}

/**
 * Slice 0: connectivity only. Slice 1 replaces direct pool use with the tenant-scoped
 * `withTenant` transaction wrapper (ADR-019); this module will then be the only place that
 * touches the driver (enforced by the no-restricted-imports lint rule).
 */
export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    ssl: opts.ssl ? { rejectUnauthorized: true } : false,
    application_name: opts.applicationName ?? 'campusos-backend',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An error on an idle client must never crash the process or leak connection details.
  pool.on('error', (err) => opts.onError?.(err));
  return pool;
}

export type Queryable = Pick<pg.Pool, 'query'>;

export type DatabaseStatus = { ok: true; serverVersion: string } | { ok: false };

export async function checkDatabase(db: Queryable): Promise<DatabaseStatus> {
  try {
    const res = await db.query<{ server_version: string }>('SHOW server_version');
    return { ok: true, serverVersion: res.rows[0]?.server_version ?? 'unknown' };
  } catch {
    return { ok: false };
  }
}
