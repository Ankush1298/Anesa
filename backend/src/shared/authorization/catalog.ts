export type Sensitivity = 'NORMAL' | 'SENSITIVE' | 'CRITICAL';
export type ScopeMode = 'SELF' | 'ASSIGNED' | 'GRANTED';

export interface PermissionDef {
  code: string;
  sensitivity: Sensitivity;
}

export const PERMISSION_CATALOG: PermissionDef[] = [
  { code: 'session.read', sensitivity: 'NORMAL' },
  { code: 'session.revoke', sensitivity: 'NORMAL' },
  { code: 'session.revoke_any', sensitivity: 'SENSITIVE' },

  { code: 'student.profile.read', sensitivity: 'SENSITIVE' },
  { code: 'student.profile.read_sensitive', sensitivity: 'SENSITIVE' },
  { code: 'student.profile.update', sensitivity: 'SENSITIVE' },

  { code: 'attendance.session.read', sensitivity: 'NORMAL' },
  { code: 'attendance.session.mark', sensitivity: 'SENSITIVE' },

  { code: 'org.department.manage', sensitivity: 'SENSITIVE' },
  { code: 'org.campus.manage', sensitivity: 'SENSITIVE' },
  { code: 'org.settings.read', sensitivity: 'NORMAL' },
  { code: 'role.assignment.grant', sensitivity: 'CRITICAL' },
  { code: 'role.assignment.revoke', sensitivity: 'CRITICAL' },
];
