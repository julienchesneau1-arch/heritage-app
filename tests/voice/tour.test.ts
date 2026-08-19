/**
 * LE TOUR DE PAROLE — ce que la fluidité n'a pas le droit de coûter. ADR-074.
 *
 * `docs/06` tranche : **« l'honnêteté prime sur la fluidité »**. Ce fichier
 * éprouve que la fluidité gagnée à l'oral ne se paie ni en vérité (une phrase
 * qui affirme un effet non constaté) ni en sûreté (une action déclenchée par
 * une phrase que l'utilisateur n'a pas prononcée).
 *
 * Trois propriétés, toutes falsifiables :
 *
 *   1. un énoncé NON FINAL ne franchit pas la porte ;
 *   2. aucun accusé de réception n'est une phrase de verdict — vérifié CONTRE
 *      la table réelle de `report.ts`, pas contre une liste recopiée ;
 *   3. le CLI passe par la porte, et ne garde pas de chemin parallèle.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACCUSES,
  accuseReception,
  ecouter,
  type Accuse,
  type Utterance,
} from '../../src/core/voice/turn.js';
import { headline } from '../../src/apps/cli/report.js';
import type { IntentProposal } from '../../src/core/intent/engine.js';
import type { VerificationStatus } from '../../src/core/types/domain.js';

const STATUTS: readonly VerificationStatus[] = [
  'CONFIRMED',
  'PROBABLE',
  'PARTIAL',
  'UNKNOWN',
  'FAILED',
  'NOT_ATTEMPTED',
  'PROVIDER_CONTRACT_VIOLATION',
];

/**
 * Ce qu'il reste d'une phrase une fois PRONONCÉE.
 *
 * ⚠ AJOUTÉ APRÈS UN SABOTAGE QUI AURAIT DÛ ÊTRE ATTRAPÉ PAR DEUX TESTS ET NE
 * L'A ÉTÉ QUE PAR UN. En remplaçant `ENGAGE` par « c'est fait », la disjonction
 * est restée VERTE : elle comparait des chaînes exactes, et `headline` rend
 * « C'est fait. » — une majuscule et un point d'écart.
 *
 * À l'écrit ce sont deux chaînes ; à l'oral c'est la MÊME PHRASE. Or la
 * propriété défendue est justement qu'un auditeur ne puisse pas les confondre.
 * La comparaison devait donc se faire sur ce qui s'entend, pas sur ce qui
 * s'écrit.
 */
