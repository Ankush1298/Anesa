import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { assertSafeSql } from './sql-guard.js';

const clients = new WeakMap<TenantTx, PoolClient>();

/**
 * A handle to ONE open transaction whose trusted context (tenant, user, actor kind) is already set.
 * It can run parameterised queries and nothing else: it exposes no way to change the context,
 * begin/commit, or reach the connection, and it stops working the moment the transaction ends.
 */
export class TenantTx {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const client = clients.get(this);
    if (!client) {
      return Promise.reject(new Error('TenantTx used after its transaction ended'));
    }
    assertSafeSql(text);
    return client.query<R>(text, [...values]);
  }
}

/** Internal to shared/database (deliberately not re-exported from index.ts). */
export function openTenantTx(client: PoolClient): TenantTx {
  const tx = new TenantTx();
  clients.set(tx, client);
  return tx;
}

export function closeTenantTx(tx: TenantTx): void {
  clients.delete(tx);
}
