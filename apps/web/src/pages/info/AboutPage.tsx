import { InfoPageLayout } from './InfoPageLayout';
import { Card } from '../../components/ui/Card';

export function AboutPage() {
  return (
    <InfoPageLayout
      title="About Anesa"
      subtitle="The web interface for Smart Campus OS — a secure, multi-tenant campus operating platform."
      badge="Smart Campus OS"
    >
      <section className="prose-section">
        <h2>Platform Overview</h2>
        <p>
          Anesa serves as the administrative and user-facing web portal for Smart Campus OS. The
          platform is engineered specifically for colleges, universities, and educational campuses
          that require strict tenant isolation, role-based governance, and auditable operations.
        </p>
      </section>

      <div className="grid">
        <Card title="Tenant Isolation" headingLevel={2}>
          <p>
            Data segregation is enforced at the database layer using PostgreSQL Row-Level Security
            (RLS). Every query operates inside an authenticated, verified tenant context, preventing
            cross-institutional data leakage by construction.
          </p>
        </Card>

        <Card title="Role-Based Authorization" headingLevel={2}>
          <p>
            Authorization is driven by a server-side capability matrix. Distinct role models
            distinguish College Administrators, Campus Administrators, Heads of Department (HOD),
            Faculty, and Students.
          </p>
        </Card>

        <Card title="Audited Operations" headingLevel={2}>
          <p>
            Security-relevant operations, including role assignments and critical administrative
            grants, are immutably captured in an append-only audit event log with mandatory
            justification metadata.
          </p>
        </Card>

        <Card title="Defense in Depth" headingLevel={2}>
          <p>
            Authentication employs Argon2id password hashing, HttpOnly session cookies, distributed
            login rate limiting, and origin-validated CSRF defenses across all state-changing
            requests.
          </p>
        </Card>
      </div>

      <section className="prose-section" style={{ marginTop: 'var(--space-6)' }}>
        <h2>Current Milestone & Roadmap</h2>
        <p>
          The platform is currently operating on <strong>Milestone 1</strong>: foundational tenant
          isolation, authentication, authorization, audit logging, and core application shells are
          active. Subsequent milestones will introduce academic structure (campuses, departments,
          courses, terms) and student enrollment.
        </p>
      </section>
    </InfoPageLayout>
  );
}
