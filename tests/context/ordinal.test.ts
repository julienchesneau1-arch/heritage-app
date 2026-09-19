/**
 * « MARQUE LA PREMIÈRE COMME FAITE » — ADR-107.
 *
 * Le banc de fluidité mesurait `REFERENCE 0/8` : huit tours sur trente
 * désignent une chose sans la renommer, et aucun n'aboutissait. C'est ce qui
 * fait qu'une conversation est une conversation, et non une suite d'ordres.
 *
 * ⚠ LA PROPRIÉTÉ CENTRALE DE CE FICHIER n'est pas « l'ordinal marche ». C'est
 * que les TROIS façons dont il peut échouer produisent une QUESTION, jamais
 * une action sur une cible approchante :
 *
 * ```text
 * rien n'a été montré       → on demande
 * le genre ne correspond pas → on demande
 * la position n'existe pas   → on demande
 * ```
 *
 * `docs/05 §A2` : *« interdit : deviner si deux interprétations ont un impact
 * différent »*. Sur une suppression, l'impact d'une erreur est une chose
 * détruite à la place d'une autre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import { litUnOrdinal } from '../../src/core/context/ordinal.js';
import {
  enumerationDe,
  outilsEnumerants,
  type ElementEnumere,
} from '../../src/core/tools/enumeration.js';
import type {
  MemoireDAffichage,
  ResolutionOrdinale,
} from '../../src/core/context/affichage.js';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import { createAssistant, type AssistantDeps } from '../../src/core/assistant.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import { arretDouble } from '../helpers/arret.js';
import { undoDouble } from '../helpers/undo.js';
import { modePriveDouble } from '../helpers/mode-prive.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';

/* ====================================================================== *
 * 1. LIRE UNE POSITION — fonction pure
 * ====================================================================== */

describe('litUnOrdinal', () => {
  it.each([
    ['la première', 1],
    ['première', 1],
    ['le premier', 1],
    ['la deuxième', 2],
    ['la seconde', 2],
    ['la troisième', 3],
    ['la cinquième', 5],
    ['la 1re', 1],
    ['le 2e', 2],
    ['la 3', 3],
  ])('« %s » désigne le rang %i', (fragment, rang) => {
    expect(litUnOrdinal(fragment)).toEqual({ rang });
  });

  it('⚠ « la dernière » n’est PAS un rang', () => {
    /* Elle désigne une place relative à la FIN. La traduire en nombre ici
       demanderait de connaître la longueur de la liste — c'est-à-dire de
       savoir ce qu'il y a à cette position, ce que ce module refuse
       justement de savoir. */
    expect(litUnOrdinal('la dernière')).toEqual({ depuisLaFin: 1 });
    expect(litUnOrdinal('le dernier')).toEqual({ depuisLaFin: 1 });
  });

  it.each([
    'la note du carreleur',
    'le plombier',
    'ça',
    '',
    'la 0',
    'la zéroième',
    'premièrement',
  ])('⚠ « %s » n’est pas une position', (fragment) => {
    expect(litUnOrdinal(fragment)).toBeNull();
  });

  it('⚠ « la 0 » est refusé — ce n’est pas une position', () => {
    /* Le laisser passer produirait un index négatif au résolveur, c'est-à-dire
       un défaut qui ne se verrait qu'à l'usage, sur une liste réelle. */
    expect(litUnOrdinal('la 0')).toBeNull();
  });

  it('la fonction est PURE — aucune entrée-sortie', () => {
    const src = readFileSync('src/core/context/ordinal.ts', 'utf8');
    for (const interdit of ['await ', 'Promise', 'db.', 'query(']) {
      expect(src, `« ${interdit} » n’a rien à faire ici`).not.toContain(interdit);
    }
  });
});

/* ====================================================================== *
 * 2. CE QU'UNE SORTIE A ÉNUMÉRÉ
 * ====================================================================== */

