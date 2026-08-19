/**
 * `\b` EST ASCII — et ce dépôt écrit du français. ADR-079.
 *
 * En JavaScript, `\b` se définit sur `\w`, c'est-à-dire `[A-Za-z0-9_]`. Une
 * lettre accentuée n'en fait pas partie : il n'existe donc **aucune frontière
 * de mot** à son contact.
 *
 * ```js
 * /\bà\s*\d+h/.test('à 14h')      // false — jamais
 * /envoyé\b/.test("c'est envoyé")  // false — jamais
 * ```
 *
 * POURQUOI CE FICHIER EXISTE PLUTÔT QU'UN COMMENTAIRE DE PLUS
 * ---------------------------------------------------------------------------
 * Le piège est documenté dans ce dépôt **depuis le début** — règle
 * `memory_search_decision` : *« piège systématique dès qu'on écrit des règles en
 * français »*. Il a mordu cinq fois :
 *
 * ```text
 * 1  memory_search_decision   trouvé à l'écriture, corrigé, COMMENTÉ
 * 2  ADR-074  détecteur de participes passés   `envoyé\b`
 * 3  ADR-075  (constat : ce n'était pas neuf — c'était déjà écrit)
 * 4  ADR-077  extraction de l'heure            `\b[àa]`
 * 5  ADR-079  TEMPORAL_QUALIFIER               `\b…[àa]\s*\d{1,2}\s*h`
 * ```
 *
 * La cinquième était un **défaut vivant en production** : « rappelle-moi à 14h
 * d'appeler Paul » créait une tâche intitulée « à 14h d'appeler Paul », sans
 * échéance, annoncée « c'est fait ». C'est mot pour mot le défaut HIGH-5 que
 * cette garde avait été écrite pour fermer — elle ne se déclenchait pas.
 *
 * Le remède employé quatre fois — écrire la leçon dans un commentaire — a
 * échoué quatre fois. `docs/26 §4.2 septies` l'avait acté :
 *
 * > Une leçon écrite dans un commentaire ne protège que le fichier qui la
 * > porte. Seul un mécanisme voyage.
 *
 * Ce fichier est ce mécanisme.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Toute lettre latine hors ASCII — celles qui cassent `\b`. */
const ACCENTUEE = /[À-ÖØ-öø-ÿ]/u;

