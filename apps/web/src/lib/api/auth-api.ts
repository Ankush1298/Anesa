import type { ApiClient } from './client';
import { LoginResponseSchema, MeResponseSchema, SuccessSchema, type MeResponse } from './schemas';

export interface LoginInput {
  email: string;
  password: string;
  /** Organisation slug; only needed when the account belongs to several organisations. */
  tenant?: string;
}

/** POST /auth/login. Sets the HttpOnly cookie (browser-managed) and returns the CSRF token. */
export async function login(client: ApiClient, input: LoginInput): Promise<void> {
  const body = {
    email: input.email,
    password: input.password,
    ...(input.tenant ? { tenant: input.tenant } : {}),
  };
  const res = await client.post('/auth/login', { body, schema: LoginResponseSchema, public: true });
  client.setCsrfToken(res.csrf_token);
}

/** GET /auth/me: the verified identity + capabilities. Also (re)delivers the CSRF token. */
export async function fetchMe(client: ApiClient, signal?: AbortSignal): Promise<MeResponse> {
  const me = await client.get('/auth/me', {
    schema: MeResponseSchema,
    ...(signal ? { signal } : {}),
  });
  client.setCsrfToken(me.csrf_token);
  return me;
}

/** POST /auth/logout: revokes the session server-side and clears the cookie. */
export async function logout(client: ApiClient): Promise<void> {
  await client.post('/auth/logout', { body: {}, schema: SuccessSchema, public: true });
}
