import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migrations 0016-0019 are committed and pushed, so they are immutable (the runner's checksum drift check would refuse
// a database that already applied them). This pins their exact bytes: any edit, including whitespace, fails here and
// has to be a new migration instead. The hashes were computed from the committed files at the time 0020 was added.
const dir = resolve(import.meta.dirname, '../../../database/migrations');

const PINNED: Record<string, string> = {
  '0016_person_record_exclusivity.sql':
    'b01dcfda665b21d33329ac51bce3f8ea88a03a66554e094f5e4f99624cfb4b15',
  '0017_students_record_fields.sql':
    '1c7ed43919dd68ab3adba91efb753bcc6b7b751a6b10d875c44704bc6df6a585',
  '0018_idempotency_keys.sql': 'b58a1c1f58aa18301dd4e42ee8ecfbb7fe6997aff897f26e3dbb8af824716f3d',
  '0019_students_required_dates_contract.sql':
    '1076131800da137926df1087f86c50a6869e754252ccfd5d9ae2a07963b19b76',
};

describe('pushed migrations are immutable', () => {
  it.each(Object.entries(PINNED))('%s is byte-identical to the committed file', (file, sha256) => {
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    expect(actual).toBe(sha256);
  });
});
