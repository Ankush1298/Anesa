import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  SCOPE_MODES,
} from '../../src/shared/authorization/catalog.js';
import {
  GRANT_RULES,
  ROLE_CODES,
  ROLE_MATRIX,
  ROLE_SCOPE_TYPES,
} from '../../src/shared/authorization/role-matrix.js';

// The architecture document is the specification; the code must equal it (doc 10, intro + §4).
const doc = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../docs/architecture/v3/10-milestone-1-permission-catalog.md',
  ),
  'utf8',
);
const SENS = { N: 'NORMAL', S: 'SENSITIVE', C: 'CRITICAL' } as const;
const MODE = { S: 'SELF', A: 'ASSIGNED', G: 'GRANTED' } as const;

interface DocRow {
  sensitivity: string;
  cells: string[];
}
const docRows = new Map<string, DocRow>();
for (const line of doc.split('\n')) {
  const c = line.split('|').map((x) => x.trim());
  const code = /^`([a-z_.]+)`/.exec(c[2] ?? '')?.[1];
  if (/^\d+a?$/.test(c[1] ?? '') && code && c.length >= 12) {
    docRows.set(code, { sensitivity: c[3] ?? '', cells: c.slice(4, 12) });
  }
}

describe('permission catalog and role matrix equal docs/architecture/v3/10', () => {
  it('the document table was parsed (guards against a silent no-op test)', () => {
    expect(docRows.size).toBeGreaterThan(40);
    expect(ROLE_CODES).toHaveLength(8);
  });

  it('every catalogued permission exists in the document with the same sensitivity', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(docRows.has(p.code), p.code).toBe(true);
      expect(SENS[docRows.get(p.code)!.sensitivity as keyof typeof SENS], p.code).toBe(
        p.sensitivity,
      );
    }
    expect(PERMISSION_CODES.size).toBe(PERMISSION_CATALOG.length); // codes are unique
  });

  it('every (role, permission) cell matches: mode equal, "–" absent, A¹ (not seeded in M1) absent', () => {
    for (const p of PERMISSION_CATALOG) {
      const row = docRows.get(p.code)!;
      ROLE_CODES.forEach((role, i) => {
        const cell = row.cells[i] ?? '';
        const expected =
          cell.includes('¹') || cell === '–' ? undefined : MODE[cell as keyof typeof MODE];
        expect(ROLE_MATRIX[role][p.code], `${role} ${p.code} (doc: ${cell})`).toBe(expected);
      });
    }
  });

  it('the matrix references only catalogued permissions and valid modes; no scope word in a code', () => {
    for (const [role, perms] of Object.entries(ROLE_MATRIX)) {
      for (const [code, mode] of Object.entries(perms)) {
        expect(PERMISSION_CODES.has(code), `${role} ${code}`).toBe(true);
        expect(SCOPE_MODES).toContain(mode);
      }
    }
    for (const p of PERMISSION_CATALOG)
      expect(p.code).not.toMatch(/\.(own|all|dept|department_wide)(\.|$)/);
  });

  it('reserved namespaces are not seeded (doc 10 §3)', () => {
    for (const p of PERMISSION_CATALOG)
      expect(p.code).not.toMatch(/^(attendance|exam|result|finance)\./);
  });

  it('grant rules and role scope types are defined for every role and reference real roles only', () => {
    expect(Object.keys(ROLE_SCOPE_TYPES).sort()).toEqual([...ROLE_CODES].sort());
    for (const [grantor, grantable] of Object.entries(GRANT_RULES)) {
      expect(ROLE_CODES).toContain(grantor);
      for (const r of grantable) expect(ROLE_CODES).toContain(r);
      // only a roles-manager can grant at all
      expect(ROLE_MATRIX[grantor as keyof typeof ROLE_MATRIX]['role.assignment.grant']).toBe(
        'GRANTED',
      );
    }
    // doc 06 §5: nobody but COLLEGE_ADMIN may grant COLLEGE_ADMIN
    expect(
      Object.entries(GRANT_RULES)
        .filter(([, g]) => g.includes('COLLEGE_ADMIN'))
        .map(([k]) => k),
    ).toEqual(['COLLEGE_ADMIN']);
    // every role that holds the grant permission has grant rules (otherwise the permission is dead)
    for (const [role, perms] of Object.entries(ROLE_MATRIX)) {
      if (perms['role.assignment.grant']) expect(GRANT_RULES[role], role).toBeDefined();
    }
  });
});
