import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../../components/ui/Spinner';
import { ErrorPage, ForbiddenPage, NoAccessPage } from '../../pages/StatePages';
import { useAuth } from './AuthProvider';
import { can } from './identity';

/** Route protection for UX. The backend remains the only security boundary. */
export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  switch (auth.status) {
    case 'loading':
      return (
        <div className="fullpage">
          <Spinner label="Restoring your session" />
        </div>
      );
    case 'error':
      return <ErrorPage onRetry={auth.retry} />;
    case 'no_access':
      return <NoAccessPage />;
    case 'unauthenticated':
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    case 'authenticated':
      return <Outlet />;
  }
}

/** Renders the page only if the verified capabilities include one of `anyOf`; otherwise a 403 page. */
export function RequireCapability({
  anyOf,
  children,
}: {
  anyOf: readonly string[];
  children: React.ReactNode;
}) {
  const { identity } = useAuth();
  if (!identity || !can(identity, ...anyOf)) return <ForbiddenPage />;
  return <>{children}</>;
}
