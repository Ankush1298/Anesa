import { randomBytes } from 'node:crypto';

// Roles are cluster-wide. When several vitest projects share one PostgreSQL server (TEST_DATABASE_URL) they must
// agree on the same passwords: every project's global setup bootstraps the same two roles with ALTER ROLE ... PASSWORD,
// so a project that used different passwords would invalidate the URLs the earlier project had already handed to its
// tests ("password authentication failed for user app_runtime").
//
// A module-level cache is NOT enough: vitest evaluates each project's globalSetup in its own module graph, so every
// project got its own copy of the cache and its own passwords. The one thing all projects of a run share is the main
// process, hence the passwords are generated once and kept in process.env. They are throw-away values for a disposable
// test server; two separate vitest PROCESSES against one server remain unsupported (each would rotate the other's
// passwords), which is why CI runs its database projects as sequential steps.
const ENV_RUNTIME = 'CAMPUSOS_TEST_RUNTIME_ROLE_PASSWORD';
const ENV_MIGRATOR = 'CAMPUSOS_TEST_MIGRATOR_ROLE_PASSWORD';

export function rolePasswords(): { runtime: string; migrator: string } {
  process.env[ENV_RUNTIME] ??= randomBytes(18).toString('hex');
  process.env[ENV_MIGRATOR] ??= randomBytes(18).toString('hex');
  return { runtime: process.env[ENV_RUNTIME], migrator: process.env[ENV_MIGRATOR] };
}

export function urlFor(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}
