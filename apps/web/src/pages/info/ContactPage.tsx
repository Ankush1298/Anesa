import { InfoPageLayout } from './InfoPageLayout';
import { Card } from '../../components/ui/Card';

export function ContactPage() {
  return (
    <InfoPageLayout
      title="Contact"
      subtitle="Institutional assistance, administrative contacts, and developer documentation."
    >
      <section className="prose-section">
        <h2>Campus Communication Points</h2>
        <p>
          Because Smart Campus OS operates as an institutional platform, direct account support,
          enrollment questions, and policy inquiries are handled directly by each campus.
        </p>
      </section>

      <div className="grid">
        <Card title="Institutional Helpdesk" headingLevel={2}>
          <p>
            For student login assistance, forgotten passwords, or enrollment questions, contact your
            college IT department or registrar's office through your university's official support
            portal.
          </p>
        </Card>

        <Card title="Campus Administrators" headingLevel={2}>
          <p>
            Departmental faculty and staff requiring role elevations or administrative access should
            reach out to their designated College Administrator or Head of Department.
          </p>
        </Card>

        <Card title="System Engineers & DevOps" headingLevel={2}>
          <p>
            Platform operators managing deployment infrastructure, PostgreSQL database instances, or
            embedded development servers can reference the repository documentation in{' '}
            <code>docs/runbooks/</code>.
          </p>
        </Card>

        <Card title="Security Inquiries" headingLevel={2}>
          <p>
            Security audit reports and vulnerability assessments should be submitted through your
            institution's authorized security coordination team or repository security channels.
          </p>
        </Card>
      </div>
    </InfoPageLayout>
  );
}
