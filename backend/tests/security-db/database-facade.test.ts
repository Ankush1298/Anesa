import { afterAll, describe, expect, inject, it } from 'vitest';
import { Database, RuntimeRoleError } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { CTX, ORG_C } from '../support/fixtures.js';
import { adminQuery } from '../support/db-harness.js';

const runtimeDb = new Database(
  createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 5 }),
);
afterAll(async () => {
  await runtimeDb.close();
});

// Tenant C is used here so committed writes cannot disturb the Tenant A/B assertions elsewhere.
const staffC = issueTrustedContext({
  tenantId: CTX.staffC.tenant,
  userId: CTX.staffC.user,
  actorKind: 'STAFF',
});

async function newUserRow(): Promise<{ id: string; email: string }> {
  const id = uuidv7();
  const email = `u${id.slice(-12)}@college-c.test`;
  await runtimeDb.withTenant(staffC, (tx) =>
    tx.query(
      "INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, $3, 'Temp', 'ACTIVE')",
      [id, ORG_C, email],
    ),
  );
  return { id, email };
}
const cleanup = (id: string): Promise<unknown> =>
  adminQuery('DELETE FROM app.users WHERE id = $1', [id]);

describe('Database.withTenant()', () => {
  it('commits work done under a trusted context', async () => {
    const { id } = await newUserRow();
    try {
      const stored = await adminQuery('SELECT organization_id FROM app.users WHERE id = $1', [id]);
      expect(stored).toEqual([{ organization_id: ORG_C }]);
    } finally {
      await cleanup(id);
    }
  });

  it('rolls back everything when the work fails', async () => {
    const id = uuidv7();
    await expect(
      runtimeDb.withTenant(staffC, async (tx) => {
        await tx.query(
          "INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, 'rolled@college-c.test', 'R', 'ACTIVE')",
          [id, ORG_C],
        );
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await adminQuery('SELECT 1 FROM app.users WHERE id = $1', [id])).toEqual([]);
  });

  it('cannot write into another tenant even with a perfectly valid statement', async () => {
    const id = uuidv7();
    await expect(
      runtimeDb.withTenant(staffC, (tx) =>
        tx.query(
          "INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, 'x@college-a.test', 'X', 'ACTIVE')",
          [id, CTX.staffA.tenant],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('versioned updates prevent silent lost updates (optimistic locking support)', async () => {
    const { id } = await newUserRow();
    try {
      const bump = (expected: number): Promise<number> =>
        runtimeDb.withTenant(
          staffC,
          async (tx) =>
            (
              await tx.query(
                'UPDATE app.users SET display_name = $3 WHERE id = $1 AND version = $2',
                [id, expected, `v${expected}`],
              )
            ).rowCount ?? 0,
        );
      expect(await bump(1)).toBe(1); // version 1 -> 2 (trigger)
      expect(await bump(1)).toBe(0); // stale writer is refused, nothing overwritten
      const [row] = await adminQuery<{ display_name: string; version: number }>(
        'SELECT display_name, version FROM app.users WHERE id = $1',
        [id],
      );
      expect(row).toEqual({ display_name: 'v1', version: 2 });
    } finally {
      await cleanup(id);
    }
  });

  it('two concurrent writers holding the same version: exactly one wins', async () => {
    const { id } = await newUserRow();
    try {
      const attempt = (label: string): Promise<number> =>
        runtimeDb.withTenant(
          staffC,
          async (tx) =>
            (
              await tx.query(
                'UPDATE app.users SET display_name = $2 WHERE id = $1 AND version = 1',
                [id, label],
              )
            ).rowCount ?? 0,
        );
      const results = await Promise.all(Array.from({ length: 8 }, (_v, i) => attempt(`w${i}`)));
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    } finally {
      await cleanup(id);
    }
  });

  it('reports database health without a tenant context', async () => {
    const status = await runtimeDb.health();
    expect(status.ok).toBe(true);
  });
});

describe('runtime role verification (startup self-check)', () => {
  it('accepts app_runtime', async () => {
    await expect(runtimeDb.verifyRuntimeRole()).resolves.toBeUndefined();
  });

  it('refuses to run as the migration owner', async () => {
    const db = new Database(
      createPool({ connectionString: inject('dbMigratorUrl'), ssl: false, max: 1 }),
    );
    try {
      const err = await db.verifyRuntimeRole().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeRoleError);
      expect((err as RuntimeRoleError).problems.join(' ')).toMatch(/app_runtime/);
    } finally {
      await db.close();
    }
  });

  it('refuses to run as a superuser', async () => {
    const db = new Database(
      createPool({ connectionString: inject('dbAdminUrl'), ssl: false, max: 1 }),
    );
    try {
      const err = await db.verifyRuntimeRole().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RuntimeRoleError);
      expect((err as RuntimeRoleError).problems.join(' ')).toMatch(/superuser/);
    } finally {
      await db.close();
    }
  });
});
