import { AppError } from '../../shared/errors/http-errors.js';
import type { Database } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { generateSessionToken, hashToken, verifyPassword } from './auth.repository.js';
import type { AuthRepository } from './auth.repository.js';
import { issueTrustedContext } from '../../shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly repo: AuthRepository,
  ) {}

  async login(email: string, passwordPlain: string, selectedTenantSlug?: string) {
    // 1. Locate identity safely (without tenant context yet, as they are logging in)
    return this.db.withSystem(async (tx) => {
      const identity = await this.repo.findIdentityByEmail(tx, email);

      // Enumeration resistance: we do the argon2 verify EVEN if identity is null
      // using a dummy hash to consume roughly the same amount of time.
      // For this spike, we'll just delay or use a known dummy hash.
      const dummyHash =
        '$argon2id$v=19$m=65536,p=4,t=3$GI/IaMNhy7fDZfTydHceqA$1TIQt3s6rKbgEXwrXDRpK4vc00Xvl4vlcUWy/neeQzA';
      const isPasswordValid = await verifyPassword(
        identity ? identity.password_hash : dummyHash,
        passwordPlain,
      );

      if (!identity || !isPasswordValid) {
        if (identity) await this.repo.recordFailedLogin(tx, identity.id);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      if (identity.locked_until && identity.locked_until > new Date()) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      if (identity.status !== 'ACTIVE') {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      // 2. Determine tenant membership
      const memberships = await this.repo.findMemberships(tx, identity.id);
      if (memberships.length === 0) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'); // No active memberships
      }

      let activeMembership = memberships[0]!;
      if (selectedTenantSlug) {
        const found = memberships.find((m) => m.org_slug === selectedTenantSlug);
        if (!found) {
          // Attack: Client requested a tenant they don't belong to.
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
        }
        activeMembership = found;
      }

      await this.repo.recordSuccessfulLogin(tx, identity.id);

      // 3. Create session
      const rawToken = generateSessionToken();
      const hashedToken = hashToken(rawToken);
      const sessionId = uuidv7();

      // Expire in 12 hours for the spike
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 12);

      await this.repo.createSession(
        tx,
        identity.id,
        activeMembership.organization_id,
        sessionId,
        hashedToken,
        expiresAt,
      );

      return {
        sessionToken: rawToken,
        identityId: identity.id,
        tenantId: activeMembership.organization_id,
        userId: activeMembership.user_id, // tenant-scoped membership id
      };
    });
  }

  async logout(rawToken: string): Promise<void> {
    const hashed = hashToken(rawToken);
    await this.db.withSystem(async (tx) => {
      const session = await this.repo.findSessionByToken(tx, hashed);
      if (session) {
        await this.repo.revokeSession(tx, session.id);
      }
    });
  }

  async validateSession(rawToken: string): Promise<TrustedContext> {
    const hashed = hashToken(rawToken);
    return this.db.withSystem(async (tx) => {
      const session = await this.repo.findSessionByToken(tx, hashed);

      if (!session) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid session');
      }
      if (session.revoked_at || session.expires_at < new Date()) {
        throw new AppError(401, 'UNAUTHORIZED', 'Session expired');
      }

      const identity = await tx.query<{ status: string }>(
        'SELECT status FROM platform.identities WHERE id = $1',
        [session.identity_id],
      );
      if (identity.rows[0]?.status !== 'ACTIVE') {
        throw new AppError(401, 'UNAUTHORIZED', 'Account suspended');
      }

      const memberships = await this.repo.findMemberships(tx, session.identity_id);
      const activeMembership = memberships.find((m) => m.organization_id === session.tenant_id);

      if (!activeMembership || activeMembership.status !== 'ACTIVE') {
        throw new AppError(401, 'UNAUTHORIZED', 'Membership suspended');
      }
      const userId = activeMembership.user_id;

      // Check if user is staff or student for actorKind
      let actorKind: 'STAFF' | 'STUDENT' = 'STAFF'; // Defaulting to staff unless we detect student row
      const isStudent = await tx.query('SELECT 1 FROM app.students WHERE user_id = $1', [userId]);
      if (isStudent.rowCount && isStudent.rowCount > 0) {
        actorKind = 'STUDENT';
      }

      return issueTrustedContext({
        tenantId: session.tenant_id,
        userId: userId,
        actorKind,
      });
    });
  }
}
