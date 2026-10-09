import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import {
  probeLocalDevDatabase,
  seedDevAdmin,
  verifyLocalDevDatabaseUrl,
} from '../../scripts/dev-seed-core.js';
import { verifyPassword } from '../../src/modules/auth/auth.repository.js';

describe('Development seed utility (safe local admin provisioning)', () => {
  const adminUrl = inject('dbAdminUrl');
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  describe('URL validation and safety boundaries', () => {
    it('refuses to run when NODE_ENV is production', () => {
      const origEnv = process.env['NODE_ENV'];
      try {
        process.env['NODE_ENV'] = 'production';
        expect(() =>
          verifyLocalDevDatabaseUrl(
            'postgresql://campusos_admin:change_me@127.0.0.1:54329/campusos_dev',
          ),
        ).toThrow(/Refusing to seed: NODE_ENV is set to "production"/);
      } finally {
        process.env['NODE_ENV'] = origEnv;
      }
    });

    it('refuses to run when DATABASE_ADMIN_URL is missing or invalid', () => {
      expect(() => verifyLocalDevDatabaseUrl(undefined)).toThrow(/DATABASE_ADMIN_URL is not set/);
      expect(() => verifyLocalDevDatabaseUrl('not-a-valid-url')).toThrow(
        /DATABASE_ADMIN_URL is not a valid URL/,
      );
    });

    it('refuses non-local database hosts (prevents connecting to remote / RDS)', () => {
      expect(() =>
        verifyLocalDevDatabaseUrl(
          'postgresql://admin:change_me@db.staging.internal:54329/campusos_dev',
        ),
      ).toThrow(/target host "db.staging.internal" is not local/);

      expect(() =>
        verifyLocalDevDatabaseUrl('postgresql://admin:change_me@192.168.1.50:54329/campusos_dev'),
      ).toThrow(/target host "192.168.1.50" is not local/);
    });

    it('refuses ports other than 54329 in standard dev mode', () => {
      expect(() =>
        verifyLocalDevDatabaseUrl('postgresql://admin:change_me@127.0.0.1:5432/campusos_dev'),
      ).toThrow(/target port "5432" does not match local development port "54329"/);
    });

    it('refuses databases other than campusos_dev in standard dev mode', () => {
      expect(() =>
        verifyLocalDevDatabaseUrl('postgresql://admin:change_me@127.0.0.1:54329/production_db'),
      ).toThrow(
        /target database "production_db" does not match development database "campusos_dev"/,
      );
    });

    it('accepts valid 127.0.0.1:54329/campusos_dev URL', () => {
      const url = verifyLocalDevDatabaseUrl(
        'postgresql://campusos_admin:change_me@127.0.0.1:54329/campusos_dev',
      );
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.port).toBe('54329');
      expect(url.pathname).toBe('/campusos_dev');
    });
  });

  describe('In-session database identity probing', () => {
    it('refuses a database whose active name is not campusos_dev in strict mode', async () => {
      await expect(probeLocalDevDatabase(client, { allowTestDb: false })).rejects.toThrow(
        /expected "campusos_dev"/,
      );
    });

    it('successfully probes and reports server identity when allowTestDb is true', async () => {
      const probe = await probeLocalDevDatabase(client, { allowTestDb: true });
      expect(probe.database).toBeTruthy();
      expect(probe.user).toBeTruthy();
      expect(typeof probe.port).toBe('number');
    });
  });

  describe('seedDevAdmin provisioning and idempotency', () => {
    const testPassword = 'dev-admin-secure-password'; // secret-scan:allow

    it('rejects passwords shorter than 8 characters', async () => {
      await expect(
        seedDevAdmin(client, {
          passwordPlain: 'short', // secret-scan:allow
          orgSlug: 'test-seed-org',
        }),
      ).rejects.toThrow(/Password must be at least 8 characters long/);
    });

    it('provisions organization, roles, identity, user, and COLLEGE_ADMIN role assignment', async () => {
      const result = await seedDevAdmin(client, {
        passwordPlain: testPassword,
        orgSlug: 'dev-campus-test',
        orgName: 'Dev Campus Test',
        email: 'test-admin@dev.local',
        displayName: 'Test Dev Admin',
      });

      expect(result.organizationSlug).toBe('dev-campus-test');
      expect(result.organizationName).toBe('Dev Campus Test');
      expect(result.email).toBe('test-admin@dev.local');
      expect(result.roleCode).toBe('COLLEGE_ADMIN');

      // Verify organization was created
      const orgRow = await client.query(
        'SELECT name, status FROM app.organizations WHERE id = $1',
        [result.organizationId],
      );
      expect(orgRow.rows[0]).toEqual({ name: 'Dev Campus Test', status: 'ACTIVE' });

      // Verify tenant roles were seeded
      const roles = await client.query<{ code: string }>(
        'SELECT code FROM app.roles WHERE organization_id = $1 ORDER BY code',
        [result.organizationId],
      );
      expect(roles.rows.map((r) => r.code)).toContain('COLLEGE_ADMIN');

      // Verify identity credentials
      const identRow = await client.query<{ password_hash: string; status: string }>(
        'SELECT password_hash, status FROM platform.identities WHERE id = $1',
        [result.identityId],
      );
      expect(identRow.rows[0]?.status).toBe('ACTIVE');
      const hash = identRow.rows[0]?.password_hash ?? '';
      expect(await verifyPassword(hash, testPassword)).toBe(true);

      // Verify user table row directly
      const userRows = await client.query<{
        organization_id: string;
        id: string;
        status: string;
        identity_id: string;
      }>('SELECT organization_id, id, status, identity_id FROM app.users WHERE id = $1', [
        result.userId,
      ]);
      expect(userRows.rows[0]).toEqual({
        organization_id: result.organizationId,
        id: result.userId,
        status: 'ACTIVE',
        identity_id: result.identityId,
      });

      // Verify membership resolution for login via app_runtime (which exercises the SECURITY DEFINER policy)
      const runtimeClient = new pg.Client({ connectionString: inject('dbRuntimeUrl') });
      await runtimeClient.connect();
      try {
        const memberships = await runtimeClient.query<{
          organization_id: string;
          user_id: string;
          status: string;
          org_slug: string;
        }>(
          'SELECT organization_id, user_id, status, org_slug FROM platform.get_identity_memberships($1)',
          [result.identityId],
        );
        expect(memberships.rows).toHaveLength(1);
        expect(memberships.rows[0]).toEqual({
          organization_id: result.organizationId,
          user_id: result.userId,
          status: 'ACTIVE',
          org_slug: 'dev-campus-test',
        });
      } finally {
        await runtimeClient.end();
      }

      // Verify role assignment is active and organization-scoped
      const assignment = await client.query<{
        status: string;
        scope_type: string;
        scope_id: string | null;
      }>('SELECT status, scope_type, scope_id FROM app.role_assignments WHERE id = $1', [
        result.roleAssignmentId,
      ]);
      expect(assignment.rows[0]).toEqual({
        status: 'ACTIVE',
        scope_type: 'ORGANIZATION',
        scope_id: null,
      });

      // Verify student table was NOT touched (confirming staff actor kind)
      const student = await client.query('SELECT 1 FROM app.students WHERE user_id = $1', [
        result.userId,
      ]);
      expect(student.rowCount).toBe(0);
    });

    it('is fully idempotent: updates password on re-run without duplicating records', async () => {
      const newPassword = 'updated-admin-secure-password'; // secret-scan:allow

      const result1 = await seedDevAdmin(client, {
        passwordPlain: testPassword,
        orgSlug: 'dev-campus-test',
        orgName: 'Dev Campus Test',
        email: 'test-admin@dev.local',
      });

      const result2 = await seedDevAdmin(client, {
        passwordPlain: newPassword,
        orgSlug: 'dev-campus-test',
        orgName: 'Dev Campus Test',
        email: 'test-admin@dev.local',
      });

      // Same IDs reused
      expect(result2.organizationId).toBe(result1.organizationId);
      expect(result2.identityId).toBe(result1.identityId);
      expect(result2.userId).toBe(result1.userId);
      expect(result2.roleAssignmentId).toBe(result1.roleAssignmentId);

      // Identity updated to new password
      const identRow = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM platform.identities WHERE id = $1',
        [result2.identityId],
      );
      const hash = identRow.rows[0]?.password_hash ?? '';
      expect(await verifyPassword(hash, newPassword)).toBe(true);
      expect(await verifyPassword(hash, testPassword)).toBe(false);

      // Exactly 1 user and 1 role assignment remain
      const userCount = await client.query<{ count: number }>(
        'SELECT count(*)::int as count FROM app.users WHERE organization_id = $1 AND email = $2',
        [result2.organizationId, 'test-admin@dev.local'],
      );
      expect(userCount.rows[0]?.count).toBe(1);

      const assignCount = await client.query<{ count: number }>(
        'SELECT count(*)::int as count FROM app.role_assignments WHERE organization_id = $1 AND user_id = $2',
        [result2.organizationId, result2.userId],
      );
      expect(assignCount.rows[0]?.count).toBe(1);
    });
  });
});
