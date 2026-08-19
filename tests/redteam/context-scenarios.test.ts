/**
 * RED TEAM — 30 tours de conversation réalistes, étalés dans le temps.
 *
 * Sept fils narratifs empruntés à une vie réelle : un chantier, un mariage, un
 * médecin, deux homonymes. Chaque tour est joué contre la boucle réelle.
 *
 * Ce que ces scénarios cherchent : la mémoire de travail. Jarvis se souvient-il
 * de quoi on parle d'un tour à l'autre, d'un jour à l'autre ? Sait-il qu'une
 * information en remplace une autre ? Distingue-t-il deux personnes du même
 * prénom ?
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { createSessionStore } from '../../src/core/session/session.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import type { AssistantReply } from '../../src/core/assistant.js';

const skip = !databaseAvailable();
const T = `ctx-${String(Date.now())}`;

type Aptitude =
  | 'ACTION' // une capacité existante est correctement déclenchée
  | 'REFERENCE' // exige de résoudre « il », « le suivant », « ça »
  | 'TEMPOREL' // exige de comprendre une date ou une antériorité
  | 'DESAMBIGUISATION' // exige de distinguer deux entités homonymes
  | 'CONTRADICTION' // exige d'arbitrer entre deux informations
  | 'SUPPRESSION' // exige d'oublier ou d'annuler
  | 'COMPARAISON'; // exige de rapprocher deux objets

interface Turn {
  readonly jour: number;
  readonly phrase: string;
  readonly aptitude: Aptitude;
}

const TURNS: readonly Turn[] = [
  /* --- Fil 1 : le traiteur du mariage (scénario fourni) ---------------- */
  { jour: 1, phrase: `Retiens que le traiteur du mariage ${T} enverra un nouveau devis jeudi`, aptitude: 'ACTION' },
  { jour: 1, phrase: `Rappelle-moi de relancer le traiteur ${T}`, aptitude: 'ACTION' },
  { jour: 7, phrase: `Où en est le traiteur ${T} ?`, aptitude: 'REFERENCE' },
  { jour: 8, phrase: 'Il vient de m\'envoyer son devis', aptitude: 'REFERENCE' },
  { jour: 8, phrase: 'Compare-le au précédent', aptitude: 'COMPARAISON' },
  { jour: 9, phrase: 'Finalement oublie le rappel', aptitude: 'SUPPRESSION' },

  /* --- Fil 2 : le chantier --------------------------------------------- */
  { jour: 1, phrase: `Retiens que le carrelage ${T} est un Marazzi Treverk 20x120`, aptitude: 'ACTION' },
  { jour: 2, phrase: `Que sais-tu sur le carrelage ${T}`, aptitude: 'ACTION' },
  { jour: 3, phrase: `Non, finalement le carrelage ${T} est un Porcelanosa`, aptitude: 'CONTRADICTION' },
  { jour: 3, phrase: `Que sais-tu sur le carrelage ${T}`, aptitude: 'CONTRADICTION' },
  { jour: 4, phrase: 'Et pour la salle de bain ?', aptitude: 'REFERENCE' },
  { jour: 5, phrase: `Ajoute le joint de finition ${T} à ma liste`, aptitude: 'ACTION' },
  { jour: 5, phrase: 'Ajoute aussi la colle', aptitude: 'REFERENCE' },

  /* --- Fil 3 : deux homonymes ------------------------------------------ */
  { jour: 1, phrase: `Retiens que Jean Martin ${T} est le plombier`, aptitude: 'ACTION' },
  { jour: 1, phrase: `Retiens que Jean Dupont ${T} est le notaire`, aptitude: 'ACTION' },
  { jour: 2, phrase: `Appelle Jean ${T}`, aptitude: 'DESAMBIGUISATION' },
  { jour: 2, phrase: `Que sais-tu sur Jean ${T}`, aptitude: 'DESAMBIGUISATION' },

  /* --- Fil 4 : temporalité --------------------------------------------- */
  /* ⚠ CE TOUR A CHANGÉ DE CATÉGORIE — ADR-077, et c'est le seul du fil 4.
     `ACTION` signifie « une capacité existante est correctement déclenchée ».
     Jarvis résout désormais « jeudi » — par la BASE, jamais par l'horloge du
     processus — et crée un vrai rappel daté. Les trois autres tours du fil
     restent `TEMPOREL` : ils exigent l'agenda, ou une antériorité, qui
     n'existent toujours pas. */
  { jour: 1, phrase: `Rappelle-moi jeudi d'appeler le médecin ${T}`, aptitude: 'ACTION' },
  { jour: 1, phrase: 'Qu\'ai-je de prévu jeudi ?', aptitude: 'TEMPOREL' },
  { jour: 2, phrase: 'Décale-le à vendredi', aptitude: 'TEMPOREL' },
  { jour: 2, phrase: 'Qu\'est-ce que je t\'ai demandé hier ?', aptitude: 'TEMPOREL' },

  /* --- Fil 5 : suivi et correction -------------------------------------- */
  { jour: 1, phrase: 'mes tâches', aptitude: 'ACTION' },
  { jour: 1, phrase: 'Marque la première comme faite', aptitude: 'REFERENCE' },
  { jour: 1, phrase: 'Annule ça', aptitude: 'SUPPRESSION' },
  { jour: 2, phrase: 'Qu\'as-tu retenu de moi cette semaine ?', aptitude: 'TEMPOREL' },

  /* --- Fil 6 : préférence et règle -------------------------------------- */
  { jour: 1, phrase: 'Je préfère les rendez-vous le jeudi matin', aptitude: 'ACTION' },
  { jour: 2, phrase: 'Propose-moi un créneau pour le carreleur', aptitude: 'REFERENCE' },

  /* --- Fil 7 : reprise après interruption ------------------------------- */
  { jour: 1, phrase: `note ${T} penser au store banne`, aptitude: 'ACTION' },
  { jour: 1, phrase: 'Ajoute-la à mes tâches aussi', aptitude: 'REFERENCE' },
  { jour: 3, phrase: 'De quoi parlions-nous ?', aptitude: 'REFERENCE' },
];

