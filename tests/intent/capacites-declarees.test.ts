/**
 * CE QUE JARVIS DIT DE LUI-MÊME — et qui doit être vrai. ADR-075.
 *
 * `S15` interdit d'annoncer un effet non constaté. Ce fichier éprouve le
 * jumeau du même interdit, un cran plus haut : **ne pas mentir sur son propre
 * catalogue**.
 *
 * LE DÉFAUT QUE CE FICHIER FERME
 * ---------------------------------------------------------------------------
 * Le moteur répondait *« cette capacité n'est pas encore construite »* à quatre
 * demandes dont les outils EXISTAIENT :
 *
 * ```text
 * « cherche sur le web … »        web_search        écrit à ADR-055
 * « retrouve mon devis »          file_search       écrit à ADR-046
 * « qu'ai-je dans mon agenda »    calendar_read     écrit à ADR-043
 * « supprime cette note »         note_delete       écrit à ADR-067
 * ```
 *
 * Aucun effet n'était annoncé à tort — donc `S15` restait intact, et c'est
 * précisément pourquoi rien ne l'a vu. Le coût est pourtant le même :
 * **l'utilisateur renonce à demander ce que Jarvis sait faire.** Une capacité
 * niée est aussi absente qu'une capacité manquante.
 *
 * SIX REGISTRES DE LA MÊME LISTE
 * ---------------------------------------------------------------------------
 * La cause est celle d'ADR-041, appliquée cette fois aux capacités et non aux
 * données. La liste « ce que je sais faire » vivait à six endroits :
 *
 * ```text
 * KNOWN_BUT_UNAVAILABLE     ce que je dis ne pas savoir
 * unavailable()             la liste jointe à ce refus
 * la question d'ambiguïté   « ni sur le web, ni dans tes documents »
 * le message final          « essaie : … »
 * HELP du CLI               l'aide affichée
 * les règles elles-mêmes    la seule qui disait vrai
 * ```
 *
 * Les cinq premiers sont désormais DÉRIVÉS du sixième.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { capacitesParlees, createIntentEngine } from '../../src/core/intent/engine.js';

const SOURCE = readFileSync('src/core/intent/engine.ts', 'utf8');

/** Ramène toute apostrophe à la droite — « l’agenda » et « l'agenda » sont un
 *  seul mot français, et seul le second s'écrit sans échappement en source. */
