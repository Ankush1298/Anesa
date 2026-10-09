import type { MeResponse } from '../../lib/api/schemas';

/** The verified identity as returned by the backend. Nothing here is ever derived on the client. */
export interface Identity {
  readonly displayName: string;
  readonly actorKind: 'STUDENT' | 'STAFF';
  readonly roles: readonly string[];
  readonly capabilities: ReadonlySet<string>;
}

export function toIdentity(me: MeResponse): Identity {
  return {
    displayName: me.display_name,
    actorKind: me.actor_kind,
    roles: me.roles,
    capabilities: new Set(me.capabilities),
  };
}

export function can(identity: Identity, ...anyOf: readonly string[]): boolean {
  return anyOf.some((c) => identity.capabilities.has(c));
}

/** Capabilities that mean "this person administers part of the organisation" (landing shell only). */
const ADMIN_CAPABILITIES = [
  'role.assignment.grant',
  'org.settings.read',
  'org.campus.manage',
  'org.department.manage',
  'session.revoke_any',
] as const;

export type ShellKind = 'student' | 'staff' | 'admin';

/** Which landing shell to show. A UX choice only: every action is authorised by the backend. */
export function shellKind(identity: Identity): ShellKind {
  if (identity.actorKind === 'STUDENT') return 'student';
  return can(identity, ...ADMIN_CAPABILITIES) ? 'admin' : 'staff';
}

const ROLE_LABELS: Record<string, string> = {
  STUDENT: 'Student',
  FACULTY: 'Faculty',
  STAFF: 'Staff',
  HOD: 'Head of department',
  DEPARTMENT_ADMIN: 'Department administrator',
  CAMPUS_ADMIN: 'Campus administrator',
  COLLEGE_ADMIN: 'College administrator',
  REGISTRAR: 'Registrar',
};

export function roleLabel(code: string): string {
  return ROLE_LABELS[code] ?? code;
}
