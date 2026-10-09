import { Link } from 'react-router';

export interface FooterLinkItem {
  label: string;
  to: string;
}

export interface FooterSection {
  title: string;
  links: readonly FooterLinkItem[];
}

export const FOOTER_SECTIONS: readonly FooterSection[] = [
  {
    title: 'Support',
    links: [
      { label: 'Help & Support', to: '/help' },
      { label: 'FAQ', to: '/faq' },
      { label: 'Contact', to: '/contact' },
    ],
  },
  {
    title: 'Platform',
    links: [
      { label: 'About Anesa', to: '/about' },
      { label: 'Accessibility', to: '/accessibility' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', to: '/privacy' },
      { label: 'Terms of Service', to: '/terms' },
      { label: 'Cookie Policy', to: '/cookies' },
    ],
  },
] as const;

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="app-footer" aria-label="Site footer">
      <div className="app-footer-inner">
        <nav className="app-footer-nav" aria-label="Footer links">
          {FOOTER_SECTIONS.map((section) => (
            <div key={section.title} className="app-footer-col">
              <h2 className="app-footer-heading">{section.title}</h2>
              <ul className="app-footer-list">
                {section.links.map((link) => (
                  <li key={link.to}>
                    <Link to={link.to} className="app-footer-link">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="app-footer-bottom">
          <p className="app-footer-copyright">
            &copy; {currentYear} Anesa. Smart Campus Operating System.
          </p>
          <p className="app-footer-tagline">Multi-tenant institutional platform baseline.</p>
        </div>
      </div>
    </footer>
  );
}
