/**
 * Internal: remembers which context objects were produced by the trusted issuer. A structurally
 * identical object created anywhere else (or cast with `as`) is NOT in this set and is rejected.
 */
const issued = new WeakSet<object>();

export function registerIssued(ctx: object): void {
  issued.add(ctx);
}

export function wasIssued(value: unknown): boolean {
  return typeof value === 'object' && value !== null && issued.has(value);
}