describe('enumerationDe', () => {
  it('lit les tâches d’une liste, dans l’ordre affiché', () => {
    const sortie = enumerationDe('task_list', {
      tasks: [
        { id: 'a', title: 'appeler le plombier' },
        { id: 'b', title: 'commander le carrelage' },
      ],
    });
    expect(sortie).toEqual([
      { id: 'a', genre: 'TASK', libelle: 'appeler le plombier' },
      { id: 'b', genre: 'TASK', libelle: 'commander le carrelage' },
    ]);
  });

  it('lit les mémoires d’une recherche', () => {
    const sortie = enumerationDe('memory_search', {
      results: [{ id: 'm1', content: 'le compteur est au sous-sol' }],
    });
    expect(sortie[0]?.genre).toBe('MEMORY');
  });

  it('⚠ un élément SANS identité n’est pas énuméré — sinon tout se décale', () => {
    /* Le compter quand même ferait de « la deuxième » la troisième ligne
       affichée. Un décalage silencieux sur une suppression est exactement le
       défaut qu'on ne veut pas. */
    const sortie = enumerationDe('task_list', {
      tasks: [{ title: 'sans identité' }, { id: 'b', title: 'la vraie première' }],
    });
    expect(sortie).toHaveLength(1);
    expect(sortie[0]?.id).toBe('b');
  });

  it('un outil qui ne montre pas de liste rend un tableau VIDE', () => {
    expect(enumerationDe('note_create', { noteId: 'x' })).toEqual([]);
    expect(enumerationDe('outil_inconnu', { quoi: 1 })).toEqual([]);
  });

  it('une sortie malformée ne fait pas planter la lecture', () => {
    expect(enumerationDe('task_list', null)).toEqual([]);
    expect(enumerationDe('task_list', { tasks: 'pas un tableau' })).toEqual([]);
  });

  it('⚠ le vocabulaire des genres est celui de `GenreDesigne`', () => {
    /* Une seconde énumération de « sortes de choses qu'on peut désigner »
       finirait par diverger (ADR-041), et la divergence se lirait à l'endroit
       le plus coûteux : un ordinal appliqué au mauvais genre. */
    const designation = readFileSync('src/core/context/designation.ts', 'utf8');
    const enumeration = readFileSync('src/core/tools/enumeration.ts', 'utf8');
    expect(enumeration).toContain("from '../context/designation.js'");
    expect(designation).toContain("z.enum(['TASK', 'NOTE', 'MEMORY', 'REMINDER'])");
  });

  it('⚠ `calendar_read` est ABSENT, et c’est déclaré', () => {
    /* Ses événements ne sont pas un `GenreDesigne` : `calendar_update` attend
       un `eventId` qui vit chez Google. Une absence nommée vaut mieux qu'une
       énumération que la moitié du système ignore. */
    expect(outilsEnumerants()).not.toContain('calendar_read');
    expect(enumerationDe('calendar_read', { events: [{ id: 'e1' }] })).toEqual([]);
  });
});

/* ====================================================================== *
 * 3. LES RÈGLES — et l'ORDRE, qui est la correction
 * ====================================================================== */

