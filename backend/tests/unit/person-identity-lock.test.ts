import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../../src/shared/database/index.js';
import {
  PERSON_LOCK_PREFIX,
  lockPersonIdentity,
  personLockKey,
} from '../../src/shared/authorization/person-identity.js';

const ORG = '01939A00-0000-7000-8000-000000000A01';
const USER = '01939a00-0000-7000-8000-00000000AA77';

describe('person lock key (must equal the one hashed inside migrations 0016 and 0020)', () => {
  it('is the 0016 prefix + organization_id + ":" + user_id, lower-cased like uuid::text', () => {
    expect(PERSON_LOCK_PREFIX).toBe('app.person_record_exclusive:');
    expect(personLockKey(ORG, USER)).toBe(
      'app.person_record_exclusive:01939a00-0000-7000-8000-000000000a01:01939a00-0000-7000-8000-00000000aa77',
    );
  });

  it('lockPersonIdentity issues exactly one pg_advisory_xact_lock(hashtextextended(key, 0)) statement', async () => {
    const seen: [string, unknown[]][] = [];
    const tx = {
      query: (text: string, params: unknown[]) => {
        seen.push([text, params]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as TenantTx;
    await lockPersonIdentity(tx, ORG, USER);
    expect(seen).toEqual([
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [personLockKey(ORG, USER)]],
    ]);
  });
});
