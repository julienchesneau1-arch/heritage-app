/**
 * LE CONTRAT DE NON-RÉGRESSION, RENDU MÉCANIQUE.
 *
 * `docs/05` énumère trente scénarios dorés. `docs/28` a mesuré que
 * **quatorze n'étaient référencés par aucun test** — un contrat à moitié muet,
 * et personne ne l'avait vu parce que rien ne le vérifiait.
 *
 * Écrire les tests manquants ne suffit pas : la dérive recommencerait au
 * prochain scénario ajouté. Ce fichier lie le DOCUMENT à la SUITE, et fait
 * échouer la CI dès que le lien se casse.
 *
 * TROIS ÉTATS, ET UN SEUL EST SILENCIEUX
 * ---------------------------------------
 *   RÉFÉRENCÉ   un test nomme le scénario         → rien à dire
 *   BLOQUÉ      la capacité n'existe pas encore   → déclaré, avec sa phase
 *   ORPHELIN    ni l'un ni l'autre                → ÉCHEC
 *
 * La catégorie BLOQUÉ n'est pas une échappatoire : chaque entrée nomme ce qui
 * manque et la phase de `docs/02` qui le livrera. Un scénario bloqué sans
 * justification vaut orphelin.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Extrait les identifiants de scénario des titres de `docs/05`. */
export function scenarioIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^### ([A-Z]\d+) —/gm)].map((m) => m[1] ?? '');
}

/** Tous les fichiers de test, sauf celui-ci — qui cite forcément tout. */
function testSources(): readonly { file: string; content: string }[] {
  const found: { file: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('golden/contract.test.ts')) {
        found.push({ file: full, content: readFileSync(full, 'utf8') });
      }
    }
  };
  walk('tests');
  return found;
}

/**
 * SCÉNARIOS BLOQUÉS — chacun nomme ce qui manque et QUI le livrera.
 *
 * Une entrée ici est une dette datée, pas une dérogation. Elle disparaît le
 * jour où la capacité existe, et le test le signalera si on l'oublie.
 */
const BLOQUES: Readonly<Record<string, string>> = {
  A2: "Context Engine hors circuit — `resolver.ts` n'est atteint par aucun point d'entrée (docs/26 §4.1)",
  A7: 'briefing_generate non écrit — Phase 3',
  A8: "aucun outil d'email n'existe — Phase 3",
  B4: 'web_search non écrit — Phase 3 ; la propriété RED↛sortie est couverte par exfiltration.test.ts',
  C4: "console d'égression non écrite — Phase 4",
  C3: "memory_forget non écrit — il n'existe qu'en tant qu'outil inverse déclaré (src/tools/memory.ts) ; Undo Engine",
};

describe('docs/05 — le contrat de non-régression est-il tenu ?', () => {
  const markdown = readFileSync('docs/05_GOLDEN_TESTS.md', 'utf8');
  const ids = scenarioIds(markdown);
  const sources = testSources();

  it('les trente scénarios sont bien lus depuis le document', () => {
    // Si le document change de forme, ce test le dit avant que tout le reste
    // ne devienne vert pour une mauvaise raison — un extracteur qui ne trouve
    // rien rendrait la couverture parfaite.
    expect(ids.length).toBe(30);
    expect(ids).toContain('A1');
    expect(ids).toContain('B14');
    expect(ids).toContain('C6');
  });

  it('AUCUN scénario doré n\'est orphelin', () => {
    const orphelins = ids.filter((id) => {
      if (BLOQUES[id] !== undefined) return false;
      // Référencé = cité entre accents graves ou en toutes lettres dans un test.
      const motif = new RegExp(`\\b${id}\\b`);
      return !sources.some((s) => motif.test(s.content));
    });

    if (orphelins.length > 0) {
      throw new Error(
        `${String(orphelins.length)} scénario(s) de docs/05 ne sont ` +
          `référencés par aucun test et ne sont pas déclarés bloqués :\n  ` +
          orphelins.join(', ') +
          '\n\nUn scénario qu\'aucun test ne nomme ne peut pas être invoqué ' +
          'le jour où il casse.',
      );
    }
    expect(orphelins).toEqual([]);
  });

  it('tout scénario déclaré BLOQUÉ existe et porte un motif', () => {
    for (const [id, motif] of Object.entries(BLOQUES)) {
      // Un blocage sur un scénario inexistant serait une dette fantôme.
      expect(ids).toContain(id);
      // Et un motif vide serait une dérogation déguisée.
      expect(motif.trim().length).toBeGreaterThan(20);
    }
  });

  it('la part bloquée reste minoritaire, et elle est CHIFFRÉE', () => {
    const bloques = Object.keys(BLOQUES).length;
    const couverts = ids.length - bloques;

    /* Le chiffre est écrit ici plutôt que dans un rapport : un rapport se
       périme, un test échoue. `docs/28` mesurait 16/30 référencés ; ce
       fichier porte désormais la mesure. A9 a quitté cette liste le jour où
       `audit_query` a existé — c'est exactement le mouvement qu'on attend
       d'une dette datée. */
    expect(couverts).toBe(24);
    expect(bloques).toBe(6);
    expect(bloques / ids.length).toBeLessThan(0.25);
  });

  /* ================================================================== *
   * CONTRÔLE NÉGATIF — l'extracteur voit-il vraiment ?
   * ================================================================== */

  it('DÉTECTE un scénario ajouté au document et oublié dans les tests', () => {
    const faux =
      markdown + '\n### Z9 — Scénario jamais testé `CRITIQUE`\n**Entrée :** rien.\n';
    const avec = scenarioIds(faux);

    expect(avec).toContain('Z9');
    expect(avec.length).toBe(ids.length + 1);

    // Et il n'est ni référencé ni déclaré bloqué : il serait signalé.
    expect(BLOQUES['Z9']).toBeUndefined();
    expect(sources.some((s) => /\bZ9\b/.test(s.content))).toBe(false);
  });

  it('N\'EST PAS aveugle à un document vide ou déformé', () => {
    // Le mode de panne le plus dangereux d'un extracteur : rendre zéro et
    // déclarer la couverture parfaite.
    expect(scenarioIds('')).toEqual([]);
    expect(scenarioIds('### pas un identifiant — texte')).toEqual([]);
  });
});
