import { can, type Identity } from '../auth/identity';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  /** Visible when the backend lists ANY of these capabilities (omitted = every signed-in user). */
  anyOf?: readonly string[];
  /** Restrict to students or to non-students where the wording differs. */
  audience?: 'student' | 'staff';
}

/**
 * The menu is computed from capabilities returned by the backend, never from role names typed in the
 * client. Hiding an item is a convenience; the backend still authorises every request.
 * Targets are placeholder pages that say "not yet available": no future module is implied to exist.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', to: '/' },
  {
    id: 'my-profile',
    label: 'My profile',
    to: '/profile',
    anyOf: ['student.profile.read'],
    audience: 'student',
  },
  {
    id: 'students',
    label: 'Students',
    to: '/students',
    anyOf: ['student.profile.read'],
    audience: 'staff',
  },
  {
    id: 'organisation',
    label: 'Organisation',
    to: '/organisation',
    anyOf: ['org.settings.read', 'org.campus.manage', 'org.department.manage'],
  },
  {
    id: 'access',
    label: 'Roles & access',
    to: '/access',
    anyOf: ['role.assignment.grant', 'role.assignment.revoke'],
  },
];

/** Route -> capabilities required to see the page (UX guard; the API enforces the real rule). */
export const ROUTE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  NAV_ITEMS.filter((i) => i.anyOf).map((i) => [i.to, i.anyOf as readonly string[]]),
);

export function visibleNav(identity: Identity): NavItem[] {
  const audience = identity.actorKind === 'STUDENT' ? 'student' : 'staff';
  return NAV_ITEMS.filter(
    (i) => (!i.audience || i.audience === audience) && (!i.anyOf || can(identity, ...i.anyOf)),
  );
}
