import type { ScopeMode } from './catalog.js';

export type RoleCode =
  | 'STUDENT'
  | 'FACULTY'
  | 'STAFF'
  | 'HOD'
  | 'DEPARTMENT_ADMIN'
  | 'CAMPUS_ADMIN'
  | 'COLLEGE_ADMIN'
  | 'REGISTRAR';

export const ROLE_MATRIX: Record<RoleCode, Record<string, ScopeMode>> = {
  STUDENT: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'student.profile.read': 'SELF',
    'student.profile.read_sensitive': 'SELF',
    'student.profile.update': 'SELF',
    'attendance.session.read': 'SELF',
  },
  FACULTY: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'student.profile.read': 'ASSIGNED',
    'attendance.session.read': 'ASSIGNED',
    'attendance.session.mark': 'ASSIGNED',
  },
  STAFF: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
  },
  HOD: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'student.profile.read': 'GRANTED',
  },
  DEPARTMENT_ADMIN: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'student.profile.read': 'GRANTED',
  },
  CAMPUS_ADMIN: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'session.revoke_any': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.department.manage': 'GRANTED',
    'role.assignment.grant': 'GRANTED',
    'role.assignment.revoke': 'GRANTED',
  },
  COLLEGE_ADMIN: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'session.revoke_any': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.department.manage': 'GRANTED',
    'org.campus.manage': 'GRANTED',
    'org.settings.read': 'GRANTED',
    'role.assignment.grant': 'GRANTED',
    'role.assignment.revoke': 'GRANTED',
  },
  REGISTRAR: {
    'session.read': 'SELF',
    'session.revoke': 'SELF',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.department.manage': 'GRANTED',
    'org.settings.read': 'GRANTED',
  },
};
