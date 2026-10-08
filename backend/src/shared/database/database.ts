import type { Pool } from 'pg';
import { AppError } from '../errors/http-errors.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { checkDatabase, createPool, type DatabaseStatus, type PoolOptions } from './pool.js';
import { verifyRuntimeRole } from './runtime-role.js';
import { closeTenantTx, openTenantTx, type TenantTx } from './tenant-tx.js';

export class ContextRejectedError extends AppError {
  constructor() {
    super(401, 'CONTEXT_REJECTED', 'The authenticated context is not valid for this tenant.');
  }
}

/**
 * The ONLY door to tenant data for application code.
 *
 *   acquire connection -> BEGIN -> set transaction-local context -> verify it in the database
 *   -> run work -> COMMIT | ROLLBACK -> release
 *
 * The context is accepted only as a TrustedContext issued by the authentication layer (a client
 * supplied tenant id has no way in). It is written with set_config(..., is_local => true), so it
 * disappears at COMMIT/ROLLBACK and can never be inherited by the next user of a pooled connection.
 */
export class Database {
  constructor(private readonly pool: Pool) {}

  static connect(options: PoolOptions): Database {
    return new Database(createPool(options));
  }

  async withTenant<T>(ctx: TrustedContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }

    const client = await this.pool.connect();
    let tx: TenantTx | undefined;
    let connectionBroken = false;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id', $2, true),
                set_config('app.actor_kind', $3, true)`,
        [ctx.tenantId, ctx.userId, ctx.actorKind],
      );
      // The database itself confirms that this user is an active member of this tenant.
      const probe = await client.query<{ ok: boolean }>('SELECT app.context_ok() AS ok');
      if (probe.rows[0]?.ok !== true) throw new ContextRejectedError();

      tx = openTenantTx(client);
      const result = await work(tx);
      closeTenantTx(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (tx) closeTenantTx(tx);
      try {
        await client.query('ROLLBACK');
      } catch {
        connectionBroken = true; // state unknown: never put this connection back in the pool
      }
      throw err;
    } finally {
      client.release(connectionBroken ? true : undefined);
    }
  }

  /**
   * For authentication and platform-level operations that run *before* a tenant context
   * is established (e.g. login, session validation).
   */
  async withSystem<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let tx: TenantTx | undefined;
    let connectionBroken = false;
    try {
      await client.query('BEGIN');
      tx = openTenantTx(client);
      const result = await work(tx);
      closeTenantTx(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (tx) closeTenantTx(tx);
      try {
        await client.query('ROLLBACK');
      } catch {
        connectionBroken = true;
      }
      throw err;
    } finally {
      client.release(connectionBroken ? true : undefined);
    }
  }

  health(): Promise<DatabaseStatus> {
    return checkDatabase(this.pool);
  }

  /** Throws RuntimeRoleError unless connected as the least-privilege app_runtime role. */
  verifyRuntimeRole(): Promise<void> {
    return verifyRuntimeRole(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
