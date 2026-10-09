import { Card } from '../components/ui/Card';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { roleLabel } from '../features/auth/identity';

export function AccountPage() {
  usePageTitle('Account');
  const { identity } = useAuth();
  if (!identity) return null;
  return (
    <>
      <h1>Account</h1>
      <Card title="Profile">
        <dl className="defs">
          <dt>Name</dt>
          <dd>{identity.displayName || 'Not set'}</dd>
          <dt>Roles</dt>
          <dd>{identity.roles.map(roleLabel).join(', ') || 'None'}</dd>
        </dl>
      </Card>
      <Card title="Security">
        <p className="muted">
          Password changes and active-session management are not yet available.
        </p>
      </Card>
    </>
  );
}
