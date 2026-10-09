import type { TenantTx } from '../../shared/database/index.js';

/**
 * Campus timezone policy (docs/architecture/v3/18-academic-structure-f21.md §Timezone).
 *
 * A campus timezone decides which calendar day a class session belongs to, so it must be a real zone with
 * rules, not an abbreviation or an offset. ACCEPTED: `UTC`, and `Area/Location` identifiers that the SERVER'S
 * OWN tz database knows (`pg_timezone_names`, the same database PostgreSQL uses to compute with the value),
 * compared case-sensitively so one canonical spelling is stored: `Asia/Kolkata`, `America/Argentina/Buenos_Aires`.
 * REJECTED, even though PostgreSQL would accept them in `SET TIME ZONE`:
 *   - abbreviations and legacy single-token zones: `IST`, `PST`, `EST`, `EST5EDT`, `CET`, `GMT`, `Factory`;
 *   - POSIX offsets and `UTC+5`, `GMT+5:30`;
 *   - the `Etc/` family (`Etc/GMT+5` has an inverted sign; plain `UTC` covers the legitimate use);
 *   - the `posix/` and `right/` duplicate trees (same rules under another name; `right/` includes leap seconds).
 * Backward-compatibility link names that tzdata still ships (`Asia/Calcutta`, `US/Pacific`) have the
 * `Area/Location` shape and pass when the server knows them: PostgreSQL does not say which names are links,
 * and refusing them would need a hand-maintained list. New campuses should use the canonical name.
 * The shape test below is only a cheap pre-filter; MEMBERSHIP in the server's list is the validator.
 */
const MAX_LENGTH = 64; // same bound as the database CHECK
const SHAPE = /^(?:UTC|[A-Z][A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;
const EXCLUDED_PREFIXES = ['Etc/', 'posix/', 'right/'] as const;

export function hasAcceptableTimezoneShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_LENGTH &&
    SHAPE.test(value) &&
    !EXCLUDED_PREFIXES.some((p) => value.startsWith(p))
  );
}

/** True only for a value that passes the shape filter AND is a zone name the server's tz database lists. */
export async function isSupportedTimezone(tx: TenantTx, value: unknown): Promise<boolean> {
  if (!hasAcceptableTimezoneShape(value)) return false;
  const known = await tx.query('SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = $1', [
    value,
  ]);
  return (known.rowCount ?? 0) > 0;
}
