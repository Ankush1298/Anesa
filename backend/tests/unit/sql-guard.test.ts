import { describe, expect, it } from 'vitest';
import { assertSafeSql, UnsafeSqlError } from '../../src/shared/database/sql-guard.js';

describe('assertSafeSql', () => {
  const ok = [
    'SELECT id FROM app.students WHERE id = $1',
    'select * from app.students',
    '  UPDATE app.students SET status = $1 WHERE id = $2 RETURNING id',
    'INSERT INTO app.student_guardians (id) VALUES ($1);',
    'DELETE FROM app.student_guardians WHERE id = $1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT 'a;b' AS literal_semicolon",
    "SELECT 'set_config in a string literal is data' AS note",
    'SELECT reset_token FROM app.users',
    '-- comment\nSELECT 1',
  ];
  it.each(ok)('allows %s', (sql) => {
    expect(() => assertSafeSql(sql)).not.toThrow();
  });

  const bad: [string, string][] = [
    ['context override', "SELECT set_config('app.tenant_id', $1, true)"],
    ['qualified context override', "SELECT pg_catalog.set_config('app.user_id', $1, false)"],
    ['reading settings', "SELECT current_setting('app.tenant_id')"],
    ['plain SET', "SET app.tenant_id = 'x'"],
    ['SET LOCAL ROLE', 'SET LOCAL ROLE app_migrator'],
    ['RESET', 'RESET ALL'],
    ['DISCARD', 'DISCARD ALL'],
    ['transaction control', 'COMMIT'],
    ['BEGIN', 'BEGIN'],
    ['DO block', "DO $$ BEGIN PERFORM set_config('app.tenant_id','x',false); END $$"],
    ['dollar quoting', 'SELECT $q$x$q$'],
    ['stacked statements', 'SELECT 1; DELETE FROM app.students'],
    ['DDL', 'DROP TABLE app.students'],
    ['TRUNCATE', 'TRUNCATE app.students'],
    ['SHOW', 'SHOW row_security'],
    ['row_security toggle', 'SELECT 1 WHERE true OR row_security = off'],
    ['context name reference', 'SELECT 1 WHERE app.tenant_id IS NOT NULL'],
    [
      'comment-obfuscated',
      'SELECT set_/**/config(1)'.replace('set_/**/config', 'set_config /* x */'),
    ],
    ['empty', '   '],
  ];
  it.each(bad)('rejects %s', (_name, sql) => {
    expect(() => assertSafeSql(sql)).toThrow(UnsafeSqlError);
  });
});
