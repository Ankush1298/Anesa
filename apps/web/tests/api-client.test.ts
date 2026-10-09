import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { login, fetchMe } from '../src/lib/api/auth-api';
import { ApiClient } from '../src/lib/api/client';
import { ApiError } from '../src/lib/api/errors';
import { createFakeBackend } from './helpers/fakeBackend';

const Any = z.object({ success: z.literal(true) });
const make = (b = createFakeBackend({ session: true })) => ({
  b,
  client: new ApiClient({ basePath: '/api', fetchImpl: b.fetch }),
});
const kindOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof ApiError ? e.kind : 'non-api-error'),
  );

describe('ApiClient: request shape', () => {
  it('is same-origin: relative URL under the base path, credentials same-origin, no cookie/auth headers', async () => {
    const { b, client } = make();
    await fetchMe(client);
    const call = b.state.calls[0]!;
    expect(call.path).toBe('/auth/me');
    expect(call.credentials).toBe('same-origin');
    expect(Object.keys(call.headers)).not.toEqual(expect.arrayContaining(['cookie']));
    expect(call.headers['authorization']).toBeUndefined();
    expect(b.fetch).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    );
  });

  it('never sends the CSRF header on safe requests, even when a token is held', async () => {
    const { b, client } = make();
    client.setCsrfToken(b.state.csrf);
    await fetchMe(client);
    expect(b.state.calls[0]!.headers['x-csrf-token']).toBeUndefined();
  });

  it('sends the CSRF header on every unsafe request once a token is known', async () => {
    const { b, client } = make();
    await fetchMe(client); // delivers the token
    await client.post('/t/mutate', { body: {}, schema: Any });
    await client.post('/auth/logout', { body: {}, schema: Any, public: true });
    for (const c of b.state.calls.filter((x) => x.method === 'POST')) {
      expect(c.headers['x-csrf-token']).toBe(b.state.csrf);
    }
  });

  it('login (public, before a token exists) sends no CSRF header; the token it returns is then used', async () => {
    const { b, client } = make(createFakeBackend());
    await login(client, { email: 'a@b.edu', password: /* secret-scan:allow */ 'pw-pw-pw-pw' });
    expect(b.callsTo('POST', '/auth/login')[0]!.headers['x-csrf-token']).toBeUndefined();
    await client.post('/t/mutate', { body: {}, schema: Any });
    expect(b.callsTo('POST', '/t/mutate')[0]!.headers['x-csrf-token']).toBe(b.state.csrf);
  });

  it('a rejected CSRF token is refreshed from /auth/me and the request is retried exactly once', async () => {
    const { b, client } = make();
    client.setCsrfRefresher(async () => {
      await fetchMe(client);
    });
    client.setCsrfToken('stale-token-stale-token-1');
    await expect(client.post('/t/mutate', { body: {}, schema: Any })).resolves.toEqual({
      success: true,
    });
    const posts = b.callsTo('POST', '/t/mutate');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers['x-csrf-token']).toBe('stale-token-stale-token-1');
    expect(posts[1]!.headers['x-csrf-token']).toBe(b.state.csrf);
    expect(b.callsTo('GET', '/auth/me')).toHaveLength(1);
  });

  it('does not loop: a second CSRF rejection is reported, not retried again', async () => {
    let refreshCount = 0;
    const { b, client } = make(createFakeBackend({ session: true, maxCalls: 5 }));
    client.setCsrfRefresher(() => {
      refreshCount++;
      if (refreshCount > 1) {
        throw new Error('CSRF refresher called more than once');
      }
      return Promise.resolve();
    }); // refresh does not fix the token
    client.setCsrfToken('stale-token-stale-token-1');
    expect(await kindOf(client.post('/t/mutate', { body: {}, schema: Any }))).toBe('csrf');
    expect(refreshCount).toBe(1);
    expect(b.callsTo('POST', '/t/mutate')).toHaveLength(2);
  });

  it('a missing token is rejected by the server (the client does not invent one)', async () => {
    const { client } = make();
    expect(await kindOf(client.post('/t/mutate', { body: {}, schema: Any }))).toBe('csrf');
  });
});

describe('ApiClient: errors', () => {
  it.each([
    ['/t/missing', 'not_found', 404],
    ['/t/forbidden', 'forbidden', 403],
  ])('GET %s -> %s', async (path, kind, status) => {
    const { client } = make();
    const e = (await client.get(path, { schema: Any }).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(e.requestId).toBe('req-1');
  });

  it('401 -> unauthenticated and notifies the session handler; public requests do not', async () => {
    const { b, client } = make(createFakeBackend({ session: false }));
    const handler = vi.fn();
    client.setUnauthorizedHandler(handler);
    expect(await kindOf(fetchMe(client))).toBe('unauthenticated');
    expect(handler).toHaveBeenCalledTimes(1);
    b.state.loginMode = 'invalid';
    expect(
      await kindOf(login(client, { email: 'a@b.edu', password: /* secret-scan:allow */ 'x' })),
    ).toBe('unauthenticated');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('429 carries Retry-After; 500 -> server; network failure -> network; bad JSON / wrong shape -> protocol', async () => {
    const { b, client } = make(createFakeBackend());
    const attempt = () =>
      login(client, { email: 'a@b.edu', password: /* secret-scan:allow */ 'x' }).catch(
        (e: unknown) => e as ApiError,
      );
    b.state.loginMode = 'rate';
    const rl = await attempt();
    expect(rl).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 120 });
    b.state.loginMode = 'server';
    expect(await attempt()).toMatchObject({ kind: 'server', status: 500 });
    b.state.loginMode = 'network';
    expect(await attempt()).toMatchObject({ kind: 'network', status: 0 });
    b.state.loginMode = 'badjson';
    expect(await attempt()).toMatchObject({ kind: 'protocol' });
    b.state.loginMode = 'badshape';
    expect(await attempt()).toMatchObject({ kind: 'protocol' });
  });

  it('error objects never carry the server message or response body', async () => {
    const { client } = make(createFakeBackend());
    const e = (await client
      .get('/t/forbidden', { schema: Any })
      .catch((x: unknown) => x)) as ApiError;
    expect(JSON.stringify(e)).not.toContain('server text');
    expect(e.message).not.toContain('server text');
  });

  it('never writes to the console (no logging of credentials, tokens or bodies)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const { b, client } = make(createFakeBackend());
    b.state.loginMode = 'invalid';
    await login(client, {
      email: 'a@b.edu',
      password: /* secret-scan:allow */ 'hunter2hunter2',
    }).catch(() => undefined);
    b.state.loginMode = 'ok';
    await login(client, { email: 'a@b.edu', password: /* secret-scan:allow */ 'hunter2hunter2' });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
