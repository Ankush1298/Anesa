import { randomBytes } from 'node:crypto';

// Roles are cluster-wide. When several vitest projects share one PostgreSQL server (CI service
// container) they must agree on the same passwords, so generate them once per process.
let cached: { runtime: string; migrator: string } | undefined;

export function rolePasswords(): { runtime: string; migrator: string } {
  cached ??= {
    runtime: randomBytes(18).toString('hex'),
    migrator: randomBytes(18).toString('hex'),
  };
  return cached;
}

export function urlFor(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}
