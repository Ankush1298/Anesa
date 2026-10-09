import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

export interface MeData {
  tenant_id: string;
  user_id: string;
  actor_kind: 'STUDENT' | 'STAFF';
  display_name: string;
  roles: string[];
  capabilities: string[];
}

export const STUDENT: MeData = {
  tenant_id: 't1',
  user_id: 'u1',
  actor_kind: 'STUDENT',
  display_name: 'Asha Student',
  roles: ['STUDENT'],
  capabilities: [
    'session.read',
    'session.revoke',
    'student.profile.read',
    'student.profile.read_sensitive',
  ],
};
export const STAFF: MeData = {
  tenant_id: 't1',
  user_id: 'u2',
  actor_kind: 'STAFF',
  display_name: 'Hari HOD',
  roles: ['HOD'],
  capabilities: ['session.read', 'session.revoke', 'student.profile.read'],
};
export const ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u3',
  actor_kind: 'STAFF',
  display_name: 'Ada Admin',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'session.revoke_any',
    'student.profile.read',
    'org.settings.read',
    'org.campus.manage',
    'org.department.manage',
    'role.assignment.grant',
    'role.assignment.revoke',
  ],
};

type Mode = 'ok' | 'invalid' | 'rate' | 'network' | 'server' | 'badjson' | 'badshape';

/** A stand-in for the real backend, implementing the documented contracts including CSRF enforcement. */
export function createFakeBackend(
  init: { me?: MeData; session?: boolean; maxCalls?: number } = {},
) {
  const state = {
    session: init.session ?? false,
    me: init.me ?? STUDENT,
    csrf: 'csrf-0123456789abcdef-token',
    loginMode: 'ok' as Mode,
    meMode: 'ok' as Mode | 'noaccess',
    logoutMode: 'ok' as Mode,
    calls: [] as Call[],
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const err = (status: number, code: string, headers: Record<string, string> = {}): Response =>
    json(
      status,
      { error: { code, message: 'server text that must never be shown', requestId: 'req-1' } },
      headers,
    );

  const fetchMock = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handle(url, reqInit));
  });

  const handle = (url: string, reqInit?: RequestInit): Response => {
    if (init.maxCalls !== undefined && state.calls.length >= init.maxCalls) {
      throw new Error(
        `fakeBackend: exceeded call limit (${init.maxCalls}), possible infinite retry loop`,
      );
    }
    const method = (reqInit?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((reqInit?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const path = url.replace(/^\/api/, '');
    state.calls.push({
      method,
      path,
      headers,
      credentials: reqInit?.credentials,
      body: typeof reqInit?.body === 'string' ? (JSON.parse(reqInit.body) as unknown) : undefined,
    });

    if (path === '/auth/login' && method === 'POST') {
      switch (state.loginMode) {
        case 'network':
          throw new TypeError('Failed to fetch');
        case 'invalid':
          return err(401, 'INVALID_CREDENTIALS');
        case 'rate':
          return err(429, 'TOO_MANY_REQUESTS', { 'retry-after': '120' });
        case 'server':
          return err(500, 'INTERNAL_ERROR');
        case 'badjson':
          return new Response('<html>oops</html>', { status: 200 });
        case 'badshape':
          return json(200, { success: true });
        case 'ok':
          state.session = true;
          return json(200, {
            success: true,
            tenant_id: state.me.tenant_id,
            csrf_token: state.csrf,
          });
      }
    }
    if (path === '/auth/me' && method === 'GET') {
      if (state.meMode === 'network') throw new TypeError('Failed to fetch');
      if (state.meMode === 'server') return err(500, 'INTERNAL_ERROR');
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (state.meMode === 'noaccess') return err(403, 'FORBIDDEN');
      return json(200, { ...state.me, csrf_token: state.csrf, extra_unknown_field: 'dropped' });
    }
    if (path === '/auth/logout' && method === 'POST') {
      if (state.logoutMode === 'network') throw new TypeError('Failed to fetch');
      if (state.logoutMode === 'server') return err(500, 'INTERNAL_ERROR');
      state.session = false;
      return json(200, { success: true });
    }
    if (path === '/t/mutate' && method !== 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, { success: true });
    }
    if (path === '/t/missing') return err(404, 'RESOURCE_NOT_FOUND');
    if (path === '/t/forbidden') return err(403, 'FORBIDDEN');
    return err(404, 'RESOURCE_NOT_FOUND');
  };

  return {
    state,
    fetch: fetchMock as unknown as typeof fetch,
    callsTo: (method: string, path: string) =>
      state.calls.filter((c) => c.method === method && c.path === path),
    /** Server-side session end (expiry/revocation) without the client noticing. */
    expireSession: () => {
      state.session = false;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;
