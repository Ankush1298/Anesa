import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { Logo } from '../../components/Logo';
import { Footer } from '../../components/Footer';
import { useAuth } from '../auth/AuthProvider';
import { roleLabel } from '../auth/identity';
import { visibleNav } from './navigation';

function AccountMenu() {
  const { identity, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onClick = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  if (!identity) return null;

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout(); // always clears local state, even if the request fails
    } finally {
      void navigate('/login', { replace: true });
    }
  }

  return (
    <div className="account" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="account-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {identity.displayName.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="account-name">{identity.displayName || 'Account'}</span>
      </button>
      {open ? (
        <div id={panelId} className="account-panel">
          <p className="account-roles">{identity.roles.map(roleLabel).join(', ') || 'No role'}</p>
          <NavLink to="/account" onClick={() => setOpen(false)}>
            Account
          </NavLink>
          <Button variant="secondary" pending={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell() {
  const { identity } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const navId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Close the mobile drawer on navigation and move focus to the new page content.
  useEffect(() => {
    setNavOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (!identity) return null;
  const items = visibleNav(identity);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <button
          ref={menuButton}
          type="button"
          className="menu-toggle"
          aria-expanded={navOpen}
          aria-controls={navId}
          onClick={() => setNavOpen((v) => !v)}
        >
          <span className="sr-only">{navOpen ? 'Close menu' : 'Open menu'}</span>
          <span className="menu-icon" aria-hidden="true" />
        </button>
        <Logo />
        <AccountMenu />
      </header>
      <nav id={navId} className="sidenav" aria-label="Primary" data-open={navOpen || undefined}>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <NavLink to={item.to} end={item.to === '/'}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {navOpen ? (
        <div className="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      ) : null}
      <div className="shell-main">
        <main id="main" ref={main} tabIndex={-1} className="content">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