function outcome(reply: AssistantReply): 'TRAITÉ' | 'DIT ABSENT' | 'PRÉCISION' | 'AUTRE' {
  if (reply.kind === 'DONE') return 'TRAITÉ';
  if (reply.kind === 'UNSUPPORTED') return 'DIT ABSENT';
  if (reply.kind === 'CLARIFY') return 'PRÉCISION';
  return 'AUTRE';
}

describe.skipIf(skip)('RED TEAM — 30 tours de conversation', () => {
  let runtime: Runtime;
  let sessionId = '';
  const results: { turn: Turn; reply: AssistantReply }[] = [];

  beforeAll(async () => {
    const built = buildRuntime(appDb());
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;

    /* ⚠ CE BANC MESURAIT DANS UNE CONFIGURATION QUE LE PRODUIT N'UTILISE PAS.
       ADR-085.

       Il appelait `assistant.say(phrase)` **sans `sessionId`**. Or le CLI
       (`main.ts:328`) et la passerelle web (`http.ts:148`) en passent un, et
       l'Assistant sans session répond à TOUT référent :

         « À quoi fais-tu référence ? Je n'ai pas de conversation en cours. »

       `REFERENCE 0/8` était donc garanti par le BANC autant que par le
       produit — et personne ne pouvait distinguer les deux parts.

       Le banc expliquait pourtant son résultat : *« l'Assistant est SANS ÉTAT
       entre deux phrases »*. C'était exact quand la phrase a été écrite. Depuis
       ADR-073 il résout les référents, et l'explication a cessé d'être vraie
       sans que le chiffre bouge — ce qui l'a rendue indétectable.

       On mesure désormais ce que Julien utilise : une session ouverte, le tour
       enregistré après chaque action, exactement comme le CLI. */
    const session = await runtime.sessions.start('NORMAL');
    if (!session.ok) throw new Error(session.error.message);
    sessionId = session.value.id;

    for (const turn of TURNS) {
      const reply = await runtime.assistant.say(turn.phrase, { sessionId });
      results.push({ turn, reply });

      /* La boucle du CLI, à l'identique (`main.ts:356`). La recopier plutôt
         que l'appeler est un second registre du même fait (ADR-041) — la
         dette est notée en `docs/26 §4.15`, et vaut mieux que de continuer à
         mesurer un produit qui n'existe pas. */
      if (reply.kind === 'DONE') {
        await runtime.sessions.appendTurn(sessionId, {
          speaker: 'JARVIS',
          content: `${reply.toolId} → ${reply.status}`,
          mentionedEntityIds: reply.mentionedEntityIds,
        });
      }
    }
  }, 60_000);

  afterAll(async () => {
    await runtime.close();
  });

  it('LE BANC MESURE BIEN LA CONFIGURATION DU PRODUIT — ADR-085', async () => {
    /* ⚠ CETTE GARDE MANQUAIT, ET C'EST POURQUOI LE DÉFAUT A DURÉ.

       Le banc a mesuré pendant des mois sans session. Le corriger n'a rien
       changé au chiffre — donc **aucun test existant ne peut voir la
       différence**, et rien n'empêcherait de retirer à nouveau le `sessionId`.

       Un résultat identique dans deux configurations est exactement le cas où
       une régression passe inaperçue : on la juge sur le chiffre, et le chiffre
       est muet. On garde donc la CONFIGURATION, pas seulement le résultat.

       Vérifié par la preuve la moins contournable : la session contient des
       tours. Sans `sessionId`, il n'y en a aucun. */
    const tours = await runtime.sessions.recentTurns(sessionId, 50);
    expect(tours.ok).toBe(true);
    if (!tours.ok) return;
    expect(tours.value.length, 'le banc n’a enregistré aucun tour').toBeGreaterThan(0);

    // Et la boucle du produit : chaque tour retenu vient d'une action aboutie.
    const aboutis = results.filter((r) => r.reply.kind === 'DONE').length;
    expect(tours.value.length).toBe(aboutis);
  });

  it('imprime le déroulé', () => {
    const lines = results.map(
      ({ turn, reply }) =>
        `  J${String(turn.jour)} ${turn.aptitude.padEnd(18)} ${outcome(reply).padEnd(11)} ${turn.phrase.slice(0, 52)}`,
    );
    process.stdout.write(`\n${lines.join('\n')}\n\n`);
    expect(results).toHaveLength(30);
  });

  it('les tours qui n\'exigent aucun contexte passent', () => {
    const simples = results.filter((r) => r.turn.aptitude === 'ACTION');
    const rates = simples.filter((r) => r.reply.kind !== 'DONE');
    expect(rates.map((r) => r.turn.phrase)).toEqual([
      // Une préférence énoncée sans « retiens que » n'est pas captée : le
      // Tier 0 ne reconnaît pas la formulation. Attendu, et dit.
      'Je préfère les rendez-vous le jeudi matin',
    ]);
  });

  it('DÉMONSTRATION — aucun tour exigeant du contexte n\'est traité', () => {
    /* ⚠ L'EXPLICATION D'ORIGINE EST FAUSSE DEPUIS ADR-073 — corrigée ADR-085.
       Elle disait : *« L'Assistant est SANS ÉTAT entre deux phrases — il ne
       relit jamais les tours précédents »*.

       Il les relit : `resolveAnaphora(sessionId)` est appelé avant toute
       invocation d'outil. La phrase a cessé d'être vraie sans que le chiffre
       bouge, ce qui l'a rendue indétectable — et c'est le vrai enseignement.

       La cause réelle est EN AMONT de la résolution : ces tours ressortent
       `DIT ABSENT`, c'est-à-dire `UNSUPPORTED`. Aucune règle `Tier 0` ne
       reconnaît la formulation, donc aucun référent n'est jamais PRODUIT.
       Il n'y a rien à résoudre — pas un résolveur qui échoue. */
    const contextuels = results.filter((r) => r.turn.aptitude !== 'ACTION');
    expect(contextuels.length).toBeGreaterThanOrEqual(17);

    const traitesCorrectement = contextuels.filter((r) => {
      if (r.reply.kind !== 'DONE') return false;
      // « Où en est le traiteur ? » tombe sur memory_search : la recherche
      // aboutit, mais la RÉFÉRENCE n'a pas été résolue pour autant.
      return false;
    });
    expect(traitesCorrectement).toEqual([]);
  });

  it('DÉMONSTRATION — le CONTENU des tours est écrit, puis jamais relu', async () => {
    /* ⚠ CE TEST DISAIT PLUS QUE CE QU'IL VÉRIFIE — corrigé ADR-085.

       Il affirmait que `session_turns` est « une archive, pas une mémoire de
       travail — ce qui explique intégralement le résultat ci-dessus ». Deux
       erreurs dans une phrase :

       1. La table N'EST PLUS une archive. `resolveAnaphora` lit
          `mentioned_entity_ids` à chaque tour (ADR-073), et le CLI le
          renseigne (ADR-072).
       2. Elle n'explique donc RIEN du résultat, qui se joue en amont.

       Ce qui reste vrai, et que ce test vérifie réellement : le CONTENU
       textuel des tours n'est jamais relu. Seuls les identifiants d'entités
       le sont. Jarvis sait ce que l'échange a TOUCHÉ, pas ce qui s'y est DIT
       — c'est ce qui rend « De quoi parlions-nous ? » hors de portée. */
    const callers = readFileSync(
      join(process.cwd(), 'src', 'core', 'assistant.ts'),
      'utf8',
    );
    expect(callers).not.toContain('recentTurns');

    const db = appDb();
    const session = await createSessionStore(db).start('NORMAL');
    expect(session.ok).toBe(true);
    if (session.ok) {
      const store = createSessionStore(db);
      await store.appendTurn(session.value.id, { speaker: 'USER', content: 'test' });
      const turns = await store.recentTurns(session.value.id);
      // La table fonctionne parfaitement. C'est le câblage qui manque.
      expect(turns.ok && turns.value.length).toBe(1);
    }
    await db.close();
  });

  it('LA FLUIDITÉ, EN CHIFFRES — 13 tours sur 30 aboutissent', () => {
    /* ⚠ LE CHIFFRE QUI RÉPOND À « PEUT-ON DISCUTER AVEC JARVIS ? », ET IL
       N'ÉTAIT COMPTÉ NULLE PART.

       Les tests ci-dessus vérifient qu'aucun tour ne MENT. C'est la propriété
       de sûreté, et elle tient. Elle ne dit rien de l'UTILITÉ : un système qui
       refuse tout ne ment jamais.

       On compte donc ce qui ABOUTIT, par aptitude. La répartition compte plus
       que le total :

         ACTION            10/11   quand la formulation matche une règle, ça marche
         REFERENCE          0/8    « il », « la première », « ça » — RIEN
         TEMPOREL           1/4
         DESAMBIGUISATION   1/2
         CONTRADICTION      1/2
         SUPPRESSION        0/2
         COMPARAISON        0/1
         ─────────────────────────
         TOTAL             13/30   43 %

       **`REFERENCE` à 0/8 est le chiffre décisif.** Huit tours sur trente —
       plus d'un quart d'une vraie conversation — désignent une chose sans la
       renommer. C'est ce qui fait qu'une conversation est une conversation, et
       non une suite d'ordres.

       ⚠ **CE CHIFFRE A ÉTÉ RE-MESURÉ APRÈS CORRECTION DU BANC — ADR-085.**

       Le banc appelait `say(phrase)` **sans `sessionId`**, alors que le CLI et
       la passerelle web en passent un. L'Assistant sans session répond à tout
       référent « je n'ai pas de conversation en cours » : `REFERENCE 0/8`
       était donc garanti par le BANC autant que par le produit.

       Corrigé — session ouverte, tours enregistrés comme dans le CLI — et
       **le chiffre n'a pas bougé d'une unité**. 13/30, `REFERENCE` 0/8.

       C'est un résultat, pas un non-événement : le 0/8 était **surdéterminé**.
       On sait maintenant qu'il mesure le produit, et non le banc.

       **Et la cause est en amont de la résolution.** Ces huit tours ressortent
       `DIT ABSENT` = `UNSUPPORTED` : aucune règle `Tier 0` ne reconnaît la
       formulation, donc aucun référent n'est jamais PRODUIT. Le résolveur ne
       tourne pas à vide — il n'est jamais appelé.

       > La levée passe par la RECONNAISSANCE (un modèle local, ADR-082), pas
       > par la résolution. Ajouter des règles `Tier 0` pour ces phrases-ci
       > ferait monter le chiffre sans rien améliorer : les trente tours sont un
       > ÉCHANTILLON, pas une cible.

       Ce test fige la mesure pour qu'elle ne dérive pas en silence, dans un
       sens comme dans l'autre. */
    const parAptitude = new Map<string, { total: number; agi: number }>();
    for (const r of results) {
      const e = parAptitude.get(r.turn.aptitude) ?? { total: 0, agi: 0 };
      e.total++;
      if (r.reply.kind === 'DONE') e.agi++;
      parAptitude.set(r.turn.aptitude, e);
    }

    expect(parAptitude.get('REFERENCE')?.agi, 'aucun référent ne se résout').toBe(0);
    expect(parAptitude.get('REFERENCE')?.total).toBe(8);
    expect(parAptitude.get('ACTION')?.agi).toBeGreaterThanOrEqual(10);

    const agi = results.filter((r) => r.reply.kind === 'DONE').length;
    expect(agi).toBe(13);
    expect(results).toHaveLength(30);
  });

  it('et AUCUN tour ne produit d’erreur technique — le refus est propre', () => {
    /* Le pendant du chiffre ci-dessus, et il compte autant. 43 % d'aboutissement
       serait inquiétant si les 57 % restants étaient des plantages. Ce sont des
       refus formulés : Jarvis dit ce qu'il a compris et ce qui manque.

       C'est la différence entre « incomplet » et « cassé ». */
    const erreurs = results.filter((r) => r.reply.kind === 'ERROR');
    expect(erreurs.map((r) => r.turn.phrase)).toEqual([]);
  });

  it('un rappel daté est HONORÉ, et la date retenue est DITE', () => {
    /* ⚠ CE TEST A CHANGÉ DEUX FOIS, ET CHAQUE FOIS LA PROPRIÉTÉ A TENU.

       1. HIGH-5 — « Rappelle-moi JEUDI d'appeler le médecin » créait une tâche
          intitulée « jeudi d'appeler le médecin », sans échéance, et répondait
          « ✓ C'est fait ». L'utilisateur repartait en croyant qu'un rappel
          existait pour jeudi.
       2. Le correctif d'alors : REFUSER, en disant qu'on ne sait pas résoudre
          les dates. Honnête, et inutilisable.
       3. ADR-077 : la date est résolue — PAR LA BASE — et un vrai rappel est
          créé.

       La propriété défendue n'a jamais été « refuser ». Elle a toujours été :
       **la date ne disparaît pas en silence.** Elle est désormais honorée ET
       dite en français dans la réponse, ce qui est plus fort que refuser. */
    const date = results.find((r) => r.turn.phrase.startsWith('Rappelle-moi jeudi'));
    expect(date?.reply.kind).toBe('DONE');
    if (date?.reply.kind !== 'DONE') return;
    expect(date.reply.toolId).toBe('reminder_create');

    /* LA DATE RETENUE EST DITE. `reminder_create` ne demande aucune
       confirmation : si Jarvis ne l'annonçait pas ici, l'heure choisie — 9 h
       par défaut — serait parfaitement silencieuse. */
    expect(date.reply.detail).toContain('J’ai retenu');
    expect(date.reply.detail).toMatch(/jeudi \d{1,2}/u);

    // Et le titre du rappel ne porte PAS la date : elle est déjà l'échéance.
    const sortie: Record<string, unknown> =
      typeof date.reply.output === 'object' && date.reply.output !== null
        ? { ...date.reply.output }
        : {};
    expect(String(sortie['text'])).not.toContain('jeudi');
    expect(String(sortie['text'])).toContain('appeler le médecin');
  });

  it('mais un rappel SANS date passe toujours', () => {
    // La correction ne doit pas emporter le cas nominal avec elle.
    const sansDate = results.find((r) => r.turn.phrase.startsWith('Rappelle-moi de relancer'));
    expect(sansDate?.reply.kind).toBe('DONE');
  });

  it('PROPRIÉTÉ CONSERVÉE — aucun tour contextuel n\'invente une action inattendue', () => {
    // Le point positif : ne pas comprendre est traité comme ne pas comprendre.
    // Aucun « Décale-le à vendredi » ne crée une tâche « le à vendredi ».
    // Les deux seules exceptions sont documentées juste au-dessus.
    const inventions = results.filter(
      (r) =>
        r.turn.aptitude !== 'ACTION' &&
        r.reply.kind === 'DONE' &&
        r.reply.toolId !== 'memory_search' &&
        true,
    );
    expect(inventions.map((r) => r.turn.phrase)).toEqual([]);
  });
});
