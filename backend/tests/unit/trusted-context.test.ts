import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { isTrustedContext } from '../../src/shared/tenancy/trusted-context.js';

const tenantId = uuidv7();
const userId = uuidv7();

describe('TrustedContext', () => {
  it('is recognised only when produced by the issuer', () => {
    const ctx = issueTrustedContext({ tenantId, userId, actorKind: 'STAFF' });
    expect(isTrustedContext(ctx)).toBe(true);
  });

  it('a structurally identical forged object is NOT trusted (casts do not count)', () => {
    const forged = { tenantId, userId, actorKind: 'STAFF' };
    expect(isTrustedContext(forged)).toBe(false);
    expect(isTrustedContext(JSON.parse(JSON.stringify(forged)))).toBe(false);
    expect(
      isTrustedContext({ ...issueTrustedContext({ tenantId, userId, actorKind: 'STAFF' }) }),
    ).toBe(false);
    expect(isTrustedContext(null)).toBe(false);
    expect(isTrustedContext('x')).toBe(false);
  });

  it('is immutable once issued', () => {
    const ctx = issueTrustedContext({ tenantId, userId, actorKind: 'STUDENT' });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as unknown as { tenantId: string }).tenantId = uuidv7();
    }).toThrow(TypeError);
  });

  it('validates its inputs', () => {
    const bad = [
      { tenantId: 'garbage', userId, actorKind: 'STAFF' },
      { tenantId, userId: '3b241101-e2bb-4255-8caf-4136c566a962', actorKind: 'STAFF' },
      { tenantId, userId, actorKind: 'ADMIN' },
      { tenantId, userId, actorKind: 'staff' },
    ] as const;
    for (const b of bad) {
      expect(() => issueTrustedContext(b as never)).toThrow(AppError);
    }
  });

  it('normalises identifiers to lower case', () => {
    const ctx = issueTrustedContext({
      tenantId: tenantId.toUpperCase(),
      userId,
      actorKind: 'STAFF',
    });
    expect(ctx.tenantId).toBe(tenantId);
  });
});
