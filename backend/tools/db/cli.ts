/**
 * Usage: tsx tools/db/cli.ts bootstrap
 *        tsx tools/db/cli.ts migrate [--allow-contract <NNNN>]...   (reads env; see .env.example)
 *
 * Contract migrations (`*_contract.sql`) are deferred unless their EXACT version is named with
 * --allow-contract. There is deliberately no environment variable and no wildcard for this: a value left in
 * .env must never authorise a schema-tightening migration. See docs/architecture/v3/18-academic-structure-f21.md.
 */
import { bootstrapDatabase } from './bootstrap.js';
import { migrate } from './migrate.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return v;
}

function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

const cmd = process.argv[2];
if (cmd === 'bootstrap') {
  await bootstrapDatabase({
    adminUrl: required('DATABASE_ADMIN_URL'),
    runtimePassword: passwordOf(required('DATABASE_URL')),
    migratorPassword: passwordOf(required('MIGRATION_DATABASE_URL')),
  });
  console.log('bootstrap: roles and schemas ready');
} else if (cmd === 'migrate') {
  const allowContract: string[] = [];
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = arg === '--allow-contract' ? args[++i] : /^--allow-contract=(.*)$/.exec(arg)?.[1];
    if (value === undefined || !/^\d{4}$/.test(value)) {
      console.error('usage: migrate [--allow-contract <exact 4-digit version>]...');
      process.exit(1);
    }
    allowContract.push(value);
  }
  const r = await migrate({
    connectionString: required('MIGRATION_DATABASE_URL'),
    allowContract,
  });
  console.log(
    `migrate: applied [${r.applied.join(', ')}], already applied [${r.alreadyApplied.join(', ')}]`,
  );
  if (r.deferred.length > 0) {
    console.warn(
      `migrate: DEFERRED [${r.deferred.join(', ')}]: contract migration ${r.blockedBy} needs explicit authorisation ` +
        `(--allow-contract ${r.blockedBy}) AFTER every writer has been upgraded. Nothing after it was applied.`,
    );
  }
} else {
  console.error('usage: cli.ts <bootstrap|migrate>');
  process.exit(1);
}
