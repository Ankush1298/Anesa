/**
 * Best-effort guard applied to every statement an application module sends through a TenantTx.
 * It exists to make it hard to *accidentally* (or via a lazy injection) alter the transaction's
 * trusted context or break out of it. It is defence in depth; the primary controls are
 * parameterised queries, the lint ban on string-built SQL, and RLS itself.
 */
export class UnsafeSqlError extends Error {
  constructor(reason: string) {
    super(`Refusing to run SQL: ${reason}`);
    this.name = 'UnsafeSqlError';
  }
}

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

const ALLOWED_FIRST_WORD = new Set(['select', 'insert', 'update', 'delete', 'with']);

export function assertSafeSql(text: string): void {
  const stripped = stripLiteralsAndComments(text).trim().toLowerCase();
  const first = /^\(?\s*([a-z]+)/.exec(stripped)?.[1];
  if (!first || !ALLOWED_FIRST_WORD.has(first)) {
    throw new UnsafeSqlError('only SELECT/INSERT/UPDATE/DELETE/WITH statements are allowed');
  }
  if (/\$[a-z_0-9]*\$/.test(stripped)) {
    throw new UnsafeSqlError('dollar-quoted strings are not allowed');
  }
  if (/;\s*\S/.test(stripped)) {
    throw new UnsafeSqlError('multiple statements are not allowed');
  }
  if (
    /\b(set_config|current_setting|pg_sleep|pg_terminate_backend|pg_cancel_backend)\b/.test(
      stripped,
    )
  ) {
    throw new UnsafeSqlError('context and session control functions are not allowed');
  }
  if (/\bapp\s*\.\s*(tenant_id|user_id|actor_kind)\b/.test(stripped)) {
    throw new UnsafeSqlError('trusted context settings must not be referenced');
  }
  if (/\b(row_security|session_authorization|set\s+role|reset\s+role)\b/.test(stripped)) {
    throw new UnsafeSqlError('session-level security settings are not allowed');
  }
}