describe('les règles d’intention ordinales', () => {
  const moteur = createIntentEngine();

  it.each([
    'marque la première comme faite',
    'termine la première',
    'coche la deuxième',
    'valide la dernière',
  ])('« %s » vise task_complete par ORDINAL', (phrase) => {
    const p = moteur.propose(phrase);
    expect(p.kind).toBe('TOOL_CALL');
    if (p.kind !== 'TOOL_CALL') return;
    expect(p.toolId).toBe('task_complete');
    expect(p.referents['taskId']).toBe('ORDINAL:TASK');
  });

  it.each(['supprime la deuxième', 'annule la troisième', 'retire la dernière'])(
    '« %s » vise task_cancel par ORDINAL',
    (phrase) => {
      const p = moteur.propose(phrase);
      expect(p.kind).toBe('TOOL_CALL');
      if (p.kind !== 'TOOL_CALL') return;
      expect(p.toolId).toBe('task_cancel');
      expect(p.referents['taskId']).toBe('ORDINAL:TASK');
    },
  );

  it('⚠ L’ORDRE — une tâche NOMMÉE reste une DÉSIGNATION', () => {
    /* C'est la correction elle-même. Sans la priorité, « marque la première
       comme faite » tombait sur la règle désignée, qui cherchait une tâche
       INTITULÉE « première » — ne la trouvait pas, et demandait à côté.

       Le contrôle inverse compte autant : une cible nommée ne doit PAS devenir
       un ordinal. */
    const p = moteur.propose('termine la tâche du plombier');
    expect(p.kind).toBe('TOOL_CALL');
    if (p.kind !== 'TOOL_CALL') return;
    expect(p.referents['taskId']).toBe('DESIGNATION:TASK');
  });

  it('⚠ « annule » seul reste une ANNULATION, pas un ordinal', () => {
    /* La règle ordinale exige une position ; « annule » sans complément est
       l'Undo Engine (ADR-105), intercepté avant le moteur. */
    const p = moteur.propose('annule');
    expect(p.kind === 'TOOL_CALL' && p.toolId === 'task_cancel').toBe(false);
  });
});

/* ====================================================================== *
 * 4. LA RÉSOLUTION — trois échecs, trois QUESTIONS
 * ====================================================================== */

function memoire(resolution: ResolutionOrdinale): MemoireDAffichage {
  return {
    retenir: () => Promise.resolve(ok(undefined)),
    resoudre: () => Promise.resolve(ok(resolution)),
  };
}

function assistantAvec(
  affichage: MemoireDAffichage | null,
  calls: ToolCall[] = [],
) {
  const deps: AssistantDeps = {
    arret: arretDouble(),
    undo: undoDouble(),
    modePrive: modePriveDouble(),
    affichage,
    intent: createIntentEngine(),
    gateway: {
      register: () => ok(undefined),
      list: () => [],
      restoreTrust: () => Promise.resolve(ok(undefined)),
      invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
        calls.push(call);
        return Promise.resolve(err(jarvisError('INTERNAL', 'pas d’outil ici')));
      },
    } as unknown as ToolGateway,
    setGuardConfirmed: () => undefined,
    cloudEnabled: false,
    resolver: {
      resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
    },
    designation: {
      resoudre: () => Promise.resolve(ok({ kind: 'INTROUVABLE' as const, mention: 'x' })),
    },
    file: null,
    temps: {
      resoudre: () => Promise.resolve(ok({ iso: '2026-09-19T09:00:00Z', humain: 'j' })),
      resoudreFenetre: () =>
        Promise.resolve(
          ok({ debutIso: '2026-09-19T00:00:00Z', finIso: '2026-09-20T00:00:00Z', humain: 'j' }),
        ),
    },
    tier1: null,
  };
  return createAssistant(deps);
}

const ELEMENT: ElementEnumere = {
  id: '11111111-1111-4111-8111-111111111111',
  genre: 'TASK',
  libelle: 'appeler le plombier',
};

