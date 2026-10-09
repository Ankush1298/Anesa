import { Link } from 'react-router';
import { Button } from '../components/ui/Button';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';

function StateLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="state-page">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <StateLayout title="Page not found">
      <p>The page you are looking for does not exist or you do not have access to it.</p>
      <Link className="btn btn-primary" to="/">
        Go to home
      </Link>
    </StateLayout>
  );
}

export function ForbiddenPage() {
  usePageTitle('Access restricted');
  return (
    <StateLayout title="Access restricted">
      <p>
        Your account does not include access to this area. If you think it should, contact your
        administrator.
      </p>
      <Link className="btn btn-primary" to="/">
        Go to home
      </Link>
    </StateLayout>
  );
}

/** Signed in, but the backend grants this account no role at all (403 on the identity call). */
export function NoAccessPage() {
  usePageTitle('No access assigned');
  const { logout } = useAuth();
  return (
    <main className="auth-page" id="main">
      <div className="auth-card">
        <h1>No access assigned</h1>
        <p>
          You are signed in, but no role has been assigned to your account yet. Contact your
          institution’s administrator.
        </p>
        <Button onClick={() => void logout()}>Sign out</Button>
      </div>
    </main>
  );
}

export function ErrorPage({ onRetry }: { onRetry: () => void }) {
  usePageTitle('Something went wrong');
  return (
    <main className="auth-page" id="main">
      <div className="auth-card" role="alert">
        <h1>Something went wrong</h1>
        <p>We could not load your session. Check your connection; this is usually temporary.</p>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </main>
  );
}
