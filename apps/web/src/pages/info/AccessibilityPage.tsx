import { InfoPageLayout } from './InfoPageLayout';
import { Card } from '../../components/ui/Card';

export function AccessibilityPage() {
  return (
    <InfoPageLayout
      title="Accessibility"
      subtitle="Our commitment to accessible, inclusive software compliant with WCAG 2.2 AA standards."
    >
      <section className="prose-section">
        <h2>Standards & Commitments</h2>
        <p>
          Smart Campus OS is committed to ensuring digital accessibility for students, faculty, and
          administrators of all abilities. The Anesa frontend is designed and tested against the Web
          Content Accessibility Guidelines (WCAG) 2.2 Level AA standards.
        </p>
      </section>

      <div className="grid">
        <Card title="Color Contrast" headingLevel={2}>
          <p>
            All interface text colors, control boundaries, and interactive states meet or exceed
            WCAG 2.2 AA contrast requirements (standard body text achieves at least 7:1 contrast on
            surfaces).
          </p>
        </Card>

        <Card title="Keyboard Navigation" headingLevel={2}>
          <p>
            Every page includes a bypass skip link (<em>Skip to main content</em>). All interactive
            buttons, links, navigation drawers, and account menus are operable via keyboard with
            visible focus indicators.
          </p>
        </Card>

        <Card title="Semantic Landmarks" headingLevel={2}>
          <p>
            Pages are structured with semantic HTML5 elements (<code>&lt;header&gt;</code>,{' '}
            <code>&lt;nav&gt;</code>, <code>&lt;main&gt;</code>, <code>&lt;footer&gt;</code>) and
            descriptive ARIA labels to ensure screen readers navigate content predictably.
          </p>
        </Card>

        <Card title="Automated Verification" headingLevel={2}>
          <p>
            The project repository integrates automated <code>axe-core</code> accessibility auditing
            into its test suites to catch regressions in color contrast, landmark roles, and ARIA
            attributes.
          </p>
        </Card>
      </div>

      <section className="prose-section" style={{ marginTop: 'var(--space-6)' }}>
        <h2>Feedback & Assistance</h2>
        <p>
          If you encounter an accessibility barrier or require content in an alternative format,
          please notify your institution’s disability services coordinator or IT helpdesk.
        </p>
      </section>
    </InfoPageLayout>
  );
}