describe('⚠ un ordinal qui ne se résout pas DEMANDE', () => {
  it('rien montré → question, et AUCUN outil invoqué', async () => {
    const calls: ToolCall[] = [];
    const r = await assistantAvec(memoire({ kind: 'RIEN_MONTRE' }), calls).say(
      'marque la première comme faite',
      { surface: 'LOCALE', sessionId: 'S1' },
    );
    expect(r.kind).toBe('CLARIFY');
    if (r.kind !== 'CLARIFY') return;
    expect(r.question).toContain('aucune liste');
    expect(calls, 'rien ne doit être tenté').toEqual([]);
  });

  it('⚠ mauvais genre → question, et on ne CONVERTIT pas', async () => {
    /* La dernière liste n'est pas du genre demandé. Appliquer quand même
       l'ordinal agirait sur autre chose que ce que l'utilisateur désignait —
       une action réelle, sur la mauvaise cible. */
    const calls: ToolCall[] = [];
    const r = await assistantAvec(
      memoire({ kind: 'MAUVAIS_GENRE', montre: 'MEMORY', attendu: 'TASK' }),
      calls,
    ).say('supprime la deuxième', { surface: 'LOCALE', sessionId: 'S1' });
    expect(r.kind).toBe('CLARIFY');
    if (r.kind !== 'CLARIFY') return;
    /* ⚠ LA QUESTION PARLE FRANÇAIS. « TASK » apprendrait à l'utilisateur le
       vocabulaire interne du système. */
    expect(r.question).toContain('tâches');
    expect(r.question).not.toContain('TASK');
    expect(calls).toEqual([]);
  });

  it('position hors liste → question qui DIT la taille', async () => {
    const r = await assistantAvec(memoire({ kind: 'HORS_LISTE', taille: 2 })).say(
      'termine la cinquième',
      { surface: 'LOCALE', sessionId: 'S1' },
    );
    expect(r.kind).toBe('CLARIFY');
    if (r.kind !== 'CLARIFY') return;
    expect(r.question).toContain('2');
  });

  it('⚠ sans session, un ordinal DEMANDE — il n’y a pas d’écran', async () => {
    const r = await assistantAvec(memoire({ kind: 'RESOLU', element: ELEMENT })).say(
      'marque la première comme faite',
      { surface: 'LOCALE' },
    );
    expect(r.kind).toBe('CLARIFY');
  });

  it('⚠ sans mémoire d’affichage non plus — `null` est un état déclaré', async () => {
    const r = await assistantAvec(null).say('marque la première comme faite', {
      surface: 'LOCALE',
      sessionId: 'S1',
    });
    expect(r.kind).toBe('CLARIFY');
  });

  it('CONTRÔLE — résolu, l’identité remplace la position', async () => {
    /* Sans lui, les cinq assertions ci-dessus seraient vraies dans un système
       où aucun ordinal ne se résout jamais. */
    const calls: ToolCall[] = [];
    await assistantAvec(memoire({ kind: 'RESOLU', element: ELEMENT }), calls).say(
      'marque la première comme faite',
      { surface: 'LOCALE', sessionId: 'S1' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ taskId: ELEMENT.id });
  });
});

/* ====================================================================== *
 * 5. SUR LA BOUCLE RÉELLE — c'est la BONNE ligne qui est touchée
 * ====================================================================== */

/**
 * ⚠ LES QUATRE BLOCS CI-DESSUS TIENNENT LA FORME. Celui-ci tient le FOND : que
 * « la première » désigne bien la ligne affichée en premier, et pas une autre.
 *
 * C'est la seule assertion qui aurait attrapé une erreur d'index, un tri
 * différent entre l'affichage et la mémorisation, ou un genre mal posé.
 */
