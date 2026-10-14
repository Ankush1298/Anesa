export type Sensitivity = 'NORMAL' | 'SENSITIVE' | 'CRITICAL';

/**
 * How a permission is evaluated for a role (docs/architecture/v3/06 §1, 14-authorization-scopes):
 *  SELF     the resource belongs to the actor (student mapping / user id resolved server-side).
 *  ASSIGNED a registered resolver proves a real actor→resource relationship; none registered = deny.
 *  GRANTED  the resource lies inside the scope of the *role assignment* (ORGANIZATION, CAMPUS or
 *           DEPARTMENT). The mode itself widens nothing; the assignment's scope does the bounding.
 */
export type ScopeMode = 'SELF' | 'ASSIGNED' | 'GRANTED';
export const SCOPE_MODES: readonly ScopeMode[] = ['SELF', 'ASSIGNED', 'GRANTED'];

export type ScopeType = 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
export const SCOPE_TYPES: readonly ScopeType[] = ['ORGANIZATION', 'CAMPUS', 'DEPARTMENT'];

export interface PermissionDef {
  code: string;
  sensitivity: Sensitivity;
}

/**
 * The Milestone-1 permissions that Slice 3 needs (subset of docs/architecture/v3/10; a test keeps
 * code ≡ doc). Reserved namespaces (attendance.*, …) are added by the milestone that ships their routes.
 */
export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  { code: 'session.read', sensitivity: 'NORMAL' },
  { code: 'session.revoke', sensitivity: 'NORMAL' },
  { code: 'session.revoke_any', sensitivity: 'SENSITIVE' },

  { code: 'student.profile.read', sensitivity: 'SENSITIVE' },
  { code: 'student.profile.read_sensitive', sensitivity: 'SENSITIVE' },
  { code: 'student.record.create', sensitivity: 'SENSITIVE' },
  { code: 'student.program.assign', sensitivity: 'SENSITIVE' },
  { code: 'student.directory.search', sensitivity: 'SENSITIVE' },

  { code: 'org.structure.read', sensitivity: 'NORMAL' },
  { code: 'org.campus.manage', sensitivity: 'SENSITIVE' },
  { code: 'org.department.manage', sensitivity: 'SENSITIVE' },
  { code: 'org.settings.read', sensitivity: 'NORMAL' },
  { code: 'org.settings.manage', sensitivity: 'CRITICAL' },

  { code: 'academic.program.read', sensitivity: 'NORMAL' },
  { code: 'academic.program.manage', sensitivity: 'SENSITIVE' },
  { code: 'academic.cohort.manage', sensitivity: 'SENSITIVE' },

  { code: 'employee.profile.read', sensitivity: 'NORMAL' },
  { code: 'employee.record.create', sensitivity: 'SENSITIVE' },
  { code: 'employee.record.update', sensitivity: 'SENSITIVE' },

  { code: 'role.assignment.grant', sensitivity: 'CRITICAL' },
  { code: 'role.assignment.revoke', sensitivity: 'CRITICAL' },
];

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((p) => p.code));
