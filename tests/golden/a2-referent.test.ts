/**
 * 05/A2 — RÉFÉRENCE CONTEXTUELLE, au niveau PRODUIT. ADR-073.
 *
 * ```
 * État     : une note vient d'être évoquée.
 * Entrée   : « Ajoute ça à mes tâches. »
 * Attendu  : Jarvis résout le référent depuis le contexte récent.
 * Interdit : deviner si deux interprétations ont un impact différent.
 * ```
 *
 * TROIS BLOCAGES SUCCESSIFS, TOUS TOMBÉS
 * ---------------------------------------------------------------------------
 * ```text
 * 1. « Context Engine hors circuit »       → mauvais diagnostic (docs/26 §4.12)
 * 2. rien ne peuple `entities`             → ADR-071
 * 3. aucun appelant n'évoque d'entité      → ADR-072
 * 4. aucune règle Tier 0 n'atteint l'outil → ADR-073
 * ```
 *
 * CE QUI A ÉTÉ REFUSÉ EN CHEMIN
 * -----------------------------
 * Rendre `propose()` asynchrone pour lui donner la base. C'eût été la voie
 * courte, et elle coûtait une propriété : `propose(text)` est une fonction
 * **pure** du texte — déterministe, éprouvable sans base, incapable d'échouer
 * pour une raison d'infrastructure. La résolution vit donc dans l'Assistant,
 * qui est déjà asynchrone et orchestre déjà.
 *
 * ⚠ L'INTERDIT EST LA MOITIÉ DU SCÉNARIO, et il est éprouvé autant que
 *   l'attendu : trois chemins mènent à une QUESTION, un seul agit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe.runIf(enabled)('05/A2 — « ajoute ça à ma liste »', () => {
  let runtime: Runtime;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    const built = buildRuntime(db);
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;
  });

  afterAll(async () => {
    await db.close();
  });

  /** Ouvre une conversation neuve : chaque test a son contexte récent. */
  async function conversation(): Promise<string> {
    const session = await runtime.sessions.start('NORMAL');
    if (!session.ok) throw new Error(session.error.message);
    return session.value.id;
  }

  it('05/A2 — l’ATTENDU : le référent est résolu depuis le contexte récent', async () => {
    /* LA BOUCLE COMPLÈTE, par la seule surface que l'utilisateur a : du texte.
       Aucun appel direct à la passerelle, aucun identifiant fabriqué à la main. */
    const sessionId = await conversation();
    const nom = `Compte rendu du ${suffixe()}`;

    // 1. L'utilisateur NOMME une entité. Aucune extraction : il le déclare.
    const enregistre = await runtime.assistant.say(
      `enregistre ${nom} comme document`,
      { sessionId },
    );
    expect(enregistre.kind).toBe('DONE');
    if (enregistre.kind !== 'DONE') return;
    expect(enregistre.toolId).toBe('entity_create');

    // 2. Le tour évoque l'entité — c'est ADR-072 qui l'a câblé.
    expect(enregistre.mentionedEntityIds).toHaveLength(1);
    await runtime.sessions.appendTurn(sessionId, {
      speaker: 'JARVIS',
      content: 'enregistré',
      mentionedEntityIds: enregistre.mentionedEntityIds,
    });

    // 3. « ça » — et Jarvis sait de quoi il s'agit.
    const ajoute = await runtime.assistant.say('ajoute ça à ma liste', { sessionId });
    expect(ajoute.kind).toBe('DONE');
    if (ajoute.kind !== 'DONE') return;
    expect(ajoute.toolId).toBe('task_create');

    // LA TÂCHE PORTE LE NOM DE L'ENTITÉ, pas le mot « ça ».
    const tache = await db.query<{ title: string }>(
      `SELECT title FROM tasks WHERE title = $1`,
      [nom],
    );
    expect(tache.ok && tache.value.rows).toHaveLength(1);
  });

  /* ==================================================================== *
   * L'INTERDIT — « deviner si deux interprétations ont un impact différent »
   * ==================================================================== */

  it('05/A2 — l’INTERDIT : sans contexte, Jarvis DEMANDE au lieu de deviner', async () => {
    /* LE DÉFAUT QUE CETTE RÈGLE FERME ÉTAIT ACTIF. « Ajoute ça à ma liste »
       matchait la règle générale et créait une tâche **intitulée « ça »** — le
       moteur passait le référent comme s'il était le texte voulu. */
    const sessionId = await conversation();

    const ajoute = await runtime.assistant.say('ajoute ça à ma liste', { sessionId });
    expect(ajoute.kind).toBe('CLARIFY');
    if (ajoute.kind !== 'CLARIFY') return;
    expect(ajoute.question).toMatch(/à quoi fais-tu référence/i);

    // ET RIEN N'A ÉTÉ CRÉÉ — surtout pas une tâche appelée « ça ».
    const parasite = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tasks WHERE lower(title) IN ('ça', 'ca')`,
    );
    expect(parasite.ok && parasite.value.rows[0]?.n).toBe('0');
  });

  it('05/A2 — SANS SESSION, Jarvis demande aussi : pas de contexte inventé', async () => {
    /* Un appelant sans conversation n'a pas de « contexte récent ». Répondre
       quand même reviendrait à inventer le passé de l'échange. */
    const ajoute = await runtime.assistant.say('ajoute ça à ma liste');
    expect(ajoute.kind).toBe('CLARIFY');
  });

  it('CONTRÔLE NÉGATIF — une phrase SANS référent n’est pas détournée', () => {
    /* Sans lui, une règle trop large transformerait « ajoute le pain à ma
       liste » en question, et Jarvis cesserait de savoir faire ce qu'il faisait
       déjà. */
    const propose = runtime.intent.propose('ajoute le pain à ma liste');
    expect(propose.kind).toBe('TOOL_CALL');
    if (propose.kind !== 'TOOL_CALL') return;
    expect(propose.toolId).toBe('task_create');
    expect(Object.keys(propose.referents)).toHaveLength(0);
    expect((propose.input as { title: string }).title).toBe('le pain');
  });

  it('le moteur d’intention reste une fonction PURE du texte', () => {
    /* LA PROPRIÉTÉ QU'ON A REFUSÉ DE VENDRE. Rendre `propose` asynchrone était
       la voie courte pour A2 ; elle aurait fait dépendre la COMPRÉHENSION d'une
       entrée-sortie.

       Deux appels identiques rendent la même chose, sans base, sans réseau. */
    const a = runtime.intent.propose('ajoute ça à ma liste');
    const b = runtime.intent.propose('ajoute ça à ma liste');
    expect(a).toEqual(b);
    expect(a.kind).toBe('TOOL_CALL');
    if (a.kind !== 'TOOL_CALL') return;
    // Le moteur SIGNALE le référent ; il ne le résout pas.
    expect(a.referents).toEqual({ title: 'ANAPHORA' });
    expect((a.input as { title: string }).title).toBe('');
  });
});
