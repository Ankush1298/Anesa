/** Usage: tsx tools/db/cli.ts <bootstrap|migrate>   (reads env; see .env.example) */
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
  const r = await migrate({ connectionString: required('MIGRATION_DATABASE_URL') });
  console.log(
    `migrate: applied [${r.applied.join(', ')}], already applied [${r.alreadyApplied.join(', ')}]`,
  );
} else {
  console.error('usage: cli.ts <bootstrap|migrate>');
  process.exit(1);
}
