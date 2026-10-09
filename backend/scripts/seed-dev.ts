/**
 * Safe local development login seed utility.
 * Provisions one local College Admin account in campusos_dev.
 *
 * Usage:
 *   pnpm seed:dev
 *   pnpm seed:dev --confirm
 */
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import pg from 'pg';
import { probeLocalDevDatabase, seedDevAdmin, verifyLocalDevDatabaseUrl } from './dev-seed-core.js';

class MutedOutput extends Writable {
  muted = false;
  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk as Uint8Array | string, encoding);
    }
    callback();
  }
}

async function promptHiddenPassword(promptMessage: string): Promise<string> {
  const mutedOut = new MutedOutput();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedOut,
    terminal: Boolean(process.stdin.isTTY),
  });

  process.stdout.write(promptMessage);
  mutedOut.muted = true;
  try {
    const password = await rl.question('');
    return password.trim();
  } finally {
    mutedOut.muted = false;
    process.stdout.write('\n');
    rl.close();
  }
}

async function promptConfirmation(promptMessage: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(promptMessage);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hasConfirmFlag = args.includes('--confirm');

  console.log('=== Smart Campus OS - Local Development Login Seed ===\n');

  // 1. Explicit development opt-in gate
  if (!hasConfirmFlag) {
    if (!process.stdin.isTTY) {
      console.error(
        'Refusing to run: non-interactive invocation requires explicit opt-in flag "--confirm".',
      );
      process.exit(1);
    }
    const confirmed = await promptConfirmation(
      'This will provision/update the local College Admin account in "campusos_dev". Proceed? (y/N): ',
    );
    if (!confirmed) {
      console.log('Aborted by user.');
      process.exit(0);
    }
  }

  // 2. Validate URL configuration BEFORE connecting
  const rawAdminUrl = process.env['DATABASE_ADMIN_URL'];
  let adminUrl: URL;
  try {
    adminUrl = verifyLocalDevDatabaseUrl(rawAdminUrl);
  } catch (err) {
    console.error(`Safety check failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // 3. Resolve password interactively or from explicit DEV_ADMIN_PASSWORD env var
  let password = process.env['DEV_ADMIN_PASSWORD'] ?? '';
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error(
        'Refusing to run: interactive password entry requires a TTY. Set DEV_ADMIN_PASSWORD for automated runs.',
      );
      process.exit(1);
    }

    const p1 = await promptHiddenPassword(
      'Enter password for admin@dev.local (minimum 8 characters): ',
    );
    if (p1.length < 8) {
      console.error('Password must be at least 8 characters long.');
      process.exit(1);
    }

    const p2 = await promptHiddenPassword('Confirm password: ');
    if (p1 !== p2) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
    password = p1;
  } else if (password.length < 8) {
    console.error('DEV_ADMIN_PASSWORD must be at least 8 characters long.');
    process.exit(1);
  }

  // 4. Connect and run in-session safety probe
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();

  try {
    const probe = await probeLocalDevDatabase(client);
    console.log(
      `Verified local target: database="${probe.database}", host="${probe.hostAddr}", port=${probe.port}, user="${probe.user}"`,
    );

    // 5. Seed account
    console.log('Seeding College Admin account...');
    const result = await seedDevAdmin(client, {
      passwordPlain: password,
      orgSlug: 'dev-campus',
      orgName: 'Dev Campus',
      email: 'admin@dev.local',
      displayName: 'Dev Admin',
    });

    console.log('\n[SUCCESS] Development College Admin account ready:');
    console.log(`  Organization: ${result.organizationName} (slug: ${result.organizationSlug})`);
    console.log(`  Email:        ${result.email}`);
    console.log(`  Role:         ${result.roleCode} (Scope: ORGANIZATION)`);
    console.log('\nYou can sign in at http://localhost:5173 with email "admin@dev.local".');
  } catch (err) {
    console.error(`\nSeeding failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
