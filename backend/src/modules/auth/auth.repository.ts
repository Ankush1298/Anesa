import { randomBytes, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import type { TenantTx } from '../../shared/database/index.js';

export interface IdentityRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export interface SessionRow {
  id: string;
  identity_id: string;
  tenant_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface MembershipRow {
  organization_id: string;
  user_id: string;
  status: string;
  org_slug: string;
  org_name: string;
}

export class AuthRepository {
  async findIdentityByEmail(tx: TenantTx, email: string): Promise<IdentityRow | null> {
    const res = await tx.query<IdentityRow>(
      `SELECT id, email, password_hash, status, failed_login_count, locked_until 
       FROM platform.identities WHERE email = lower($1)`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Per-account safety net against DISTRIBUTED guessing (per-IP limits are in LoginRateLimiter).
   * Threshold is 10, the lock is fixed 15 minutes and is NEVER extended while active, and the counter
   * restarts once a lock has expired, so one attacker cannot keep a victim locked out indefinitely.
   */
  async recordFailedLogin(tx: TenantTx, identityId: string): Promise<void> {
    await tx.query(
      `UPDATE platform.identities i
          SET failed_login_count = n.c::smallint,
              locked_until = CASE WHEN i.locked_until > now() THEN i.locked_until
                                  WHEN n.c >= 10 THEN now() + interval '15 minutes'
                                  ELSE NULL END
         FROM (SELECT id, LEAST(100, CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                                          THEN 1 ELSE failed_login_count + 1 END) AS c
                 FROM platform.identities WHERE id = $1) n
        WHERE i.id = n.id`,
      [identityId],
    );
  }

  async recordSuccessfulLogin(tx: TenantTx, identityId: string): Promise<void> {
    await tx.query(
      `UPDATE platform.identities 
       SET failed_login_count = 0, locked_until = NULL 
       WHERE id = $1`,
      [identityId],
    );
  }

  async findMemberships(tx: TenantTx, identityId: string): Promise<MembershipRow[]> {
    const res = await tx.query<MembershipRow>(
      `SELECT organization_id, user_id, status, org_slug, org_name
       FROM platform.get_identity_memberships($1)`,
      [identityId],
    );
    return res.rows;
  }

  async createSession(
    tx: TenantTx,
    identityId: string,
    tenantId: string,
    sessionId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO platform.auth_sessions (id, identity_id, tenant_id, token_hash, expires_at) 
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, identityId, tenantId, tokenHash, expiresAt],
    );
  }

  async findSessionByToken(tx: TenantTx, tokenHash: string): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `SELECT id, identity_id, tenant_id, token_hash, expires_at, revoked_at 
       FROM platform.auth_sessions 
       WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  async revokeSession(tx: TenantTx, sessionId: string): Promise<void> {
    await tx.query(`UPDATE platform.auth_sessions SET revoked_at = now() WHERE id = $1`, [
      sessionId,
    ]);
  }
}

export function hashToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
