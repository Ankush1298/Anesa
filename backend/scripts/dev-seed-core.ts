/**
 * Core implementation for the local development seed utility.
 * Safe, idempotent provisioning of a single local College Admin account.
 * NEVER connects to remote or production databases.
 */
import type pg from 'pg';
import * as argon2 from 'argon2';
import { uuidv7 } from '../src/shared/ids/uuidv7.js';
import { seedTenantRoles } from '../src/shared/authorization/seed.js';

export interface DevSeedTargetOptions {
  /** Test harness only: allows throw-away test database names and ports */
  allowTestDb?: boolean;
  expectedDbName?: string;
  expectedPort?: number;
  /** Test harness only: explicitly authorizes disposable container test database when validated */
  allowContainerTestDb?: boolean;
  /**
   * Container path only. The per-run marker the test harness stamped on the database it created
   * (`COMMENT ON DATABASE`, tests/support/global-db.ts). The probe requires the session's database to carry
   * exactly this comment. A pre-existing or persistent database, even one with a look-alike name on a 172.x
   * address, does not have it. LIMIT: this proves the harness created the database in this run; it cannot prove the
   * server TEST_DATABASE_URL points at is itself disposable (whoever sets that superuser URL already authorizes the
   * harness to create and drop databases there).
   */
  disposableMarker?: string;
}

export const FORBIDDEN_TEST_DB_NAMES = [
  'campusos_dev',
  'campusos_prod',
  'production',
  'prod',
  'staging',
  'postgres',
  'template0',
  'template1',
];

// Exactly the names the test harness generates (tests/support/global-db.ts: 6 random bytes; fresh-db.ts: 5 bytes).
export const DISPOSABLE_TEST_DB_PATTERN = /^campusos_(?:test_[0-9a-f]{12}|mig_[0-9a-f]{10})$/;

/**
 * True only for 172.16.0.0/12, the range Docker bridge networks (and the GitHub Actions service container) use.
 * This is NOT trust on its own: it is one of several conditions of the explicit container test path in
 * probeLocalDevDatabase. 10.0.0.0/8 and 192.168.0.0/16 are deliberately not accepted (not needed by CI; they are
 * common LAN/VPC ranges where a real remote database could live).
 */
export function isPrivateContainerIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const octets = ip.split('.').map(Number);
  if (octets.some((o) => o > 255)) return false;
  const second = octets[1] as number;
  return second >= 16 && second <= 31;
}

export interface DevSeedProbeClient {
  query: (
    queryText: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: readonly Record<string, unknown>[] }>;
}

export interface DevAdminSeedOptions {
  passwordPlain: string;
  orgSlug?: string;
  orgName?: string;
  email?: string;
  displayName?: string;
}

export interface DevAdminSeedResult {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  identityId: string;
  userId: string;
  email: string;
  roleCode: string;
  roleAssignmentId: string;
}

/**
 * Validates the database URL before any network connection is attempted.
 * Positively identifies local development targets and rejects all others.
 */
export function verifyLocalDevDatabaseUrl(
  adminUrlString: string | undefined,
  options: DevSeedTargetOptions = {},
): URL {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is set to "production".');
  }

  if (!adminUrlString) {
    throw new Error('Refusing to seed: DATABASE_ADMIN_URL is not set.');
  }

  let parsed: URL;
  try {
    parsed = new URL(adminUrlString);
  } catch {
    throw new Error('Refusing to seed: DATABASE_ADMIN_URL is not a valid URL.');
  }

  const allowedHosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new Error(
      `Refusing to seed: target host "${parsed.hostname}" is not local (must be 127.0.0.1 or localhost).`,
    );
  }

  const expectedPort = options.expectedPort ?? 54329;
  const expectedDbName = options.expectedDbName ?? 'campusos_dev';

  if (!options.allowTestDb) {
    const targetPort = Number(parsed.port || 5432);
    if (targetPort !== expectedPort) {
      throw new Error(
        `Refusing to seed: target port "${targetPort}" does not match local development port "${expectedPort}".`,
      );
    }

    const targetDbName = decodeURIComponent(parsed.pathname.slice(1));
    if (targetDbName !== expectedDbName) {
      throw new Error(
        `Refusing to seed: target database "${targetDbName}" does not match development database "${expectedDbName}".`,
      );
    }
  } else {
    const targetDbName = decodeURIComponent(parsed.pathname.slice(1));
    if (FORBIDDEN_TEST_DB_NAMES.includes(targetDbName.toLowerCase())) {
      throw new Error(
        `Refusing to seed: target database "${targetDbName}" is a protected persistent or production target.`,
      );
    }
  }

  return parsed;
}

/**
 * Probes the connected PostgreSQL session to verify server-side attributes.
 * Aborts if the target server identity does not match the local development database
 * or an explicitly authorized, validated disposable test container.
 */
