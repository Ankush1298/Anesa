import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { checkDatabase, createPool } from '../../src/shared/database/pool.js';

const pool = createPool({ connectionString: inject('dbUrl'), ssl: false, max: 2 });

beforeAll(async () => {
  await pool.query('SELECT 1');
});
afterAll(async () => {
  await pool.end();
});

describe('database connectivity', () => {
  it('connects and reports healthy', async () => {
    const status = await checkDatabase(pool);
    expect(status.ok).toBe(true);
  });

  it('runs PostgreSQL 15 or newer (ADR-006)', async () => {
    const { rows } = await pool.query<{ n: number }>(
      "SELECT current_setting('server_version_num')::int AS n",
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(150000);
  });

  it('has the extensions the database blueprint depends on available (08 §1)', async () => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM pg_available_extensions WHERE name = ANY($1)',
      [['pgcrypto', 'citext', 'pg_trgm', 'btree_gist']],
    );
    expect(rows.map((r) => r.name).sort()).toEqual(['btree_gist', 'citext', 'pg_trgm', 'pgcrypto']);
  });

  it('reports failure (not an exception) when the database is unreachable', async () => {
    const broken = createPool({
      connectionString: 'postgresql://x:x@127.0.0.1:1/none',
      ssl: false,
      max: 1,
    });
    expect(await checkDatabase(broken)).toEqual({ ok: false });
    await broken.end();
  });
});
