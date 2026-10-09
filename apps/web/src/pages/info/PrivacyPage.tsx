import { InfoPageLayout } from './InfoPageLayout';
import { Alert } from '../../components/ui/Alert';

export function PrivacyPage() {
  return (
    <InfoPageLayout
      title="Privacy Policy"
      subtitle="Institutional privacy principles, data governance, and tenant isolation standards."
      badge="Draft"
    >
      <Alert tone="info">
        <strong>Draft for Institutional Review:</strong> This privacy policy is a baseline
        specification for Smart Campus OS deployments. Institutional legal counsel and campus data
        protection officers must review and approve final policy text prior to production
        operations.
      </Alert>

      <section className="prose-section">
        <h2>1. Scope & Institutional Governance</h2>
        <p>
          This policy describes how Smart Campus OS processes institutional records and user
          identity information. Each participating educational institution acts as the primary data
          controller for its students, faculty, and administrative personnel.
        </p>
      </section>

      <section className="prose-section">
        <h2>2. Tenant Isolation & Data Segregation</h2>
        <p>
          Smart Campus OS enforces strict architectural tenant segregation. Student information,
          guardian contact details, course enrollments, and institutional configurations are
          isolated using PostgreSQL Row-Level Security policies. Administrative personnel of one
          institution cannot access records belonging to another institution.
        </p>
      </section>

      <section className="prose-section">
        <h2>3. Credential & Authentication Security</h2>
        <p>
          User passwords are protected with salted Argon2id hashing algorithms before storage. Plain
          text passwords are never stored in databases, printed in system logs, or transmitted to
          third parties. Session credentials are transmitted solely in secure, HttpOnly cookies.
        </p>
      </section>

      <section className="prose-section">
        <h2>4. Audit Logging & Accountability</h2>
        <p>
          To ensure security accountability, all administrative role grants, revoking of privileges,
          and identity status updates are recorded in an append-only audit event ledger with
          timestamps, actor contexts, and justification records.
        </p>
      </section>

      <section className="prose-section">
        <h2>5. Tracking & Analytics</h2>
        <p>
          Smart Campus OS does not employ third-party advertising trackers, cross-site tracking
          beacons, or commercial analytics scripts. Telemetry is restricted to necessary operational
          health monitoring.
        </p>
      </section>
    </InfoPageLayout>
  );
}