export async function probeLocalDevDatabase(
  client: DevSeedProbeClient,
  options: DevSeedTargetOptions = {},
): Promise<{ database: string; user: string; port: number; hostAddr: string | null }> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is set to "production".');
  }

  let res: {
    rows: {
      current_db: string;
      current_usr: string;
      srv_port: number;
      srv_host: string | null;
      db_comment?: string | null;
    }[];
  };
  try {
    res = (await client.query(`
      SELECT current_database() AS current_db,
             current_user AS current_usr,
             inet_server_port() AS srv_port,
             host(inet_server_addr()) AS srv_host,
             (SELECT shobj_description(d.oid, 'pg_database') FROM pg_database d
               WHERE d.datname = current_database()) AS db_comment;
    `)) as unknown as typeof res;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = rawMsg
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_URL]')
      .replace(/:[^:@\s]+@/g, ':[REDACTED_PASSWORD]@');
    const finalMsg = options.disposableMarker
      ? sanitized.replaceAll(options.disposableMarker, '[REDACTED_MARKER]')
      : sanitized;
    // eslint-disable-next-line preserve-caught-error -- attaching the raw cause would re-expose the connection string / password this block just redacted
    throw new Error(`Refusing to seed: database probe query failed: ${finalMsg}`);
  }

  const row = res.rows?.[0];
  if (!row) {
    throw new Error('Refusing to seed: failed to probe target PostgreSQL server identity.');
  }

  const expectedDbName = options.expectedDbName ?? 'campusos_dev';
  const expectedPort = options.expectedPort ?? 54329;

  if (!options.allowTestDb) {
    if (row.current_db !== expectedDbName) {
      throw new Error(
        `Refusing to seed: active database is "${row.current_db}", expected "${expectedDbName}".`,
      );
    }

    if (row.srv_port !== expectedPort) {
      throw new Error(
        `Refusing to seed: active server port is "${row.srv_port}", expected "${expectedPort}".`,
      );
    }

    // Server-side IP address must strictly match loopback
    if (row.srv_host !== '127.0.0.1' && row.srv_host !== '::1') {
      throw new Error(
        `Refusing to seed: server reported address "${row.srv_host}", expected "127.0.0.1".`,
      );
    }
  } else {
    // In test harness mode: verify target is not a protected persistent or production database
    const dbLower = row.current_db.toLowerCase();
    if (FORBIDDEN_TEST_DB_NAMES.includes(dbLower)) {
      throw new Error(
        `Refusing to seed: active database "${row.current_db}" is a protected persistent or production target.`,
      );
    }

    const isAuthorizedTestDb = options.expectedDbName
      ? row.current_db === options.expectedDbName
      : DISPOSABLE_TEST_DB_PATTERN.test(row.current_db);

    if (!isAuthorizedTestDb) {
      throw new Error(
        `Refusing to seed: active database "${row.current_db}" does not match disposable test database pattern.`,
      );
    }

    const isLoopback =
      row.srv_host === null || row.srv_host === '127.0.0.1' || row.srv_host === '::1';

    if (!isLoopback) {
      // Non-loopback addresses are refused by default unless explicit validated container test mode is active
      if (!options.allowContainerTestDb) {
        throw new Error(
          `Refusing to seed: test server reported non-local address "${row.srv_host}".`,
        );
      }

      // The marker is checked first and compared without echoing either value.
      const marker = options.disposableMarker;
      if (
        !marker ||
        !/^campusos-disposable:[0-9a-f]{32}$/.test(marker) ||
        (row.db_comment ?? null) !== marker
      ) {
        throw new Error(
          "Refusing to seed: container test database does not carry this test run's disposable-database marker.",
        );
      }

      // Container path = ALL of: allowTestDb + allowContainerTestDb (set only by test code; seed-dev.ts never sets
      // either), this run's disposable-database marker on the database, a harness-generated database name, a loopback TEST_DATABASE_URL whose port is the server's own
      // port (the service container's published port), and a 172.16.0.0/12 server address. Anything else is refused.
      // The address alone proves nothing; NODE_ENV is not consulted as proof.
      if (!DISPOSABLE_TEST_DB_PATTERN.test(row.current_db)) {
        throw new Error(
          `Refusing to seed: container test database "${row.current_db}" is not a harness-generated disposable database.`,
        );
      }

      // Validating explicit container test database configuration
      const rawTestUrl = process.env.TEST_DATABASE_URL;
      if (!rawTestUrl) {
        throw new Error(
          'Refusing to seed: container test database requires TEST_DATABASE_URL configuration.',
        );
      }

      let testUrl: URL;
      try {
        testUrl = new URL(rawTestUrl);
      } catch {
        throw new Error('Refusing to seed: TEST_DATABASE_URL is not a valid URL.');
      }

      const allowedTestHosts = ['127.0.0.1', 'localhost', '[::1]'];
      if (!allowedTestHosts.includes(testUrl.hostname)) {
        throw new Error(
          `Refusing to seed: TEST_DATABASE_URL host "${testUrl.hostname}" is not local.`,
        );
      }

      const testPort = Number(testUrl.port || 5432);
      if (testPort !== row.srv_port) {
        throw new Error(
          `Refusing to seed: server port "${row.srv_port}" conflicts with TEST_DATABASE_URL port "${testPort}".`,
        );
      }

      if (!isPrivateContainerIp(row.srv_host)) {
        throw new Error(
          `Refusing to seed: test server address "${row.srv_host}" is not a recognized private container network.`,
        );
      }
    }
  }

  return {
    database: row.current_db,
    user: row.current_usr,
    port: row.srv_port,
    hostAddr: row.srv_host,
  };
}