function aLOreille(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[.,;:!?…]/gu, '')
    .replace(/[’']/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Une phrase affirme-t-elle un EFFET accompli ?
 *
 * Détecteur volontairement GROSSIER — sous-chaîne, sans frontière de mot. Deux
 * raisons, et la seconde est la vraie :
 *
 *   • l'ensemble surveillé est CLOS et minuscule (`ACCUSES`), donc un faux
 *     positif se voit et se corrige en une ligne ;
 *   • un détecteur malin a des trous, et ceux-ci sont invisibles. Celui qu'on a
 *     essayé d'abord en avait un béant (voir le contrôle négatif).
 *
 * Sur un garde-fou, se tromper en refusant coûte une reformulation ; se tromper
 * en acceptant coûte un mensonge dit à l'utilisateur.
 */
function affirmeUnEffet(phrase: string): boolean {
  const racines = ['fait', 'envoyé', 'ajouté', 'supprimé', 'créé', 'enregistré'];
  const bas = phrase.toLowerCase();
  return racines.some((r) => bas.includes(r));
}

function appel(userConfirms: boolean): IntentProposal {
  return {
    kind: 'TOOL_CALL',
    toolId: 'note_create',
    input: { content: 'x' },
    parameterProvenance: { content: 'USER' },
    confidence: 1,
    tier: 0,
    userConfirms,
    referents: {},
  };
}

/* ====================================================================== *
 * 1. UNE HYPOTHÈSE N'EST PAS UNE PHRASE
 * ====================================================================== */

describe('la porte d’écoute', () => {
  it('REFUSE un énoncé non final — et dit pourquoi', () => {
    /* LE CŒUR DU FICHIER. Un moteur de reconnaissance en flux RÉVISE ses
       hypothèses : « Envoie un message à Paul » passe par « Envoie un
       message ». Agir sur l'une d'elles, c'est agir sur une phrase que
       personne n'a dite — et c'est précisément le raccourci par lequel un
       assistant vocal gagne de la fluidité. */
    const verdict = ecouter({ text: 'supprime mes not', final: false });
    expect(verdict.kind).toBe('ATTENDRE');
    if (verdict.kind !== 'ATTENDRE') return;
    // Le motif est destiné à l'utilisateur : il doit dire quelque chose.
    expect(verdict.motif.length).toBeGreaterThan(20);
  });

  it('le refus ne dépend PAS du contenu — un texte anodin non final attend aussi', () => {
    /* CONTRÔLE : sans lui, une implémentation qui ne refuserait que les verbes
       destructeurs passerait le test précédent. C'est le champ `final` qui
       décide, jamais ce que la phrase raconte. */
    for (const texte of ['bonjour', 'note du café', 'supprime tout']) {
      expect(ecouter({ text: texte, final: false }).kind).toBe('ATTENDRE');
    }
  });

  it('CONTRÔLE NÉGATIF — un énoncé FINAL passe, sinon la porte serait un mur', () => {
    const verdict = ecouter({ text: '  note du café  ', final: true });
    expect(verdict.kind).toBe('AGIR');
    if (verdict.kind !== 'AGIR') return;
    expect(verdict.texte).toBe('note du café');
  });

  it('un énoncé FINAL mais VIDE attend — le silence n’est pas une demande', () => {
    for (const texte of ['', '   ', '\t\n']) {
      expect(ecouter({ text: texte, final: true }).kind).toBe('ATTENDRE');
    }
  });
});

/* ====================================================================== *
 * 2. L'ACCUSÉ DE RÉCEPTION NE PEUT PAS MENTIR
 * ====================================================================== */

describe('l’accusé de réception', () => {
  it('ne partage AUCUNE phrase avec la table des verdicts', () => {
    /* LA PROPRIÉTÉ QUI COMPTE, ET ELLE SE VÉRIFIE CONTRE LA VRAIE TABLE.
       Un auditeur qui entend « je m'en occupe » doit être incapable de le
       confondre avec « c'est fait ». Recopier ici les phrases de `report.ts`
       aurait fabriqué un second registre du même fait (ADR-041) : on lit donc
       `headline` à la source, et si quelqu'un y écrit un jour « je m'en
       occupe » sur `PROBABLE`, ce test tombe. */
    const verdicts = new Set(STATUTS.map((s) => aLOreille(headline(s))));
    for (const accuse of Object.values(ACCUSES)) {
      expect(verdicts.has(aLOreille(accuse)), accuse).toBe(false);
    }
  });

  it('aucun accusé ne contient de participe passé d’ACTION', () => {
    /* Plus étroit que le test précédent et non redondant : la disjonction
       protège des phrases EXACTES de `report.ts`, celui-ci protège d'une
       formulation nouvelle qui affirmerait un effet sans être dans la table.
       « c'est envoyé », « ajouté », « supprimé » — le passé d'un effet. */
    for (const accuse of Object.values(ACCUSES)) {
      expect(affirmeUnEffet(accuse), accuse).toBe(false);
    }
  });

  it('CONTRÔLE NÉGATIF — le détecteur ci-dessus attrape bien une phrase de verdict', () => {
    /* Sans ce contrôle, un détecteur cassé rendrait le test précédent vert quoi
       qu'on écrive dans `ACCUSES`. On lui donne ce qu'il doit refuser.

       ⚠ LA PREMIÈRE VERSION ÉTAIT CASSÉE, ET C'EST CE CONTRÔLE QUI L'A DIT.
       Elle employait `/\b(...|envoy[ée]|...)\b/` — et en JavaScript, `\b` est
       défini sur les caractères ASCII. « é » n'en est pas un : après lui il n'y
       a donc AUCUNE frontière de mot, et `envoyé\b` ne peut pas matcher
       « envoyé » en fin de phrase. Le détecteur laissait passer exactement les
       mots français qu'il était censé attraper. */
    expect(affirmeUnEffet("c'est fait")).toBe(true);
    expect(affirmeUnEffet("c'est envoyé")).toBe(true);
    expect(affirmeUnEffet('ta note est enregistrée')).toBe(true);
    expect(affirmeUnEffet('les rappels ont été supprimés')).toBe(true);
    // Et il laisse passer ce qui ne prétend rien.
    expect(affirmeUnEffet("je m'en occupe")).toBe(false);
    expect(affirmeUnEffet('je te demande une confirmation')).toBe(false);
  });

  it('rend un accusé pour CHAQUE forme de proposition — jamais le silence', () => {
    /* Le silence est ce qui fait dire « il a planté ». Une proposition non
       couverte qui rendrait `undefined` produirait exactement ce silence. */
    const propositions: readonly IntentProposal[] = [
      appel(true),
      appel(false),
      { kind: 'CLARIFY', question: 'laquelle ?', understood: 'une note' },
      { kind: 'UNSUPPORTED', understood: 'un envoi', missing: 'aucun outil' },
    ];
    const attendus = new Set<string>(Object.values(ACCUSES));
    for (const p of propositions) {
      const accuse: Accuse = accuseReception(p);
      expect(attendus.has(accuse), p.kind).toBe(true);
    }
  });

  it('annonce la CONFIRMATION à venir quand l’énoncé ne vaut pas accord', () => {
    // La distinction porte le sens : « je m'en occupe » sur une action qui va
    // s'arrêter pour demander serait une promesse que la suite dément.
    expect(accuseReception(appel(true))).toBe(ACCUSES.ENGAGE);
    expect(accuseReception(appel(false))).toBe(ACCUSES.CONFIRMATION);
  });

  it('LA GARANTIE EST LA SIGNATURE — elle ne reçoit aucun résultat', () => {
    /* ⚠ LE TEST LE PLUS IMPORTANT DU FICHIER, ET IL EST STRUCTUREL.

       Les tests ci-dessus éprouvent les phrases ÉCRITES AUJOURD'HUI. Celui-ci
       éprouve ce qui rend impossible d'en écrire une mauvaise demain :
       `accuseReception` ne voit ni statut de vérification, ni sortie d'outil,
       ni verdict. Lui passer un jour le résultat serait le geste qui rouvre le
       mensonge — et il passerait inaperçu, puisque toutes les phrases
       actuelles resteraient justes.

       Même geste que `confirmed()` : on ne demande pas à l'auteur de se
       retenir, on lui retire le moyen. */
    const source = readFileSync('src/core/voice/turn.ts', 'utf8');
    const signature = /export function accuseReception\(([^)]*)\)/.exec(source);
    expect(signature, 'accuseReception introuvable').not.toBeNull();
    expect(signature?.[1]).toBe('proposal: IntentProposal');

    // Et le module entier ignore le vocabulaire du résultat.
    expect(source).not.toContain('VerificationStatus');
    expect(source).not.toContain('GatewayResult');
    expect(source).not.toContain('verification/');
  });
});

/* ====================================================================== *
 * 3. CE QUI EST BRANCHÉ, ET CE QUI NE L'EST PAS
 * ====================================================================== */

describe('la porte est SUR LE CHEMIN, et le reste est déclaré tel quel', () => {
  it('le CLI fait passer chaque ligne par `ecouter`', () => {
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain("from '../../core/voice/turn.js'");
    expect(cli).toContain('ecouter({ text: raw, final: true })');
  });

  it('le CLI n’a PAS gardé de chemin parallèle autour de la porte', () => {
    /* SANS CE TEST, LE PRÉCÉDENT NE PROUVE RIEN. Un appel à `ecouter` dont on
       ignorerait le verdict — ou un `raw.trim()` conservé à côté — laisserait
       la porte en place et le contournement ouvert. C'est la leçon d'ADR-066 :
       un appel présent dans le source ne dit pas que le résultat gouverne.

       On vérifie donc que le texte envoyé à l'Assistant vient du VERDICT. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('const line = verdict.texte;');
    expect(cli).toContain("if (verdict.kind === 'ATTENDRE') continue;");
    expect(cli).not.toContain('const line = raw.trim();');
  });

  it('DÉMONSTRATION — `accuseReception` n’a AUCUN appelant de production', () => {
    /* ⚠ CE TEST DIT UNE ABSENCE, ET C'EST VOULU.

       `tests/redteam/wiring.test.ts` raisonne par FICHIER : dès que le CLI
       importe `ecouter`, il déclare `voice/turn.ts` atteint. Cette granularité
       ferait passer une fonction morte pour une fonction branchée — exactement
       la confusion que `docs/26 §2` recense neuf fois.

       `accuseReception` attend une surface où l'ATTENTE existe, c'est-à-dire la
       synthèse vocale. Dans un terminal, le verdict arrive en quelques
       millisecondes et intercaler « je m'en occupe » dégraderait la lecture
       pour faire tourner du code.

       CETTE LIGNE DOIT TOMBER LE JOUR OÙ L'AUDIO ARRIVE. C'est sa fonction. */
    const production = ['src/apps/cli/main.ts', 'src/apps/server/http.ts', 'src/core/assistant.ts']
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(production).not.toContain('accuseReception');
  });
});

/* ====================================================================== *
 * 4. LE BUDGET DE LATENCE — la raison pour laquelle tout ceci tient
 * ====================================================================== */

describe('le coût de la chaîne vérifiée', () => {
  it('la porte d’écoute est GRATUITE à l’échelle d’un tour de parole', () => {
    /* L'INTUITION QU'ON FALSIFIE ICI : « vérifié, donc lent ». Si elle était
       vraie, l'honnêteté se paierait en fluidité et `docs/06` demanderait un
       sacrifice. Elle ne l'est pas — le budget d'un tour de parole est
       consommé par la transcription et la synthèse, pas par nous.

       Le seuil est LARGE à dessein : il n'est pas là pour mesurer une machine,
       il est là pour attraper le jour où quelqu'un mettrait une entrée-sortie
       dans cette porte. Une lecture de base ou un appel réseau le crèveraient
       de plusieurs ordres de grandeur. */
    const enonce: Utterance = { text: 'ajoute du café à ma liste', final: true };
    const N = 10_000;

    const debut = performance.now();
    for (let i = 0; i < N; i++) ecouter(enonce);
    const parEnonce = (performance.now() - debut) / N;

    expect(parEnonce).toBeLessThan(0.1); // millisecondes
  });
});