const droite = (s: string): string => s.replace(/[’‘`]/gu, "'");

/** Les outils réellement enregistrés, lus depuis `src/tools/`. */
function outilsEcrits(): ReadonlySet<string> {
  const index = readFileSync('src/tools/index.ts', 'utf8');
  const ids = new Set<string>();
  for (const m of index.matchAll(/from '\.\/([a-z]+)\.js'/g)) {
    const f = m[1];
    if (f === undefined || f === 'index') continue;
    for (const t of readFileSync(`src/tools/${f}.ts`, 'utf8').matchAll(
      /^\s+id: '([a-z_]+)',$/gm,
    )) {
      if (t[1] !== undefined) ids.add(t[1]);
    }
  }
  return ids;
}

describe('Jarvis ne ment pas sur son propre catalogue', () => {
  const ecrits = outilsEcrits();
  const moteur = createIntentEngine();

  it('LA GARDE — un outil déclaré MANQUANT ne doit pas exister', () => {
    /* ⚠ LE TEST QUI AURAIT ATTRAPÉ LE DÉFAUT LE JOUR OÙ IL EST NÉ.

       Chaque capacité déclarée absente nomme désormais l'outil qui la
       servirait (`outilQuiManque`), ou `null` quand la raison est ailleurs.
       Nommer rend l'affirmation vérifiable : si l'outil apparaît un jour dans
       le catalogue, cette assertion tombe et FORCE à changer le message.

       Sans elle, la déclaration reste de la prose — et la prose ne rougit
       jamais. */
    const declares = [...SOURCE.matchAll(/outilQuiManque: '([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((id): id is string => id !== undefined);

    expect(declares.length, 'aucune capacité absente déclarée').toBeGreaterThan(0);
    for (const id of declares) {
      expect(ecrits.has(id), `« ${id} » est déclaré manquant mais il EXISTE`).toBe(false);
    }
  });

  it('CONTRÔLE NÉGATIF — la garde détecte bien un outil qui existe', () => {
    /* Sans lui, un extracteur cassé rendrait une liste vide et le test
       précédent passerait sur du vent. On lui donne un identifiant réel. */
    expect(ecrits.has('web_search')).toBe(true);
    expect(ecrits.has('note_delete')).toBe(true);
    expect(ecrits.has('outil_qui_n_existe_pas')).toBe(false);
  });

  it('les QUATRE mensonges sont fermés — chacun rend désormais un appel', () => {
    /* Le nom de ce test est délibérément le nom du défaut. Chaque ligne est une
       phrase à laquelle Jarvis répondait « je ne sais pas faire ». */
    const attendus: readonly [string, string][] = [
      ['cherche sur le web le prix moyen d’un carrelage', 'web_search'],
      ['cherche dans mes documents le devis du carreleur', 'file_search'],
      ['fais-moi un point', 'briefing_generate'],
      ['comment vas-tu', 'system_status'],
    ];
    for (const [phrase, toolId] of attendus) {
      const p = moteur.propose(phrase);
      expect(p.kind, `« ${phrase} »`).toBe('TOOL_CALL');
      if (p.kind !== 'TOOL_CALL') continue;
      expect(p.toolId, `« ${phrase} »`).toBe(toolId);
    }
  });

  it('AGENDA et SUPPRESSION disent la VRAIE raison, pas « pas construit »', () => {
    /* Les deux capacités dont les outils existent SANS qu'une règle puisse les
       atteindre. La tentation était de les laisser dans « pas encore
       construit » : c'est plus court, et c'est faux.

       La raison exacte compte pour l'utilisateur : « aucun agenda n'est
       connecté » lui dit qu'il peut y remédier, « pas construit » lui dit
       d'attendre. Ce ne sont pas les mêmes informations. */
    const agenda = moteur.propose('qu’ai-je dans mon agenda demain');
    expect(agenda.kind).toBe('UNSUPPORTED');
    if (agenda.kind === 'UNSUPPORTED') {
      /* Apostrophes NORMALISÉES avant comparaison. La première version a
         échoué là-dessus : la source écrit `l\'écrire` (apostrophe droite),
         le test attendait « l’écrire » (courbe). Deux caractères différents,
         un seul mot français — et rien ne le distingue à l'œil dans un
         diff. Même leçon qu'ADR-074 sur les phrases entendues. */
      expect(droite(agenda.understood)).toContain(droite('je sais le lire et l’écrire'));
      expect(droite(agenda.understood)).toContain(droite('aucun agenda n’est connecté'));
    }

    const suppression = moteur.propose('supprime cette note');
    expect(suppression.kind).toBe('UNSUPPORTED');
    if (suppression.kind === 'UNSUPPORTED') {
      // On lui dit le chemin qui MARCHE, au lieu de lui dire que rien ne marche.
      expect(suppression.understood).toContain('/annule');
    }
  });

  it('la PORTÉE reste à préciser — HIGH-4 n’est pas défait', () => {
    /* ⚠ LA PROPRIÉTÉ QU'ON A REFUSÉ DE PERDRE EN ÉLARGISSANT.

       Ajouter `web_search` et `file_search` rendait tentant d'accepter enfin
       « cherche X » — la formulation que les gens emploient. Ce serait rouvrir
       exactement HIGH-4 : deviner la portée, chercher ailleurs que là où
       l'utilisateur croyait, et annoncer un succès.

       Il y a désormais TROIS portées nommables au lieu d'une. La question
       posée doit donc les proposer toutes les trois — sinon on aurait remplacé
       un mensonge par une omission. */
    const p = moteur.propose('retrouve le devis du carreleur');
    expect(p.kind).toBe('CLARIFY');
    if (p.kind !== 'CLARIFY') return;
    expect(p.question).toContain('que sais-tu sur');
    expect(p.question).toContain('cherche sur le web');
    expect(p.question).toContain('cherche dans mes documents');
  });

  it('AUCUN message n’énumère les capacités à la main', () => {
    /* LA CAUSE, PAS LE SYMPTÔME. Corriger les six listes sans empêcher la
       septième aurait été une réparation à durée de vie limitée : la divergence
       serait revenue au prochain outil.

       On vérifie donc qu'aucune capacité connue n'est écrite en dur ailleurs
       que dans la règle qui la rend vraie. */
    const capacites = capacitesParlees();
    expect(capacites.length).toBeGreaterThan(5);

    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('capacitesParlees()');
    // L'ancienne aide énumérait les commandes en toutes lettres.
    expect(cli).not.toContain('ajoute <chose> à ma liste');

    /* ⚠ CHAQUE EXEMPLE N'APPARAÎT QUE DANS DES DÉCLARATIONS `exemple:`.

       La première version exigeait UNE occurrence, et elle avait tort deux
       fois : quatre règles servent « ajoute … à ma liste », deux servent
       « que sais-tu sur … ». Le nombre légitime n'est pas 1, c'est le nombre de
       règles qui la déclarent.

       Ce qu'on interdit, c'est l'occurrence qui n'est PAS une déclaration —
       c'est-à-dire un message qui recopie. Le test l'a trouvée : la question de
       portée citait trois capacités en toutes lettres. Elle les DÉRIVE
       désormais par identifiant de règle. */
    for (const capacite of capacites) {
      const total = SOURCE.split(capacite).length - 1;
      const declarations = SOURCE.split(`exemple: '${capacite}'`).length - 1;
      expect(
        total,
        `« ${capacite} » : ${String(total)} occurrences pour ${String(declarations)} déclarations — un message la recopie`,
      ).toBe(declarations);
    }
  });

  it('CONTRÔLE NÉGATIF — les capacités VRAIMENT absentes le restent', () => {
    /* L'élargissement ne doit pas avoir fabriqué de capacité. Ces trois-là
       n'ont aucun outil, et Jarvis doit continuer à le dire. */
    for (const phrase of [
      'envoie un mail à Paul',
      'allume le chauffage',
      'quelle est la météo demain',
    ]) {
      const p = moteur.propose(phrase);
      expect(p.kind, phrase).toBe('UNSUPPORTED');
      if (p.kind !== 'UNSUPPORTED') continue;
      expect(p.missing).toContain('pas encore construite');
    }
  });
});
