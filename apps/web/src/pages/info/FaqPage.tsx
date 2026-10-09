import { InfoPageLayout } from './InfoPageLayout';

const FAQ_ITEMS = [
  {
    q: 'What is Anesa?',
    a: 'Anesa is the official web interface for Smart Campus OS, providing administrative and student access to institutional services with strict role-based isolation.',
  },
  {
    q: 'How does multi-tenant isolation work?',
    a: 'Each campus is a distinct tenant. Multi-tenant isolation is enforced at the database level using PostgreSQL Row-Level Security (RLS). Users and data from one institution cannot be seen or queried by another institution.',
  },
  {
    q: 'Why do some sections say "Not yet available"?',
    a: 'Smart Campus OS is being delivered in modular milestones. Milestone 1 establishes the security, tenancy, audit, and authentication foundation. Domain features such as academic calendars, courses, and student records are planned for upcoming checkpoints.',
  },
  {
    q: 'What roles exist on the platform?',
    a: 'The authorization system supports College Administrators, Campus Administrators, Heads of Department (HOD), Faculty members, and Students. Navigation items and operational capabilities are derived from verified server-side grants.',
  },
  {
    q: 'How does authentication work?',
    a: 'Your credentials are authenticated globally via Argon2id hashing, followed by verification of active tenant membership. Sessions are issued through secure HttpOnly cookies, protecting tokens against browser-side script access.',
  },
  {
    q: 'Is biometric or facial recognition attendance supported?',
    a: 'No. In accordance with platform architectural decision ADR-016, biometric facial recognition is deferred and excluded from the core platform to protect student privacy and ensure data protection standards.',
  },
] as const;

export function FaqPage() {
  return (
    <InfoPageLayout
      title="Frequently Asked Questions"
      subtitle="Common questions about Smart Campus OS architecture, roles, and feature availability."
    >
      <div className="faq-list">
        {FAQ_ITEMS.map((item) => (
          <section key={item.q} className="faq-item">
            <h2 className="faq-question">{item.q}</h2>
            <p className="faq-answer">{item.a}</p>
          </section>
        ))}
      </div>
    </InfoPageLayout>
  );
}