function listTs(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Extrait les littéraux d'expression régulière d'une source TypeScript.
 *
 * ⚠ HEURISTIQUE ASSUMÉE, ET LE SENS DE L'ERREUR EST CHOISI. Distinguer une
 * division d'un littéral de regex demande un analyseur syntaxique complet. On
 * ne cherche donc que les formes non ambiguës — après `=`, `(`, `,`, `:`, `[`
 * ou un début de ligne — ce qui couvre la manière dont ce dépôt les écrit.
 *
 * Conséquence : ce détecteur peut RATER une regex exotique. Il ne peut pas en
 * inventer une. Sur un garde-fou, rater est un défaut ; halluciner serait pire,
 * parce qu'on ajouterait des exceptions pour le faire taire — et une exception
 * est un trou permanent.
 */
function regexLitterales(source: string): readonly string[] {
  const trouvees: string[] = [];
  const motif = /(?:^|[=(,:[]|\breturn|\btest|\bexec|\bmatch|\breplace)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+\/[dgimsuvy]*)/gmu;
  for (const m of source.matchAll(motif)) {
    if (m[1] !== undefined) trouvees.push(m[1]);
  }
  return trouvees;
}

/**
 * Ce littéral mêle-t-il `\b` et une lettre accentuée ?
 *
 * ⚠ RÈGLE VOLONTAIREMENT GROSSIÈRE, ET LA PREMIÈRE VERSION ÉTAIT TROP FINE.
 *
 * Elle ne regardait que l'ADJACENCE : `\bà` ou `é\b`. Elle a raté deux des cinq
 * cas historiques, dont le défaut vivant :
 *
 * ```text
 * /\b(fait|envoy[ée])\b/    le `\b` suit une PARENTHÈSE ; c'est à l'exécution
 *                            que « é » se retrouve à son contact
 * /\b(?:demain|[àa]\s*…)/   le `\b` précède une ALTERNATIVE dont une branche
 *                            commence par un accent
 * ```
 *
 * Savoir si une frontière peut toucher un accent demande de simuler toutes les
 * branches — c'est-à-dire un moteur d'expressions régulières. On applique donc
 * la règle qui n'a pas de trou : **`\b` et accent ne cohabitent pas dans un
 * même littéral.**
 *
 * Le coût est réel et assumé : une regex mêlant les deux sans danger devra être
 * réécrite avec une frontière explicite. C'est un prix par occurrence, contre
 * un défaut silencieux qui a mordu cinq fois. Et surtout — la réécriture donne
 * un motif qui marche vraiment, là où l'ancien marchait *par endroits*.
 */
export function frontiereMorte(litteral: string): boolean {
  return litteral.includes(String.raw`\b`) && ACCENTUEE.test(litteral);
}

describe('aucune frontière de mot ne touche un accent', () => {
  const sources = listTs('src');

  it('LE MÉCANISME — `src/` ne contient aucune frontière morte', () => {
    /* Le test qui remplace quatre commentaires. Il ne dépend d'aucune
       discipline : il regarde. */
    const fautives: string[] = [];
    for (const fichier of sources) {
      for (const litteral of regexLitterales(readFileSync(fichier, 'utf8'))) {
        if (frontiereMorte(litteral)) fautives.push(`${fichier} → ${litteral}`);
      }
    }
    expect(fautives).toEqual([]);
  });

  it('CONTRÔLE NÉGATIF — le détecteur reconnaît les cinq cas historiques', () => {
    /* Sans lui, un extracteur cassé rendrait une liste vide et le test
       précédent passerait sur du vent. On lui donne les motifs RÉELS qui ont
       mordu, tirés des ADR qui les ont corrigés. */
    for (const mort of [
      String.raw`/\b[àa]\s*(\d{1,2})\s*h/iu`, //           ADR-077
      String.raw`/\b(fait|envoy[ée])\b/iu`, //             ADR-074
      String.raw`/envoyé\b/u`, //                          ADR-074, autre côté
      String.raw`/\bdécidé\b/iu`, //                       le cas d'origine
      String.raw`/\b(?:demain|[àa]\s*\d{1,2}\s*h)/iu`, //  ADR-079
    ]) {
      expect(frontiereMorte(mort), mort).toBe(true);
    }
  });

  it('CONTRÔLE NÉGATIF — il ne mord pas sur ce qui est correct', () => {
    /* Un détecteur trop large se paie en exceptions, et une exception est un
       trou permanent. Ces motifs sont légitimes et doivent passer. */
    for (const vivant of [
      String.raw`/\bdemain\b/iu`, //          ASCII des deux côtés
      String.raw`/\b\d{1,2}\s*h/iu`, //       chiffre après la frontière
      String.raw`/^(?:[àa]\s*)?(\d{1,2})h/iu`, // pas de `\b` du tout
      String.raw`/\bmatin\b|\bsoir\b/iu`,
      String.raw`/après-midi/iu`, //          accent, mais aucune frontière
    ]) {
      expect(frontiereMorte(vivant), vivant).toBe(false);
    }
  });

  it('l’EXTRACTEUR trouve réellement des regex — sinon il prouverait le vide', () => {
    /* ⚠ LA GARDE DE LA GARDE. Un extracteur qui rendrait zéro littéral ferait
       passer le test principal quoi qu'il arrive — la faute exacte commise sur
       le comptage d'outils d'ADR-075, où une indentation erronée rendait une
       liste vide. Un compteur qui rend zéro doit rougir. */
    const moteur = readFileSync('src/core/intent/engine.ts', 'utf8');
    const trouvees = regexLitterales(moteur);
    expect(trouvees.length).toBeGreaterThan(8);
    expect(trouvees.some((r) => r.includes('rappelle-moi'))).toBe(true);
  });
});
