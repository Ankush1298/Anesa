import { InfoPageLayout } from './InfoPageLayout';
import { Card } from '../../components/ui/Card';

export function HelpPage() {
  return (
    <InfoPageLayout
      title="Help & Support"
      subtitle="Guidance for navigating Anesa, resolving access issues, and contacting administrators."
    >
      <section className="prose-section">
        <h2>Institutional Support Channels</h2>
        <p>
          Smart Campus OS is deployed on an institutional basis. User accounts, permissions, and
          data access are managed directly by your institution's designated administrators.
        </p>
      </section>

      <div className="grid">
        <Card title="Account & Login Issues" headingLevel={2}>
          <p>
            If you cannot sign in or your account has been locked due to repeated incorrect
            passwords, wait 15 minutes for the automated security lock to clear, or contact your
            college administrator to verify your account status.
          </p>
        </Card>

        <Card title="Permission & Role Access" headingLevel={2}>
          <p>
            The pages you can see in the navigation bar depend on the roles assigned to your
            account. If you need access to departmental records or administrative features, request
            a role assignment from your institution's administrator.
          </p>
        </Card>

        <Card title="System Requirements" headingLevel={2}>
          <p>
            Anesa is designed for modern web browsers (Chrome, Firefox, Safari, Edge) with
            JavaScript enabled and cookies permitted for same-origin session authentication.
          </p>
        </Card>

        <Card title="Developer & Operator Docs" headingLevel={2}>
          <p>
            System administrators and developers managing campus deployments can consult the
            architecture documentation in <code>docs/architecture/v3/</code> and setup scripts in
            the project repository.
          </p>
        </Card>
      </div>

      <section className="prose-section" style={{ marginTop: 'var(--space-6)' }}>
        <h2>Session Security</h2>
        <p>
          For security, sessions automatically expire after periods of inactivity. If your session
          ends, you will be prompted to sign in again. Always use the <strong>Sign out</strong>{' '}
          button in the account menu when using a shared terminal.
        </p>
      </section>
    </InfoPageLayout>
  );
}
