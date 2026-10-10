import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import {
  probeLocalDevDatabase,
  seedDevAdmin,
  verifyLocalDevDatabaseUrl,
} from '../../scripts/dev-seed-core.js';
import { verifyPassword } from '../../src/modules/auth/auth.repository.js';

const PW = ['pw', Math.random().toString(36).slice(2)].join('-'); // runtime-built: no secret-looking literal
const MARKER = `campusos-disposable:${'ab'.repeat(16)}`;

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

    it('successfully probes and reports server identity when allowTestDb and allowContainerTestDb are enabled', async () => {
      const probe = await probeLocalDevDatabase(client, {
        allowTestDb: true,
        allowContainerTestDb: true,
        disposableMarker: inject('dbDisposableMarker'),
      });
      expect(probe.database).toBeTruthy();
      expect(probe.user).toBeTruthy();
      expect(typeof probe.port).toBe('number');
    });

    it('refuses production or persistent database targets even when allowTestDb is true', async () => {
      const mock = (dbName: string) => ({
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: dbName,
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '127.0.0.1',
              },
            ],
          }),
      });

      for (const forbidden of [
        'campusos_dev',
        'campusos_prod',
        'production',
        'postgres',
        'template1',
      ]) {
        await expect(
          probeLocalDevDatabase(mock(forbidden), {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/is a protected persistent or production target/);
      }
    });

    it('refuses non-disposable test database names when allowTestDb is true', async () => {
      const mock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'unauthorized_db',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '127.0.0.1',
              },
            ],
          }),
      };

      await expect(
        probeLocalDevDatabase(mock, {
          allowTestDb: true,
          allowContainerTestDb: true,
          disposableMarker: MARKER,
        }),
      ).rejects.toThrow(/does not match disposable test database pattern/);
    });

    it('refuses when NODE_ENV is production even in test harness mode', async () => {
      const origEnv = process.env['NODE_ENV'];
      try {
        process.env['NODE_ENV'] = 'production';
        const mock = {
          query: () =>
            Promise.resolve({
              rows: [
                {
                  current_db: 'campusos_test_123456abcdef',
                  current_usr: 'postgres',
                  srv_port: 5432,
                  srv_host: '127.0.0.1',
                },
              ],
            }),
        };
        await expect(
          probeLocalDevDatabase(mock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/Refusing to seed: NODE_ENV is set to "production"/);
      } finally {
        process.env['NODE_ENV'] = origEnv;
      }
    });

    it('loopback test database succeeds with allowTestDb for local or socket servers', async () => {
      const socketMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: null,
              },
            ],
          }),
      };
      const resSocket = await probeLocalDevDatabase(socketMock, { allowTestDb: true });
      expect(resSocket.database).toBe('campusos_test_abcdef012345');
      expect(resSocket.hostAddr).toBeNull();

      const loopbackMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '127.0.0.1',
              },
            ],
          }),
      };
      const resLoopback = await probeLocalDevDatabase(loopbackMock, { allowTestDb: true });
      expect(resLoopback.database).toBe('campusos_test_abcdef012345');
      expect(resLoopback.hostAddr).toBe('127.0.0.1');
    });

    it('refuses an arbitrary non-loopback address by default', async () => {
      const containerMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '172.18.0.2',
                db_comment: MARKER,
              },
            ],
          }),
      };

      // Fails by default when allowContainerTestDb is not set
      await expect(probeLocalDevDatabase(containerMock, { allowTestDb: true })).rejects.toThrow(
        /test server reported non-local address "172.18.0.2"/,
      );

      // Fails when address is an arbitrary non-container IP even with allowContainerTestDb
      const publicMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '198.51.100.1',
                db_comment: MARKER,
              },
            ],
          }),
      };
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];
      try {
        process.env['TEST_DATABASE_URL'] = 'postgresql://postgres@127.0.0.1:5432/postgres';
        await expect(
          probeLocalDevDatabase(publicMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/not a recognized private container network/);
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it('intended CI/container database succeeds through the explicit, validated test-only path', async () => {
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];
      try {
        process.env['TEST_DATABASE_URL'] = 'postgresql://postgres@127.0.0.1:5432/postgres';
        const containerMock = {
          query: () =>
            Promise.resolve({
              rows: [
                {
                  current_db: 'campusos_test_abcdef012345',
                  current_usr: 'postgres',
                  srv_port: 5432,
                  srv_host: '172.18.0.2',
                  db_comment: MARKER,
                },
              ],
            }),
        };

        const probe = await probeLocalDevDatabase(containerMock, {
          allowTestDb: true,
          allowContainerTestDb: true,
          disposableMarker: MARKER,
        });
        expect(probe.database).toBe('campusos_test_abcdef012345');
        expect(probe.hostAddr).toBe('172.18.0.2');
        expect(probe.port).toBe(5432);
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it('container path accepts only 172.16.0.0/12 and only harness-shaped database names', async () => {
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];
      const mockOf = (db: string, host: string) => ({
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: db,
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: host,
                db_comment: MARKER,
              },
            ],
          }),
      });
      const opts = {
        allowTestDb: true,
        allowContainerTestDb: true,
        disposableMarker: MARKER,
      } as const;
      try {
        process.env['TEST_DATABASE_URL'] = 'postgresql://postgres@127.0.0.1:5432/postgres';
        // Other private ranges and the edges of 172.16/12 are refused.
        for (const host of [
          '10.0.0.5',
          '192.168.1.20',
          '172.15.0.2',
          '172.32.0.2',
          '172.18.0.256',
        ]) {
          await expect(
            probeLocalDevDatabase(mockOf('campusos_test_abcdef012345', host), opts),
            host,
          ).rejects.toThrow(/not a recognized private container network/);
        }
        for (const host of ['172.16.0.2', '172.31.255.254']) {
          const r = await probeLocalDevDatabase(mockOf('campusos_test_abcdef012345', host), opts);
          expect(r.hostAddr).toBe(host);
        }
        // Names the harness never generates are refused on the container path (wrong length, prefix, case).
        for (const db of [
          'campusos_test_abcdef',
          'campusos_test_ABCDEF012345',
          'my_db',
          'campusos_dev',
        ]) {
          await expect(probeLocalDevDatabase(mockOf(db, '172.18.0.2'), opts), db).rejects.toThrow(
            /Refusing to seed/,
          );
        }
        await expect(
          probeLocalDevDatabase(mockOf('campusos_mig_abcdef0123', '172.18.0.2'), opts),
        ).resolves.toMatchObject({ database: 'campusos_mig_abcdef0123' });
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it('container path requires the per-run marker stamped on the database (tunnel / look-alike / conflicting config)', async () => {
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];
      // Everything else looks perfect: harness-shaped name, 172.x address, loopback URL (e.g. a tunnel), same port.
      const mockOf = (comment: string | null | undefined) => ({
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '172.31.5.9',
                ...(comment === undefined ? {} : { db_comment: comment }),
              },
            ],
          }),
      });
      const base = { allowTestDb: true, allowContainerTestDb: true } as const;
      try {
        process.env['TEST_DATABASE_URL'] = `postgresql://postgres:${PW}@127.0.0.1:5432/postgres`;
        const refused = /does not carry this test run's disposable-database marker/;
        // a persistent / pre-existing look-alike database has no comment, or someone else's comment
        for (const comment of [
          null,
          undefined,
          '',
          'campusos-disposable:' + 'cd'.repeat(16),
          'prod db',
        ]) {
          await expect(
            probeLocalDevDatabase(mockOf(comment), { ...base, disposableMarker: MARKER }),
          ).rejects.toThrow(refused);
        }
        // the caller supplies no marker, an empty one, or a malformed one: fail closed even if the comment equals it
        for (const marker of [undefined, '', 'x', 'campusos-disposable:short']) {
          await expect(
            probeLocalDevDatabase(mockOf(marker ?? null), {
              ...base,
              ...(marker === undefined ? {} : { disposableMarker: marker }),
            }),
          ).rejects.toThrow(refused);
        }
        // the matching marker is accepted
        await expect(
          probeLocalDevDatabase(mockOf(MARKER), { ...base, disposableMarker: MARKER }),
        ).resolves.toMatchObject({ hostAddr: '172.31.5.9' });
        // neither the marker nor the URL password appears in the refusal
        try {
          await probeLocalDevDatabase(mockOf(null), { ...base, disposableMarker: MARKER });
        } catch (e) {
          const msg = (e as Error).message;
          expect(msg).not.toContain(MARKER);
          expect(msg).not.toContain(PW);
        }
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it("the harness really stamped the session database with this run's marker", async () => {
      const r = await client.query<{ c: string | null }>(
        `SELECT shobj_description(oid, 'pg_database') AS c FROM pg_database WHERE datname = current_database()`,
      );
      expect(r.rows[0]?.c).toBe(inject('dbDisposableMarker'));
      expect(inject('dbDisposableMarker')).toMatch(/^campusos-disposable:[0-9a-f]{32}$/);
    });

    it('fails closed on missing, malformed, or conflicting container safety configuration', async () => {
      const containerMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '172.18.0.2',
                db_comment: MARKER,
              },
            ],
          }),
      };
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];

      try {
        // Missing TEST_DATABASE_URL
        delete process.env['TEST_DATABASE_URL'];
        await expect(
          probeLocalDevDatabase(containerMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/requires TEST_DATABASE_URL configuration/);

        // Malformed TEST_DATABASE_URL
        process.env['TEST_DATABASE_URL'] = 'not-a-valid-url';
        await expect(
          probeLocalDevDatabase(containerMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/TEST_DATABASE_URL is not a valid URL/);

        // Remote host in TEST_DATABASE_URL
        process.env['TEST_DATABASE_URL'] =
          'postgresql://postgres@db.staging.internal:5432/postgres';
        await expect(
          probeLocalDevDatabase(containerMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/TEST_DATABASE_URL host "db.staging.internal" is not local/);

        // Conflicting port in TEST_DATABASE_URL (5433 vs server 5432)
        process.env['TEST_DATABASE_URL'] = 'postgresql://postgres@127.0.0.1:5433/postgres';
        await expect(
          probeLocalDevDatabase(containerMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          }),
        ).rejects.toThrow(/conflicts with TEST_DATABASE_URL port "5433"/);
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it('does not expose credentials in error messages or logs', async () => {
      const containerMock = {
        query: () =>
          Promise.resolve({
            rows: [
              {
                current_db: 'campusos_test_abcdef012345',
                current_usr: 'postgres',
                srv_port: 5432,
                srv_host: '172.18.0.2',
                db_comment: MARKER,
              },
            ],
          }),
      };
      const origTestDbUrl = process.env['TEST_DATABASE_URL'];

      try {
        process.env['TEST_DATABASE_URL'] =
          'postgresql://secret_user:super_secret_pw_123@db.remote.internal:5432/postgres'; // secret-scan:allow

        let errorMsg = '';
        try {
          await probeLocalDevDatabase(containerMock, {
            allowTestDb: true,
            allowContainerTestDb: true,
            disposableMarker: MARKER,
          });
        } catch (err) {
          errorMsg = (err as Error).message;
        }

        expect(errorMsg).toBeTruthy();
        expect(errorMsg).not.toContain('super_secret_pw_123');
        expect(errorMsg).not.toContain('secret_user');
      } finally {
        if (origTestDbUrl !== undefined) process.env['TEST_DATABASE_URL'] = origTestDbUrl;
        else delete process.env['TEST_DATABASE_URL'];
      }
    });

    it('fails closed when database query rejects and redacts credentials, URLs, and markers', async () => {
      const failingMock = {
        query: () =>
          Promise.reject(
            new Error(
              `query failed connecting to postgresql://admin:${PW}@db.remote.internal:5432/db with ${MARKER}`,
            ),
          ),
      };

      let errorMsg = '';
      try {
        await probeLocalDevDatabase(failingMock, {
          allowTestDb: true,
          allowContainerTestDb: true,
          disposableMarker: MARKER,
        });
      } catch (err) {
        errorMsg = (err as Error).message;
      }

      expect(errorMsg).toMatch(/Refusing to seed: database probe query failed/);
      expect(errorMsg).not.toContain(PW);
      expect(errorMsg).not.toContain(MARKER);
      expect(errorMsg).not.toContain('postgresql://');
    });

    it('fails closed when probe query returns zero rows', async () => {
      const emptyMock = {
        query: () => Promise.resolve({ rows: [] }),
      };

      await expect(
        probeLocalDevDatabase(emptyMock, {
          allowTestDb: true,
        }),
      ).rejects.toThrow(/failed to probe target PostgreSQL server identity/);
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