describe.skipIf(!databaseAvailable())('⚠ « la première » touche la PREMIÈRE ligne', () => {
  let runtime: Runtime;
  let sessionId: string;
  const T = `ord-${String(Date.now())}`;

  beforeAll(async () => {
    const built = buildRuntime(appDb());
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;
    const s = await runtime.sessions.start('NORMAL');
    if (!s.ok) throw new Error(s.error.message);
    sessionId = s.value.id;
  });

  afterAll(async () => {
    await runtime.close();
  });

  it('liste puis « marque la première comme faite » → la bonne tâche', async () => {
    await runtime.assistant.say(`ajoute ${T}-alpha à ma liste`, {
      surface: 'LOCALE',
      sessionId,
    });
    await runtime.assistant.say(`ajoute ${T}-beta à ma liste`, {
      surface: 'LOCALE',
      sessionId,
    });

    const liste = await runtime.assistant.say('mes tâches', {
      surface: 'LOCALE',
      sessionId,
    });
    expect(liste.kind).toBe('DONE');
    if (liste.kind !== 'DONE') return;

    /* CE QUI A ÉTÉ AFFICHÉ EN PREMIER, lu depuis la sortie réelle de l'outil —
       pas supposé. `task_list` trie par date de création décroissante, donc
       `beta` vient en tête ; l'écrire en dur ici ferait passer le test pour la
       mauvaise raison le jour où le tri changerait. */
    const montrees = enumerationDe('task_list', liste.output);
    const premiere = montrees[0];
    expect(premiere, 'la liste doit contenir au moins une tâche').toBeDefined();
    if (premiere === undefined) return;

    const faite = await runtime.assistant.say('marque la première comme faite', {
      surface: 'LOCALE',
      sessionId,
    });
    expect(faite.kind).toBe('DONE');
    if (faite.kind !== 'DONE') return;
    expect(faite.toolId).toBe('task_complete');
    /* ⚠ L'ASSERTION QUI PORTE TOUT : la tâche terminée est celle qui était en
       TÊTE DE L'AFFICHAGE, pas la plus ancienne, pas une autre. */
    expect(faite.detail).toContain(premiere.libelle);
  });

  it('⚠ après une recherche MÉMOIRE NON VIDE, « supprime la deuxième » DEMANDE', async () => {
    /* ⚠ CE TEST A ÉTÉ ÉCRIT DEUX FOIS, ET LA PREMIÈRE VERSION ÉTAIT VERTE POUR
       LA MAUVAISE RAISON.

       Elle cherchait un terme qui ne trouvait rien : l'affichage était donc
       VIDE, la réponse `RIEN_MONTRE`, et la garde de GENRE n'était jamais
       exercée. Mesuré par sabotage — en neutralisant `genre !== genreAttendu`,
       les quarante-cinq tests restaient verts.

       Il faut donc une recherche qui TROUVE : c'est seulement là que le
       dernier affichage est une liste de MÉMOIRES, et que l'ordinal doit être
       refusé plutôt qu'appliqué à une tâche que l'utilisateur ne regarde
       pas. */
    const retenu = await runtime.assistant.say(
      `retiens que ${T} le compteur est au sous-sol`,
      { surface: 'LOCALE', sessionId },
    );
    expect(retenu.kind).toBe('DONE');

    const cherche = await runtime.assistant.say(`que sais-tu sur ${T}`, {
      surface: 'LOCALE',
      sessionId,
    });
    expect(cherche.kind).toBe('DONE');
    if (cherche.kind !== 'DONE') return;
    const memoires = enumerationDe('memory_search', cherche.output);
    expect(
      memoires.length,
      'la recherche doit TROUVER, sinon ce test ne prouve rien',
    ).toBeGreaterThan(0);
    expect(memoires[0]?.genre).toBe('MEMORY');

    const r = await runtime.assistant.say('supprime la deuxième', {
      surface: 'LOCALE',
      sessionId,
    });
    expect(r.kind, 'jamais une suppression — une question').toBe('CLARIFY');
    if (r.kind !== 'CLARIFY') return;
    /* La question NOMME ce qu'on attendait, en français : c'est ce qui permet
       à l'utilisateur de comprendre qu'il doit redemander sa liste. */
    expect(r.question).toContain('tâches');
  });

  it('⚠ une liste VIDE efface l’affichage précédent', async () => {
    /* Sinon « la première » continuerait de désigner la liste d'avant, que
       l'utilisateur ne voit plus à l'écran. */
    const vide = await runtime.assistant.say(`que sais-tu sur ${T}-rien-du-tout`, {
      surface: 'LOCALE',
      sessionId,
    });
    expect(vide.kind).toBe('DONE');
    if (vide.kind !== 'DONE') return;
    expect(
      enumerationDe('memory_search', vide.output),
      'cette recherche doit ne RIEN trouver, sinon le test ne prouve rien',
    ).toEqual([]);

    const apres = await runtime.assistant.say('marque la première comme faite', {
      surface: 'LOCALE',
      sessionId,
    });
    expect(apres.kind).toBe('CLARIFY');
  });
});
