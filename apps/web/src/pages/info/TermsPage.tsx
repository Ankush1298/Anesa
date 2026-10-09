import { InfoPageLayout } from './InfoPageLayout';
import { Alert } from '../../components/ui/Alert';

export function TermsPage() {
  return (
    <InfoPageLayout
      title="Terms of Service"
      subtitle="Acceptable use and operational agreements for institutional campus access."
      badge="Draft"
    >
      <Alert tone="info">
        <strong>Draft for Institutional Review:</strong> These terms of service represent template
        governance terms for Smart Campus OS. Deploying institutions should customize and adopt
        terms in alignment with their university policies and applicable student handbooks.
      </Alert>

      <section className="prose-section">
        <h2>1. Authorized Access</h2>
        <p>
          Access to Anesa and Smart Campus OS is restricted to active students, faculty, and
          designated administrative personnel of participating institutions. User accounts are
          non-transferable.
        </p>
      </section>

      <section className="prose-section">
        <h2>2. User Responsibilities</h2>
        <p>
          Users are responsible for maintaining the confidentiality of their credentials and for all
          actions conducted through their accounts. You must promptly report any suspected
          compromise of your account or unauthorized access to campus IT personnel.
        </p>
      </section>

      <section className="prose-section">
        <h2>3. Prohibited Activities</h2>
        <p>
          Users are strictly prohibited from attempting to bypass tenant isolation boundaries,
          escalating role privileges without authorization, intercepting session credentials,
          submitting fraudulent attendance or academic records, or executing automated security
          scans against production systems without administrative authorization.
        </p>
      </section>

      <section className="prose-section">
        <h2>4. Institutional Administration</h2>
        <p>
          College administrators retain the authority to provision, modify, suspend, or revoke
          account memberships and role assignments in accordance with institutional conduct
          policies.
        </p>
      </section>
    </InfoPageLayout>
  );
}
