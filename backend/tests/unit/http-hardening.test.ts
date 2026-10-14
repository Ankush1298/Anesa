import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { Database } from '../../src/shared/database/index.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://app:change_me@127.0.0.1:5432/db' });
// health source that reports the database as unreachable
const db = { health: () => Promise.resolve({ ok: false as const }) } as unknown as Database;

function app() {
  return buildApp({ config, db, logger: false });
}

describe('HTTP hardening', () => {
  it('sets security headers and no-store on every response', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a uniform 404 envelope', async () => {
    const res = await app().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a client-supplied request id', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'attacker-controlled' },
    });
    expect(res.json<{ error: { requestId: string } }>().error.requestId).not.toBe(
      'attacker-controlled',
    );
  });

  it('does not leak internals on unexpected errors', async () => {
    const a = app();
    a.get('/boom', { config: { public: true } }, () => {
      throw new Error('secret internal detail: password=hunter2');
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('secret internal detail');
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
  });

  it('maps AppError to its status without extra detail', async () => {
    const a = app();
    a.get('/denied', { config: { public: true } }, () => {
      throw new AppError(403, 'FORBIDDEN', 'Not allowed.');
    });
    const res = await a.inject({ method: 'GET', url: '/denied' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
  });

  it('rejects malformed JSON with a generic 400', async () => {
    const a = app();
    a.post('/echo', { config: { public: true } }, (req) => req.body);
    const res = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });

  it('reports not-ready (503) without detail when the database is down', async () => {
    const res = await app().inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
  });

  describe('database timeouts', () => {
    const pgError = (code: string): Error =>
      Object.assign(
        new Error(
          'canceling statement due to lock timeout: relation "app.student_programs" secret=hunter2',
        ),
        {
          code,
          constraint: 'student_programs_one_active_uq',
          detail: 'Key (student_id)=(x) SELECT * FROM app.students',
          severity: 'ERROR',
        },
      );

    it.each(['55P03', '57014'])(
      'SQLSTATE %s becomes a safe 503 DATABASE_BUSY with no driver detail',
      async (code) => {
        const a = app();
        a.get('/slow', { config: { public: true } }, () => {
          throw pgError(code);
        });
        const res = await a.inject({ method: 'GET', url: '/slow' });
        expect(res.statusCode).toBe(503);
        expect(res.json<{ error: { code: string; message: string } }>().error).toMatchObject({
          code: 'DATABASE_BUSY',
          message: 'The service is busy. Retry the request.',
        });
        for (const leak of [
          'student_programs',
          'hunter2',
          'SELECT',
          'constraint',
          'timeout',
          code,
        ]) {
          expect(res.body, leak).not.toContain(leak);
        }
      },
    );

    it('40P01 (deadlock) and ordinary database errors stay generic 500s, never 503/409', async () => {
      for (const code of ['40P01', '23505', '23503', '42501', '40001']) {
        const a = app();
        a.get('/err', { config: { public: true } }, () => {
          throw pgError(code);
        });
        const res = await a.inject({ method: 'GET', url: '/err' });
        expect(res.statusCode, code).toBe(500);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
        expect(res.body).not.toContain('student_programs');
      }
    });

    it('an AppError is answered as itself before any timeout mapping (the idempotency 409 is untouched)', async () => {
      const a = app();
      a.get('/claim', { config: { public: true } }, () => {
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Retry shortly.');
      });
      const res = await a.inject({ method: 'GET', url: '/claim' });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    });
  });
});
