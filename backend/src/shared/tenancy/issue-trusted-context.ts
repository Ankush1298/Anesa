import { AppError } from '../errors/http-errors.js';
import { isUuidV7 } from '../ids/uuidv7.js';
import { registerIssued } from './context-registry.js';
import type { ActorKind, TrustedContext } from './trusted-context.js';

export interface VerifiedPrincipal {
  /** From the authenticated session record — never from a request body, query, header or URL. */
  readonly tenantId: string;
  readonly userId: string;
  /** Decided by the authorization layer from the user's role assignments (Slice 3). */
  readonly actorKind: ActorKind;
}

/**
 * SECURITY-CRITICAL. Call only from the authentication layer, after the session has been verified
 * and tenant membership resolved server-side. Importing this module from business modules is
 * forbidden by lint (eslint.config.mjs); only src/modules/iam/** and tests may import it.
 *
 * Input is validated, the result is frozen, and it is registered so Database.withTenant() can tell
 * it apart from a forged object.
 */
export function issueTrustedContext(principal: VerifiedPrincipal): TrustedContext {
  if (!isUuidV7(principal.tenantId) || !isUuidV7(principal.userId)) {
    throw new AppError(500, 'INVALID_CONTEXT', 'Trusted context requires UUIDv7 identifiers.');
  }
  if (principal.actorKind !== 'STUDENT' && principal.actorKind !== 'STAFF') {
    throw new AppError(500, 'INVALID_CONTEXT', 'Trusted context requires a known actor kind.');
  }
  const ctx = Object.freeze({
    tenantId: principal.tenantId.toLowerCase(),
    userId: principal.userId.toLowerCase(),
    actorKind: principal.actorKind,
  });
  registerIssued(ctx);
  return ctx as unknown as TrustedContext;
}
