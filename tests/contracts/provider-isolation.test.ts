/**
 * Test de contrat : isolation des fournisseurs.
 *
 * ADR-003 / invariant I6 : « Aucun code hors `/providers/<nom>/` ne peut
 * importer un SDK de fournisseur. Cette règle est vérifiée par un test de
 * contrat automatisé qui échoue le build, pas par une convention de revue. »
 *
 * L'approche est une LISTE BLANCHE, pas une liste noire : le noyau ne peut
 * importer que les modules natifs de Node, une poignée de dépendances
 * d'infrastructure, et des chemins relatifs. Un SDK ajouté demain est donc
 * bloqué sans que personne ait à penser à l'inscrire quelque part.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/**
 * Dépendances autorisées dans le noyau.
 *
 * Toute addition à cette liste est une décision d'architecture et doit
 * s'accompagner d'une fiche de dépendance (04 §1).
 */
const CORE_ALLOWED_PACKAGES: ReadonlySet<string> = new Set([
  'zod', // validation aux frontières — imposée par ADR-016
  'pg', // pilote PostgreSQL — ADR-001, base de vérité unique
]);

/** Répertoires dont le contenu a le droit d'importer un SDK de fournisseur. */
const PROVIDER_DIRS: readonly string[] = ['src/providers'];

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
}

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Extrait les spécificateurs de module d'un fichier TypeScript. */
export function extractImportSpecifiers(
  source: string,
): readonly { specifier: string; line: number }[] {
  const results: { specifier: string; line: number }[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import … from 'x' / export … from 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const line = source.slice(0, match.index).split('\n').length;
      results.push({ specifier, line });
    }
  }
  return results;
}

/** Un spécificateur est-il un import de paquet externe ? */
export function isBarePackage(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('node:')) return false;
  return true;
}

/** Nom de paquet racine : `@scope/name/sub` → `@scope/name`. */
export function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

export function findViolations(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (PROVIDER_DIRS.some((d) => rel.startsWith(`${d}/`))) continue;

    for (const { specifier, line } of extractImportSpecifiers(
      readFileSync(file, 'utf8'),
    )) {
      if (!isBarePackage(specifier)) continue;
      if (CORE_ALLOWED_PACKAGES.has(packageRoot(specifier))) continue;
      violations.push({ file: rel, specifier, line });
    }
  }
  return violations;
}

describe('ADR-003 — isolation des fournisseurs', () => {
  it('aucun paquet externe non autorisé n\'est importé hors de src/providers', () => {
    const violations = findViolations(listTypeScriptFiles(join(ROOT, 'src')));

    // Message d'échec explicite : le prochain lecteur doit comprendre POURQUOI
    // sans ouvrir l'ADR.
    const detail = violations
      .map((v) => `  ${v.file}:${String(v.line)} importe « ${v.specifier} »`)
      .join('\n');

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Le noyau ne doit dépendre d'aucun SDK de fournisseur (ADR-003).\n` +
            `${detail}\n\n` +
            `Déplacer cet usage sous src/providers/ derrière une interface, ` +
            `ou — si c'est une dépendance d'infrastructure — l'ajouter à ` +
            `CORE_ALLOWED_PACKAGES avec sa fiche de dépendance (04 §1).`,
    ).toEqual([]);
  });

  it('le SDK Cedar n\'est importé que par son adaptateur', () => {
    const files = listTypeScriptFiles(join(ROOT, 'src'));
    const importers = files.filter((f) =>
      extractImportSpecifiers(readFileSync(f, 'utf8')).some((i) =>
        i.specifier.startsWith('@cedar-policy/'),
      ),
    );

    expect(importers.map((f) => relative(ROOT, f).split(sep).join('/'))).toEqual([
      'src/providers/policy/cedar.ts',
    ]);
  });

  /**
   * Test négatif — indispensable.
   *
   * Une garde qu'on n'a jamais vue se déclencher est une garde dont on ignore
   * si elle fonctionne. La porte de sortie Phase 0 l'exige explicitement :
   * « le test de contrat échoue bien quand on l'enfreint volontairement ».
   */
  it('détecte une infraction volontaire', () => {
    const offending = join(ROOT, 'tests', 'fixtures', 'violating-core-file.ts.fixture');
    const specifiers = extractImportSpecifiers(readFileSync(offending, 'utf8'));
    const bare = specifiers
      .filter((s) => isBarePackage(s.specifier))
      .filter((s) => !CORE_ALLOWED_PACKAGES.has(packageRoot(s.specifier)));

    expect(bare.map((b) => b.specifier)).toContain('openai');
    expect(bare.length).toBeGreaterThan(0);
  });

  it('ne signale pas les imports légitimes du noyau', () => {
    const legitimate = [
      'node:crypto',
      './types/result.js',
      '../core/policy/gate.js',
      'zod',
      'pg',
    ];
    const flagged = legitimate
      .filter(isBarePackage)
      .filter((s) => !CORE_ALLOWED_PACKAGES.has(packageRoot(s)));

    expect(flagged).toEqual([]);
  });
});
