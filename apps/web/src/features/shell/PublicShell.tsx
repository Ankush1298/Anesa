import { Link, Outlet } from 'react-router';
import { Logo } from '../../components/Logo';
import { Footer } from '../../components/Footer';

export function PublicShell() {
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="public-topbar">
        <Link to="/" className="public-brand" aria-label="Anesa Home">
          <Logo />
        </Link>
        <Link to="/login" className="btn btn-secondary">
          Sign in
        </Link>
      </header>
      <main id="main" className="content public-content" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
