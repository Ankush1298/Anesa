import type { CookieSerializeOptions } from '@fastify/cookie';

export const SESSION_COOKIE = 'session_token';
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * The single definition of the session cookie's attributes. Set and clear MUST use the same
 * name/path/domain/secure/sameSite, otherwise a browser keeps the old cookie. `Secure` is always on
 * (browsers treat http://localhost as a secure context); there is no insecure fallback.
 */
export const SESSION_COOKIE_ATTRS: CookieSerializeOptions = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
};
