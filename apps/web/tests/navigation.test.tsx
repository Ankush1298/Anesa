import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { ADMIN, createFakeBackend, STAFF, STUDENT, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const navLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Primary' }))
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');

async function open(me: MeData, path = '/') {
  const b = createFakeBackend({ session: true, me });
  const view = renderApp(b, path);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { b, ...view };
}

describe('role-based navigation comes from backend-derived identity', () => {
  it('student: student shell, student wording, no staff/admin items', async () => {
    await open(STUDENT);
    expect(screen.getByRole('heading', { name: 'Student home' })).toBeInTheDocument();
    expect(navLinks()).toEqual(['Home', 'My profile']);
  });

  it('staff (HOD): staff shell with Students, no administration items', async () => {
    await open(STAFF);
    expect(screen.getByRole('heading', { name: 'Staff home' })).toBeInTheDocument();
    expect(navLinks()).toEqual(['Home', 'Students']);
  });

  it('administrator: administration shell with organisation and access items', async () => {
    await open(ADMIN);
    expect(screen.getByRole('heading', { name: 'Administration home' })).toBeInTheDocument();
    expect(navLinks()).toEqual(['Home', 'Students', 'Organisation', 'Roles & access']);
  });

  it('is driven by capabilities, not role names: an unknown role with admin capabilities gets the admin menu', async () => {
    await open({ ...STAFF, roles: ['SOME_FUTURE_ROLE'], capabilities: [...ADMIN.capabilities] });
    expect(navLinks()).toContain('Roles & access');
    expect(screen.getByText('SOME_FUTURE_ROLE')).toBeInTheDocument();
  });

  it('is NOT driven by client-side claims: storage, URL and window globals cannot add items', async () => {
    localStorage.setItem('role', 'COLLEGE_ADMIN');
    sessionStorage.setItem('capabilities', 'role.assignment.grant');
    (window as unknown as Record<string, unknown>)['__ROLE__'] = 'COLLEGE_ADMIN';
    await open(STUDENT, '/?role=COLLEGE_ADMIN&capabilities=role.assignment.grant');
    expect(navLinks()).toEqual(['Home', 'My profile']);
    localStorage.clear();
    sessionStorage.clear();
  });

  it('a student who types an admin URL gets the access-restricted page, not the admin page', async () => {
    await open(STUDENT, '/access');
    expect(screen.getByRole('heading', { name: 'Access restricted' })).toBeInTheDocument();
    expect(screen.queryByText('Not yet available')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Access restricted · Anesa'));
  });

  it('an administrator can open the admin placeholder, clearly labelled as not yet available', async () => {
    await open(ADMIN, '/access');
    expect(screen.getByRole('heading', { name: 'Roles & access' })).toBeInTheDocument();
    expect(screen.getByText('Not yet available')).toBeInTheDocument();
  });
});

describe('states and routes', () => {
  it('shows a custom not-found page inside the shell for unknown routes', async () => {
    await open(STUDENT, '/no/such/page');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    await waitFor(() => expect(document.title).toBe('Page not found · Anesa'));
  });

  it('shows no invented data: placeholders are labelled and contain no numbers', async () => {
    await open(STUDENT);
    const cards = screen.getAllByText('Not yet available');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('main').textContent).not.toMatch(/\d/);
  });

  it('renders untrusted text as text (hostile display name cannot inject markup)', async () => {
    await open({ ...STUDENT, display_name: '<img src=x onerror="window.__pwned=1">Eve' });
    expect(document.querySelector('main img')).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror=/).length).toBeGreaterThanOrEqual(1);
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  it('account page shows name and roles, and never internal identifiers', async () => {
    await open(STUDENT, '/account');
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveTextContent(/u1|t1/);
  });
});

describe('accessibility behaviour', () => {
  it('has a skip link, landmarks, a single h1 and a focus move to main on navigation', async () => {
    const user = userEvent.setup();
    await open(ADMIN);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await user.click(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Students',
      }),
    );
    expect(screen.getByRole('main')).toHaveFocus();
    expect(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Students',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('mobile menu button toggles aria-expanded, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    await open(STUDENT);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toHaveAttribute('data-open');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveAttribute('data-open');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toHaveAttribute('data-open');
  });

  it('account menu is keyboard operable and closes on Escape', async () => {
    const user = userEvent.setup();
    await open(STUDENT);
    const toggle = screen.getByRole('button', { name: /Asha Student/ });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(toggle).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('has no detectable axe violations: login, student shell, admin shell, not-found', async () => {
    const loginView = renderApp(createFakeBackend({ session: false }), '/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect((await axe(loginView.container)).violations).toEqual([]);
    loginView.unmount();

    for (const [me, path] of [
      [STUDENT, '/'],
      [ADMIN, '/'],
      [STUDENT, '/missing-page'],
    ] as const) {
      const v = renderApp(createFakeBackend({ session: true, me }), path);
      await screen.findByRole('navigation', { name: 'Primary' });
      expect((await axe(v.container)).violations).toEqual([]);
      v.unmount();
    }
  });
});
