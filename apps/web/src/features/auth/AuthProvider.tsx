import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  type LoginInput,
} from '../../lib/api/auth-api';
import type { ApiClient } from '../../lib/api/client';
import { isApiError } from '../../lib/api/errors';
import { toIdentity, type Identity } from './identity';

export type AuthStatus =
  | 'loading' // restoring the session
  | 'authenticated'
  | 'unauthenticated'
  | 'no_access' // valid session but the backend grants this account nothing (403 on /auth/me)
  | 'error'; // could not determine (network / server)

interface AuthState {
  status: AuthStatus;
  identity: Identity | null;
  /** One-shot message for the login page, e.g. "Your session has expired." */
  notice: string | null;
}

export interface AuthApi extends AuthState {
  login: (input: LoginInput) => Promise<void>; // rejects with ApiError on failure
  logout: () => Promise<void>;
  retry: () => void;
  clearNotice: () => void;
}

const AuthContext = createContext<AuthApi | null>(null);

const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';

export function AuthProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    identity: null,
    notice: null,
  });
  const [attempt, setAttempt] = useState(0);
  const sessionActive = useRef(false);

  const signedOut = useCallback(
    (notice: string | null): void => {
      client.clearCsrfToken();
      sessionActive.current = false;
      setState({ status: 'unauthenticated', identity: null, notice });
    },
    [client],
  );

  // Any 401 on an authenticated call means the server no longer accepts the session.
  useEffect(() => {
    client.setUnauthorizedHandler(() => {
      if (sessionActive.current) signedOut(SESSION_EXPIRED);
    });
    client.setCsrfRefresher(async () => {
      await fetchMe(client); // GET /auth/me re-delivers the token
    });
    return () => {
      client.setUnauthorizedHandler(null);
      client.setCsrfRefresher(null);
    };
  }, [client, signedOut]);

  // Restore the session from the HttpOnly cookie (the browser sends it; we never read it).
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => (s.status === 'loading' ? s : { ...s, status: 'loading' }));
    fetchMe(client, controller.signal).then(
      (me) => {
        sessionActive.current = true;
        setState({ status: 'authenticated', identity: toIdentity(me), notice: null });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiError(err) && err.kind === 'unauthenticated') {
          setState({ status: 'unauthenticated', identity: null, notice: null });
        } else if (isApiError(err) && err.kind === 'forbidden') {
          sessionActive.current = true;
          setState({ status: 'no_access', identity: null, notice: null });
        } else {
          setState({ status: 'error', identity: null, notice: null });
        }
      },
    );
    return () => controller.abort();
  }, [client, attempt]);

  const login = useCallback(
    async (input: LoginInput): Promise<void> => {
      await apiLogin(client, input);
      try {
        const me = await fetchMe(client); // identity and capabilities come from the backend, not the form
        sessionActive.current = true;
        setState({ status: 'authenticated', identity: toIdentity(me), notice: null });
      } catch (err) {
        if (!(isApiError(err) && err.kind === 'forbidden')) throw err;
        sessionActive.current = true; // signed in, but the backend grants this account nothing
        setState({ status: 'no_access', identity: null, notice: null });
      }
    },
    [client],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiLogout(client);
    } catch {
      /* the server may be unreachable; local state must still be cleared */
    } finally {
      signedOut(null);
    }
  }, [client, signedOut]);

  const api = useMemo<AuthApi>(
    () => ({
      ...state,
      login,
      logout,
      retry: () => setAttempt((n) => n + 1),
      clearNotice: () => setState((s) => ({ ...s, notice: null })),
    }),
    [state, login, logout],
  );
  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
