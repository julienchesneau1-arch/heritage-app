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
 * SCÉNARIOS BLOQUÉS — chacun nomme ce qui manque, et l'ABSENCE EST VÉRIFIÉE.
 *
 * ⚠ CE REGISTRE A ÉTÉ UN ALIBI PENDANT PLUSIEURS SPRINTS, ET `docs/28` LE
 *   PRÉSENTAIT COMME UNE GARANTIE.
 *
 * Il ne portait qu'un motif en texte libre. `docs/28` en tirait pourtant :
 * « le compteur aurait échoué si on avait livré l'outil sans retirer
 * l'entrée ». **C'était faux.** Les deux assertions chiffrées ci-dessous se
 * calculent uniquement à partir de cette table :
 *
 *     couverts = ids.length - bloques        ← ne lit pas le code
 *     bloques  = Object.keys(BLOQUES).length ← ne lit pas le code
 *
 * Écrire `web_search` sans toucher cette table laissait donc le test vert.
 * Mesuré, pas supposé : la reproduction est dans le message de commit d'ADR-055.
 *
 * DEPUIS, CHAQUE ENTRÉE EST FALSIFIABLE
 * --------------------------------------
 * Elle déclare ce qui doit rester ABSENT, et le test le vérifie. Le jour où la
 * capacité existe, l'entrée tombe d'elle-même — personne n'a à s'en souvenir.
 * C'est la discipline d'ADR-054, appliquée là où elle manquait aussi.
 */
type Blocage =
  | { readonly motif: string; readonly absentDuRegistre: string }
  | { readonly motif: string; readonly moduleOrphelin: string };

const BLOQUES: Readonly<Record<string, Blocage>> = {
  A2: {
    motif:
      "Context Engine hors circuit — `resolver.ts` n'est atteint par aucun point d'entrée (docs/26 §4.1)",
    /* Vérifié contre la liste FIGÉE de `wiring.test.ts` : tant que ce module y
       figure, il est bien hors circuit. Le jour où on le branche, il quitte
       cette liste et ce test rougit. */
    moduleOrphelin: 'src/core/context/resolver.ts',
  },
  A8: {
    motif: "aucun outil d'email n'existe — Phase 3",
    // Le registre des outils ne doit mentionner aucun email, sous aucune forme.
    absentDuRegistre: 'email',
  },
  C3: {
    motif:
      "memory_forget non écrit — il n'existe qu'en tant qu'outil inverse déclaré (src/tools/memory.ts) ; Undo Engine",
    absentDuRegistre: 'memoryForget',
  },
};

/** Le registre réel des outils : ce qui est ENREGISTRÉ, pas ce qui est écrit. */
const REGISTRE = readFileSync('src/tools/index.ts', 'utf8');

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
    for (const [id, blocage] of Object.entries(BLOQUES)) {
      // Un blocage sur un scénario inexistant serait une dette fantôme.
      expect(ids).toContain(id);
      // Et un motif vide serait une dérogation déguisée.
      expect(blocage.motif.trim().length).toBeGreaterThan(20);
    }
  });

  it('CHAQUE blocage prouve que ce qui manque manque ENCORE', () => {
    /* LE TEST QUI MANQUAIT, ET SON ABSENCE AVAIT ÉTÉ PRÉSENTÉE COMME UNE
       GARANTIE PAR `docs/28`.

       Sans lui, cette table est déclarative : on peut livrer la capacité et
       laisser l'entrée, le compteur ne voit rien. Avec lui, l'exemption
       s'autodétruit — même mécanisme que les NON EXIGIBLES d'ADR-054. */
    const wiring = readFileSync('tests/redteam/wiring.test.ts', 'utf8');

    for (const [id, blocage] of Object.entries(BLOQUES)) {
      if ('absentDuRegistre' in blocage) {
        expect(
          REGISTRE.includes(blocage.absentDuRegistre),
          `${id} est déclaré bloqué, or « ${blocage.absentDuRegistre} » est ` +
            'désormais dans le registre des outils : le blocage n’a plus de motif.',
        ).toBe(false);
      } else {
        expect(
          wiring.includes(blocage.moduleOrphelin),
          `${id} est déclaré bloqué parce que ${blocage.moduleOrphelin} est hors ` +
            'circuit, or `wiring.test.ts` ne le liste plus comme orphelin.',
        ).toBe(true);
      }
    }
  });

  it('la part bloquée reste minoritaire, et elle est CHIFFRÉE', () => {
    const bloques = Object.keys(BLOQUES).length;
    const couverts = ids.length - bloques;

    /* Le chiffre est écrit ici plutôt que dans un rapport : un rapport se
       périme, un test échoue. `docs/28` mesurait 16/30 référencés ; ce
       fichier porte désormais la mesure. A9 a quitté cette liste le jour où
       `audit_query` a existé — c'est exactement le mouvement qu'on attend
       d'une dette datée. A7 l'a quittée à son tour avec `briefing_generate`,
       C4 avec `egress_review`, puis **B4 avec `web_search`** (ADR-055).

       ⚠ CES DEUX LIGNES NE LISENT QUE LA TABLE, et il faut le dire ici plutôt
         que de laisser croire le contraire : c'est le test au-dessus — « chaque
         blocage prouve que ce qui manque manque encore » — qui rattache la
         table au code. Seul, ce compteur n'a jamais rien garanti. */
    expect(couverts).toBe(27);
    expect(bloques).toBe(3);
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
