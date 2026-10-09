import { InfoPageLayout } from './InfoPageLayout';
import { Card } from '../../components/ui/Card';

export function CookiesPage() {
  return (
    <InfoPageLayout
      title="Cookie Policy"
      subtitle="Technical details on session cookies and security tokens used by Smart Campus OS."
    >
      <section className="prose-section">
        <h2>Essential Cookies Only</h2>
        <p>
          Anesa utilizes only strictly necessary cookies essential for security, authentication, and
          session integrity. We do not use advertising, behavioral tracking, or third-party
          marketing cookies.
        </p>
      </section>

      <div className="grid">
        <Card title="Session Authentication Cookie" headingLevel={2}>
          <p>
            An encrypted HTTP-only session identifier used to verify your authenticated identity
            during active browsing. Marked as <code>HttpOnly</code> and <code>SameSite</code> to
            prevent access from client-side scripts and protect against cross-site exploitation.
          </p>
        </Card>

        <Card title="CSRF Defense" headingLevel={2}>
          <p>
            <strong>Origin & header validation:</strong> State-changing requests (such as role
            grants and logins) utilize browser-enforced origin allowlists and client-managed CSRF
            tokens to block unauthorized cross-site requests.
          </p>
        </Card>
      </div>

      <section className="prose-section" style={{ marginTop: 'var(--space-6)' }}>
        <h2>Managing Cookies</h2>
        <p>
          Because our cookies are strictly necessary to maintain your authenticated session and
          protect against unauthorized account actions, disabling cookies in your browser settings
          will prevent you from signing in to the platform.
        </p>
      </section>
    </InfoPageLayout>
  );
}
