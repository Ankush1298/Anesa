import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery } from '../support/db-harness.js';

// GET /auth/me is what the frontend renders menus from (ADR-014: navigation from server-computed
// capabilities). It must reflect the effective assignments of the AUTHENTICATED user only.
const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 2 });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db: new Database(pool),
  logger: false,
});
const EMAILS = [
  'user.a@college-a.test',
  'staff.a@college-a.test',
  'hod.a@college-a.test',
  'norole.a@college-a.test',
];

const me = async (email: string, remoteAddress: string) => {
  const l = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress,
  });
  const cookie = l.cookies.find((c) => c.name === 'session_token')!.value;
  return app.inject({ method: 'GET', url: '/auth/me', cookies: { session_token: cookie } });
};

beforeAll(async () => {
  await app.ready();
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [await argon2.hash(PASSWORD, { type: argon2.argon2id }), EMAILS],
  );
});
afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('GET /auth/me profile', () => {
  it('student: STUDENT role, SELF capabilities only, no admin capability, display name from the database', async () => {
    const r = await me('user.a@college-a.test', '10.20.0.1');
    expect(r.statusCode).toBe(200);
    const b = r.json<{
      actor_kind: string;
      display_name: string;
      roles: string[];
      capabilities: string[];
      csrf_token: string;
    }>();
    expect(b.actor_kind).toBe('STUDENT');
    expect(b.display_name).toBe('User A');
    expect(b.roles).toEqual(['STUDENT']);
    expect(b.capabilities).toEqual([
      'academic.program.read',
      'org.structure.read',
      'session.read',
      'session.revoke',
      'student.profile.read',
      'student.profile.read_sensitive',
    ]);
    expect(b.capabilities).not.toContain('role.assignment.grant');
    expect(b.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('college admin: administrative capabilities', async () => {
    const b = (await me('staff.a@college-a.test', '10.20.0.2')).json<{
      roles: string[];
      capabilities: string[];
    }>();
    expect(b.roles).toEqual(['COLLEGE_ADMIN']);
    expect(b.capabilities).toEqual(
      expect.arrayContaining(['role.assignment.grant', 'org.settings.read', 'org.campus.manage']),
    );
  });

  it('HOD: staff-level capability set, deterministic order', async () => {
    const b = (await me('hod.a@college-a.test', '10.20.0.3')).json<{
      roles: string[];
      capabilities: string[];
    }>();
    expect(b.roles).toEqual(['HOD']);
    expect(b.capabilities).toEqual([
      'academic.program.read',
      'employee.profile.read',
      'org.structure.read',
      'session.read',
      'session.revoke',
      'student.directory.search',
      'student.profile.read',
    ]);
  });

  it('a user with no effective assignment is refused (403), not given an empty profile', async () => {
    const r = await me('norole.a@college-a.test', '10.20.0.4');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('forged request data cannot change the profile', async () => {
    const l = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user.a@college-a.test', password: PASSWORD },
      remoteAddress: '10.20.0.5',
    });
    const cookie = l.cookies.find((c) => c.name === 'session_token')!.value;
    const r = await app.inject({
      method: 'GET',
      url: '/auth/me?roles=COLLEGE_ADMIN&capabilities=role.assignment.grant',
      cookies: { session_token: cookie },
      headers: { 'x-roles': 'COLLEGE_ADMIN' },
    });
    expect(r.json<{ roles: string[] }>().roles).toEqual(['STUDENT']);
  });
});
