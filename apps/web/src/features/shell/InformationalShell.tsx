import { useAuth } from '../auth/AuthProvider';
import { AppShell } from './AppShell';
import { PublicShell } from './PublicShell';
import { Spinner } from '../../components/ui/Spinner';

/**
 * Adaptive layout for informational pages.
 * If authenticated, keeps the user inside their full AppShell (navigation, session, topbar).
 * If unauthenticated, displays the clean PublicShell with topbar and sign-in button.
 */
export function InformationalShell() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div className="fullpage">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (status === 'authenticated') {
    return <AppShell />;
  }

  return <PublicShell />;
}
