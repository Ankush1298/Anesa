import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { ADMIN, createFakeBackend, STUDENT } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const REQUIRED_FOOTER_LINKS: readonly [string, string][] = [
  ['Help & Support', '/help'],
  ['FAQ', '/faq'],
  ['Privacy Policy', '/privacy'],
  ['Terms of Service', '/terms'],
  ['Cookie Policy', '/cookies'],
  ['Accessibility', '/accessibility'],
  ['Contact', '/contact'],
  ['About Anesa', '/about'],
];

describe('Shared footer', () => {
  it('renders in the public login layout with all required links and copyright', async () => {
    const backend = createFakeBackend({ session: false });
    renderApp(backend, '/login');

    await screen.findByRole('heading', { name: 'Sign in' });

    const footer = screen.getByRole('contentinfo');
    expect(footer).toBeInTheDocument();

    const footerNav = within(footer).getByRole('navigation', { name: 'Footer links' });
    expect(footerNav).toBeInTheDocument();

    for (const [label, to] of REQUIRED_FOOTER_LINKS) {
      const link = within(footerNav).getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', to);
    }

    const currentYear = new Date().getFullYear();
    expect(within(footer).getByText(new RegExp(`© ${currentYear} Anesa`))).toBeInTheDocument();
  });

  it('renders inside the authenticated shell without obstructing primary navigation', async () => {
    const backend = createFakeBackend({ session: true, me: ADMIN });
    renderApp(backend, '/access');

    await screen.findByRole('navigation', { name: 'Primary' });

    const primaryNav = screen.getByRole('navigation', { name: 'Primary' });
    const footer = screen.getByRole('contentinfo');

    // Both landmarks exist and are distinct
    expect(primaryNav).toBeInTheDocument();
    expect(footer).toBeInTheDocument();

    const footerNav = within(footer).getByRole('navigation', { name: 'Footer links' });
    for (const [label, to] of REQUIRED_FOOTER_LINKS) {
      expect(within(footerNav).getByRole('link', { name: label })).toHaveAttribute('href', to);
    }
  });

  it('footer link clicks navigate to the intended routes', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ session: true, me: STUDENT });
    renderApp(backend, '/');

    await screen.findByRole('heading', { name: 'Student home' });

    const footer = screen.getByRole('contentinfo');
    const privacyLink = within(footer).getByRole('link', { name: 'Privacy Policy' });

    await user.click(privacyLink);

    expect(await screen.findByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Privacy Policy · Anesa'));
  });
});

describe('Informational pages routes and content integrity', () => {
  it.each([
    ['About Anesa', '/about', 'About Anesa · Anesa'],
    ['Help & Support', '/help', 'Help & Support · Anesa'],
    ['Frequently Asked Questions', '/faq', 'Frequently Asked Questions · Anesa'],
    ['Privacy Policy', '/privacy', 'Privacy Policy · Anesa'],
    ['Terms of Service', '/terms', 'Terms of Service · Anesa'],
    ['Cookie Policy', '/cookies', 'Cookie Policy · Anesa'],
    ['Accessibility', '/accessibility', 'Accessibility · Anesa'],
    ['Contact', '/contact', 'Contact · Anesa'],
  ])('public access: %s renders at %s with valid title', async (heading, path, expectedTitle) => {
    const backend = createFakeBackend({ session: false });
    const view = renderApp(backend, path);

    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe(expectedTitle));

    // Public shell renders the Sign in button
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    // Footer is present
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();

    view.unmount();
  });

  it.each([
    ['About Anesa', '/about'],
    ['Privacy Policy', '/privacy'],
    ['Accessibility', '/accessibility'],
  ])('authenticated access: %s preserves the user shell', async (heading, path) => {
    const backend = createFakeBackend({ session: true, me: ADMIN });
    const view = renderApp(backend, path);

    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    // Primary navigation and account menu are preserved
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();

    view.unmount();
  });

  it('marks draft legal policies with review notifications', async () => {
    for (const path of ['/privacy', '/terms'] as const) {
      const backend = createFakeBackend({ session: false });
      const view = renderApp(backend, path);

      await screen.findByRole('main');
      expect(screen.getByText(/Draft for Institutional Review/i)).toBeInTheDocument();

      view.unmount();
    }
  });

  it('public shell provides a skip link pointing to the main landmark', async () => {
    const backend = createFakeBackend({ session: false });
    const view = renderApp(backend, '/about');

    await screen.findByRole('heading', { name: 'About Anesa' });

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink).toHaveAttribute('href', '#main');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');

    view.unmount();
  });

  it('has no detectable axe accessibility violations on all informational pages', async () => {
    const paths = [
      '/about',
      '/help',
      '/faq',
      '/privacy',
      '/terms',
      '/cookies',
      '/accessibility',
      '/contact',
    ] as const;

    for (const path of paths) {
      const backend = createFakeBackend({ session: false });
      const view = renderApp(backend, path);

      await screen.findByRole('main');
      const results = await axe(view.container);
      expect(results.violations).toEqual([]);

      view.unmount();
    }
  });
});
