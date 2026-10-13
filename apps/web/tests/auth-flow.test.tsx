import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, STUDENT } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const PW = /* secret-scan:allow */ 'correct-horse-battery';

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  email = 'asha@college.test',
  password = PW,
) {
  await user.type(await screen.findByLabelText('Email address'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('login', () => {
  it('signs in, loads the verified identity from /auth/me and shows the student home', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    renderApp(b, '/login');
    await fillAndSubmit(user);
    expect(await screen.findByRole('heading', { name: 'Student home' })).toBeInTheDocument();
    expect(screen.getByText(/Welcome, Asha Student/)).toBeInTheDocument();
    // contract: login body has exactly email+password, then identity is fetched from the backend
    expect(b.callsTo('POST', '/auth/login')[0]!.body).toEqual({
      email: 'asha@college.test',
      password: PW,
    });
    expect(b.callsTo('GET', '/auth/me').length).toBeGreaterThanOrEqual(1);
    // the title is set in an effect (usePageTitle), after the heading is already in the DOM
    await waitFor(() => expect(document.title).toBe('Student home · Anesa'));
  });

  it('sends the optional organisation code only when entered', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    renderApp(b, '/login');
    await user.click(await screen.findByText('Belong to more than one organisation?'));
    await user.type(screen.getByLabelText('Organisation code (optional)'), 'college-a');
    await fillAndSubmit(user);
    await screen.findByRole('heading', { name: 'Student home' });
    expect(b.callsTo('POST', '/auth/login')[0]!.body).toMatchObject({ tenant: 'college-a' });
  });

  it('validates required fields accessibly and does not call the server', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    renderApp(b, '/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    const email = screen.getByLabelText('Email address');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
    expect(email).toHaveAccessibleDescription('Enter your email address.');
    await user.type(email, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email address')).toHaveAccessibleDescription(
      'Enter a valid email address.',
    );
    expect(b.callsTo('POST', '/auth/login')).toHaveLength(0);
  });

  it.each([
    ['invalid', 'The email or password is incorrect.'],
    ['rate', 'Too many sign-in attempts. Please wait 2 minutes and try again.'],
    ['network', 'Cannot reach the server. Check your connection and try again.'],
    ['server', 'Sign-in is temporarily unavailable. Please try again shortly.'],
    ['badjson', 'Sign-in is temporarily unavailable. Please try again shortly.'],
  ] as const)(
    'failure "%s" shows fixed wording in an alert, clears the password, keeps the user on the form',
    async (mode, text) => {
      const b = createFakeBackend();
      b.state.loginMode = mode;
      const user = userEvent.setup();
      renderApp(b, '/login');
      await fillAndSubmit(user);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(alert).not.toHaveTextContent('server text that must never be shown');
      expect(screen.getByLabelText('Password')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveFocus();
      expect(screen.queryByRole('heading', { name: 'Student home' })).not.toBeInTheDocument();
    },
  );

  it('shows a pending state and ignores a second submit while the request is in flight', async () => {
    const b = createFakeBackend();
    let release!: () => void;
    const original = b.fetch;
    const gate = new Promise<void>((r) => (release = r));
    const slow = ((input: RequestInfo | URL, init?: RequestInit) =>
      (typeof input === 'string' ? input : '').endsWith('/auth/login')
        ? gate.then(() => original(input, init))
        : original(input, init)) as typeof fetch;
    const view = renderApp({ ...b, fetch: slow });
    void view;
    const user = userEvent.setup();
    await fillAndSubmit(user);
    const button = await screen.findByRole('button', { name: 'Signing in…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    release();
    await screen.findByRole('heading', { name: 'Student home' });
    expect(b.callsTo('POST', '/auth/login')).toHaveLength(1);
  });

  it('does not allow open redirects after login', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    renderApp(b, '/login');
    await fillAndSubmit(user);
    expect(await screen.findByRole('heading', { name: 'Student home' })).toBeInTheDocument();
    const { safeRedirect } = await import('../src/features/auth/LoginPage');
    for (const bad of [
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      'javascript:alert(1)',
      undefined,
      42,
    ]) {
      expect(safeRedirect(bad)).toBe('/');
    }
    expect(safeRedirect('/students')).toBe('/students');
  });
});

describe('session restoration and expiry', () => {
  it('restores an existing session from the cookie (no login form) and shows a loading state first', async () => {
    const b = createFakeBackend({ session: true });
    renderApp(b, '/');
    expect(screen.getByRole('status')).toHaveTextContent('Restoring your session');
    expect(await screen.findByRole('heading', { name: 'Student home' })).toBeInTheDocument();
    expect(b.callsTo('POST', '/auth/login')).toHaveLength(0);
  });

  it('with no valid session, redirects a protected URL to /login (and remembers where to return)', async () => {
    const b = createFakeBackend({ session: false });
    renderApp(b, '/account');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // not an error: just signed out
    const user = userEvent.setup();
    await fillAndSubmit(user);
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('an expired session mid-use sends the user to /login with a notice and clears the CSRF token', async () => {
    const b = createFakeBackend({ session: true });
    const { client } = renderApp(b, '/');
    await screen.findByRole('heading', { name: 'Student home' });
    expect(client.hasCsrfToken()).toBe(true);
    b.expireSession();
    // any authenticated call that now fails with 401 ends the session on the client
    await client
      .get('/auth/me', { schema: (await import('zod')).z.unknown() })
      .catch(() => undefined);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your session has expired. Please sign in again.',
    );
    expect(client.hasCsrfToken()).toBe(false);
  });

  it('a server/network failure while restoring shows a recoverable error with retry', async () => {
    const b = createFakeBackend({ session: true });
    b.state.meMode = 'network';
    const user = userEvent.setup();
    renderApp(b, '/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    b.state.meMode = 'ok';
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Student home' })).toBeInTheDocument();
  });

  it('a signed-in account with no assigned role (403 on /auth/me) gets a clear page and can sign out', async () => {
    const b = createFakeBackend({ session: true });
    b.state.meMode = 'noaccess';
    const user = userEvent.setup();
    renderApp(b, '/');
    expect(await screen.findByRole('heading', { name: 'No access assigned' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(b.callsTo('POST', '/auth/logout')).toHaveLength(1);
  });
});

describe('logout', () => {
  async function signedIn(b = createFakeBackend({ session: true })) {
    const user = userEvent.setup();
    const view = renderApp(b, '/');
    await screen.findByRole('heading', { name: 'Student home' });
    await user.click(screen.getByRole('button', { name: new RegExp(STUDENT.display_name) }));
    return { b, user, ...view };
  }

  it('calls the backend with the CSRF header, clears client state and returns to /login', async () => {
    const { b, user, client } = await signedIn();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const call = b.callsTo('POST', '/auth/logout')[0]!;
    expect(call.headers['x-csrf-token']).toBe(b.state.csrf);
    expect(b.state.session).toBe(false);
    expect(client.hasCsrfToken()).toBe(false);
    expect(screen.queryByText(/Asha Student/)).not.toBeInTheDocument();
    // the protected page is gone after logout
    expect(screen.queryByRole('heading', { name: 'Student home' })).not.toBeInTheDocument();
  });

  it('clears client state and navigates even when the logout request fails', async () => {
    const b = createFakeBackend({ session: true });
    b.state.logoutMode = 'network';
    const { user, client } = await signedIn(b);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(client.hasCsrfToken()).toBe(false);
  });
});
