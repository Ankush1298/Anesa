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
  }

  return parsed;
}

/**
 * Probes the connected PostgreSQL session to verify server-side attributes.
 * Aborts if the target server identity does not match the local development database.
 */
export async function probeLocalDevDatabase(
  client: pg.Client,
  options: DevSeedTargetOptions = {},
): Promise<{ database: string; user: string; port: number; hostAddr: string | null }> {
  const res = await client.query<{
    current_db: string;
    current_usr: string;
    srv_port: number;
    srv_host: string | null;
  }>(`
    SELECT current_database() AS current_db,
           current_user AS current_usr,
           inet_server_port() AS srv_port,
           host(inet_server_addr()) AS srv_host;
  `);

  const row = res.rows[0];
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
    // In test harness mode, verify it's still local loopback or socket
    if (row.srv_host !== null && row.srv_host !== '127.0.0.1' && row.srv_host !== '::1') {
      throw new Error(
        `Refusing to seed: test server reported non-local address "${row.srv_host}".`,
      );
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
