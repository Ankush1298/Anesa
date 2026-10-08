import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { loggerOptions, type AppLoggerOptions } from '../../src/shared/logging/logger-options.js';
import type { Database } from '../../src/shared/database/index.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://app:change_me@127.0.0.1:5432/db' });
const db = {
  health: () => Promise.resolve({ ok: true as const, serverVersion: '16' }),
} as unknown as Database;

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = { ...loggerOptions('trace'), stream } as AppLoggerOptions;
  return { lines, logger };
}

describe('log redaction (privacy rule: no passwords, tokens, secrets in logs)', () => {
  it('redacts credential-bearing fields', async () => {
    const { lines, logger } = capture();
    const app = buildApp({ config, db, logger });
    app.log.info(
      {
        user: { password: 'P@ssw0rd-secret', token: 'tok-123', refreshToken: 'rt-456' }, // secret-scan:allow (deliberate test fixture)
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=zzz' } },
      },
      'test',
    );
    await app.close();
    const out = lines.join('');
    for (const secret of ['P@ssw0rd-secret', 'tok-123', 'rt-456', 'abc.def.ghi', 'sid=zzz']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('request logs omit headers and query strings', async () => {
    const { lines, logger } = capture();
    const app = buildApp({ config, db, logger });
    await app.inject({
      method: 'GET',
      url: '/health?reset_token=QUERYSECRET',
      headers: { authorization: 'Bearer HEADERSECRET', cookie: 'sid=COOKIESECRET' },
    });
    await app.close();
    const out = lines.join('');
    expect(out).toContain('/health');
    for (const secret of ['QUERYSECRET', 'HEADERSECRET', 'COOKIESECRET']) {
      expect(out).not.toContain(secret);
    }
  });
});
