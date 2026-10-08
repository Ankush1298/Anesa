import { afterAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';

const url = inject('dbUrl');
const config = loadConfig({ DATABASE_URL: url });
const pool = createPool({ connectionString: url, ssl: false, max: 2 });

afterAll(async () => {
  await pool.end().catch(() => undefined);
});

describe('readiness with a real database', () => {
  it('GET /ready is 200 when the database answers', async () => {
    const app = buildApp({ config, db: new Database(pool), logger: false });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });
});