/**
 * Idempotently seeds one local College Admin account.
 * Uses existing Argon2id password hashing, seeds tenant roles, and assigns COLLEGE_ADMIN.
 */
export async function seedDevAdmin(
  client: pg.Client,
  options: DevAdminSeedOptions,
): Promise<DevAdminSeedResult> {
  const {
    passwordPlain,
    orgSlug = 'dev-campus',
    orgName = 'Dev Campus',
    email = 'admin@dev.local',
    displayName = 'Dev Admin',
  } = options;

  if (!passwordPlain || passwordPlain.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await argon2.hash(passwordPlain, { type: argon2.argon2id });

  await client.query('BEGIN');
  try {
    // 1. Organization
    let organizationId: string;
    const orgRes = await client.query<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM app.organizations WHERE slug = $1',
      [orgSlug],
    );

    if (orgRes.rows.length === 0) {
      organizationId = uuidv7();
      await client.query(
        `INSERT INTO app.organizations (id, name, slug, status)
         VALUES ($1, $2, $3, 'ACTIVE')`,
        [organizationId, orgName, orgSlug],
      );
    } else {
      organizationId = orgRes.rows[0]!.id;
      if (orgRes.rows[0]!.name !== orgName || orgRes.rows[0]!.status !== 'ACTIVE') {
        await client.query(
          `UPDATE app.organizations
              SET name = $1, status = 'ACTIVE'
            WHERE id = $2`,
          [orgName, organizationId],
        );
      }
    }

    // 2. Roles: seed/re-sync tenant roles
    const exec = {
      query: (text: string, values?: readonly unknown[]) =>
        client.query(text, values ? [...values] : undefined),
    };
    await seedTenantRoles(exec, organizationId);

    // 3. Identity (platform.identities)
    let identityId: string;
    const identRes = await client.query<{ id: string }>(
      'SELECT id FROM platform.identities WHERE email = $1',
      [cleanEmail],
    );

    if (identRes.rows.length === 0) {
      identityId = uuidv7();
      await client.query(
        `INSERT INTO platform.identities (id, email, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')`,
        [identityId, cleanEmail, passwordHash],
      );
    } else {
      identityId = identRes.rows[0]!.id;
      await client.query(
        `UPDATE platform.identities
            SET password_hash = $1,
                failed_login_count = 0,
                locked_until = NULL,
                status = 'ACTIVE'
          WHERE id = $2`,
        [passwordHash, identityId],
      );
    }

    // 4. User membership (app.users)
    let userId: string;
    const userRes = await client.query<{ id: string; identity_id: string | null }>(
      'SELECT id, identity_id FROM app.users WHERE organization_id = $1 AND email = $2',
      [organizationId, cleanEmail],
    );

    if (userRes.rows.length === 0) {
      userId = uuidv7();
      await client.query(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
        [userId, organizationId, cleanEmail, displayName, identityId],
      );
    } else {
      userId = userRes.rows[0]!.id;
      await client.query(
        `UPDATE app.users
            SET identity_id = $1,
                status = 'ACTIVE'
          WHERE id = $2`,
        [identityId, userId],
      );
    }

    // 5. Role Assignment (COLLEGE_ADMIN at ORGANIZATION scope)
    const roleRes = await client.query<{ id: string }>(
      'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
      [organizationId, 'COLLEGE_ADMIN'],
    );
    if (roleRes.rows.length === 0) {
      throw new Error('COLLEGE_ADMIN role was not found after role seeding.');
    }
    const roleId = roleRes.rows[0]!.id;

    let roleAssignmentId: string;
    const assignRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM app.role_assignments
        WHERE organization_id = $1
          AND user_id = $2
          AND role_id = $3
          AND scope_type = 'ORGANIZATION'
          AND scope_id IS NULL`,
      [organizationId, userId, roleId],
    );

    if (assignRes.rows.length === 0) {
      roleAssignmentId = uuidv7();
      await client.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, status)
         VALUES ($1, $2, $3, $4, 'ORGANIZATION', NULL, 'ACTIVE')`,
        [roleAssignmentId, organizationId, userId, roleId],
      );
    } else {
      roleAssignmentId = assignRes.rows[0]!.id;
      if (assignRes.rows[0]!.status !== 'ACTIVE') {
        await client.query(
          `UPDATE app.role_assignments
              SET status = 'ACTIVE',
                  valid_until = NULL
            WHERE id = $1`,
          [roleAssignmentId],
        );
      }
    }

    await client.query('COMMIT');

    return {
      organizationId,
      organizationSlug: orgSlug,
      organizationName: orgName,
      identityId,
      userId,
      email: cleanEmail,
      roleCode: 'COLLEGE_ADMIN',
      roleAssignmentId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
