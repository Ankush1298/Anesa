import type { ScopeMode, ScopeType } from './catalog.js';

export const ROLE_CODES = [
  'STUDENT',
  'FACULTY',
  'STAFF',
  'HOD',
  'DEPARTMENT_ADMIN',
  'CAMPUS_ADMIN',
  'COLLEGE_ADMIN',
  'REGISTRAR',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

const SESSION: Record<string, ScopeMode> = { 'session.read': 'SELF', 'session.revoke': 'SELF' };

/** Mirrors docs/architecture/v3/10 §1 (a test parses the document and compares). */
export const ROLE_MATRIX: Record<RoleCode, Record<string, ScopeMode>> = {
  STUDENT: {
    ...SESSION,
    'org.structure.read': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'student.profile.read': 'SELF',
    'student.profile.read_sensitive': 'SELF',
  },
  // student.profile.read (ASSIGNED) is deliberately NOT seeded until the M3 resolver exists (doc 10 ¹).
  FACULTY: { ...SESSION, 'org.structure.read': 'GRANTED', 'academic.program.read': 'GRANTED' },
  STAFF: { ...SESSION, 'org.structure.read': 'GRANTED', 'academic.program.read': 'GRANTED' },
  HOD: {
    ...SESSION,
    'org.structure.read': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'student.profile.read': 'GRANTED',
  },
  DEPARTMENT_ADMIN: {
    ...SESSION,
    'org.structure.read': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'academic.program.manage': 'GRANTED',
    'academic.cohort.manage': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'role.assignment.grant': 'GRANTED',
    'role.assignment.revoke': 'GRANTED',
  },
  CAMPUS_ADMIN: {
    ...SESSION,
    'session.revoke_any': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.structure.read': 'GRANTED',
    'org.campus.manage': 'GRANTED',
    'org.department.manage': 'GRANTED',
    'org.settings.read': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'academic.program.manage': 'GRANTED',
    'academic.cohort.manage': 'GRANTED',
    'role.assignment.grant': 'GRANTED',
    'role.assignment.revoke': 'GRANTED',
  },
  COLLEGE_ADMIN: {
    ...SESSION,
    'session.revoke_any': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.structure.read': 'GRANTED',
    'org.campus.manage': 'GRANTED',
    'org.department.manage': 'GRANTED',
    'org.settings.read': 'GRANTED',
    'org.settings.manage': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'academic.program.manage': 'GRANTED',
    'academic.cohort.manage': 'GRANTED',
    'role.assignment.grant': 'GRANTED',
    'role.assignment.revoke': 'GRANTED',
  },
  REGISTRAR: {
    ...SESSION,
    'org.structure.read': 'GRANTED',
    'academic.program.read': 'GRANTED',
    'academic.program.manage': 'GRANTED',
    'academic.cohort.manage': 'GRANTED',
    'student.profile.read': 'GRANTED',
    'student.profile.read_sensitive': 'GRANTED',
    'org.settings.read': 'GRANTED',
  },
};

/** Which assignment scope types make sense for a role (06 §5(d): e.g. HOD requires DEPARTMENT). */
export const ROLE_SCOPE_TYPES: Record<RoleCode, readonly ScopeType[]> = {
  STUDENT: ['ORGANIZATION'],
  FACULTY: ['ORGANIZATION', 'CAMPUS', 'DEPARTMENT'],
  STAFF: ['ORGANIZATION', 'CAMPUS', 'DEPARTMENT'],
  HOD: ['DEPARTMENT'],
  DEPARTMENT_ADMIN: ['DEPARTMENT'],
  CAMPUS_ADMIN: ['CAMPUS'],
  COLLEGE_ADMIN: ['ORGANIZATION'],
  REGISTRAR: ['ORGANIZATION', 'CAMPUS'],
};

/** (grantor role → grantable roles), 06 §5. Nobody but COLLEGE_ADMIN may grant COLLEGE_ADMIN. */
export const GRANT_RULES: Record<string, readonly RoleCode[]> = {
  COLLEGE_ADMIN: ROLE_CODES,
  CAMPUS_ADMIN: ['DEPARTMENT_ADMIN', 'HOD', 'FACULTY', 'STAFF'],
  DEPARTMENT_ADMIN: ['FACULTY', 'STAFF'],
};

export function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}
