import { Route, Routes } from 'react-router';
import { LoginPage } from './features/auth/LoginPage';
import { RequireAuth, RequireCapability } from './features/auth/guards';
import { HomePage } from './features/home/Homes';
import { AppShell } from './features/shell/AppShell';
import { InformationalShell } from './features/shell/InformationalShell';
import { ROUTE_REQUIREMENTS } from './features/shell/navigation';
import { AccountPage } from './pages/AccountPage';
import { ComingSoonPage } from './pages/ComingSoon';
import { NotFoundPage } from './pages/StatePages';
import {
  AboutPage,
  AccessibilityPage,
  ContactPage,
  CookiesPage,
  FaqPage,
  HelpPage,
  PrivacyPage,
  TermsPage,
} from './pages/info';

function Guarded({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}) {
  return (
    <RequireCapability anyOf={ROUTE_REQUIREMENTS[path] ?? []}>
      <ComingSoonPage title={title} description={description} />
    </RequireCapability>
  );
}

/** Router must be provided by the caller (BrowserRouter in main.tsx, MemoryRouter in tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<InformationalShell />}>
        <Route path="about" element={<AboutPage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="cookies" element={<CookiesPage />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="contact" element={<ContactPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="account" element={<AccountPage />} />
          <Route
            path="profile"
            element={
              <Guarded
                path="/profile"
                title="My profile"
                description="Your student profile will be shown here."
              />
            }
          />
          <Route
            path="students"
            element={
              <Guarded
                path="/students"
                title="Students"
                description="Student records you are allowed to see will be listed here."
              />
            }
          />
          <Route
            path="organisation"
            element={
              <Guarded
                path="/organisation"
                title="Organisation"
                description="Campuses, departments and settings will be managed here."
              />
            }
          />
          <Route
            path="access"
            element={
              <Guarded
                path="/access"
                title="Roles & access"
                description="Role assignments will be managed here."
              />
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
