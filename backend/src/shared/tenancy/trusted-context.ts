import { wasIssued } from './context-registry.js';

declare const trustedBrand: unique symbol;

export type ActorKind = 'STUDENT' | 'STAFF';

/**
 * The only thing the database layer accepts as "who is asking and for which tenant".
 * It is created by `issueTrustedContext` (see issue-trusted-context.ts) after the request has been
 * authenticated and its tenant membership resolved. It never carries client-supplied values.
 */
export interface TrustedContext {
  readonly [trustedBrand]: true;
  readonly tenantId: string;
  readonly userId: string;
  readonly actorKind: ActorKind;
}

/** Runtime check: true only for objects produced by the trusted issuer (casts do not count). */
export function isTrustedContext(value: unknown): value is TrustedContext {
  return wasIssued(value);
}
