// Public surface of the database layer. Application modules import ONLY from here (lint-enforced).
// The raw pool, the driver and the transaction internals are deliberately not exported.
export { ContextRejectedError, Database } from './database.js';
export type { DatabaseStatus } from './pool.js';
export { RuntimeRoleError } from './runtime-role.js';
export { UnsafeSqlError } from './sql-guard.js';
export type { TenantTx } from './tenant-tx.js';
