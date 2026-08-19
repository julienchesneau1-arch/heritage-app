/**
 * DÉSIGNER SANS NOMMER — la chaîne complète. ADR-084.
 *
 * `REFERENCE 0/8` (ADR-080) est le chiffre décisif de la fluidité : plus d'un
 * quart d'une conversation réelle désigne une chose sans la renommer.
 *
 * Le `Tier 1` peut désormais MARQUER un paramètre comme renvoi. Ce fichier
 * éprouve la seule chose qui compte : **que ce droit n'en soit pas une
 * autorité**.
 *
 * ⚠ POURQUOI CES TESTS PASSENT PAR L'ASSISTANT, PAS PAR `createTier1`
 * ---------------------------------------------------------------------------
 * `tier1.test.ts` vérifie ce que le proposeur RÉPOND. Ça ne dit rien de ce qui
 * ARRIVE. Or la garantie d'ADR-084 est une propriété de la chaîne :
 *
 * ```text
 * modèle marque → Assistant résout sur preuve → Policy Gate confirme la valeur
 * ```
 *
 * Vérifier le premier maillon aurait reproduit exactement le défaut d'ADR-083 :
 * chaque maillon correct isolément, la chaîne non éprouvée. Les doubles sont
 * donc placés AUX EXTRÉMITÉS — un modèle qui dicte, une passerelle qui
 * enregistre — et tout ce qui est entre deux est le vrai code.
 *
 * ⚠ ET AUCUN MODÈLE N'A TOURNÉ ICI. Ces tests éprouvent ce que le système fait
 * d'un marquage. Ils ne disent RIEN de la fréquence à laquelle un modèle réel
 * marque juste — ce nombre reste non mesuré (ADR-082).
 */
import { describe, expect, it } from 'vitest';
import { createAssistant, type AssistantDeps } from '../../src/core/assistant.js';
import { createTier1 } from '../../src/core/intent/tier1.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { IntentEngine } from '../../src/core/intent/engine.js';
import type { ModelProvider } from '../../src/providers/contract.js';
import type { Resolution } from '../../src/core/context/resolver.js';
import type { RegisteredTool } from '../../src/core/tools/contract.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';

const OUTILS = [
  {
    definition: {
      id: 'task_cancel',
      description: 'Annuler une tâche',
      parameters: [{ name: 'title', sensitive: true }],
    },
  },
  {
    definition: {
      id: 'reminder_create',
      description: 'Créer un rappel',
      parameters: [
        { name: 'title', sensitive: true },
        { name: 'due_at', sensitive: false },
      ],
    },
  },
] as unknown as readonly RegisteredTool[];

/** Modèle simulé : il rend le JSON qu'on lui dicte. */
function modele(reponse: unknown): ModelProvider {
  return {
    capabilities: {
      id: 'faux',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: true })),
    chat: () => Promise.resolve(err(jarvisError('INTERNAL', 'non utilisé'))),
    structuredOutput: <T,>(
      _req: unknown,
      validate: (raw: unknown) => Result<T>,
    ): Promise<Result<T>> => Promise.resolve(validate(reponse)),
    embeddings: () => Promise.resolve(err(jarvisError('INTERNAL', 'non utilisé'))),
  } as unknown as ModelProvider;
}

/** `Tier 0` qui ne comprend jamais rien : c'est le cas où le `Tier 1` parle. */
const TIER0_MUET: IntentEngine = {
  propose: () => ({
    kind: 'UNSUPPORTED',
    understood: 'rien',
    missing: 'une règle',
  }),
};

const TEMPS_FIGE = {
  resoudre: () =>
    Promise.resolve(
      ok({ iso: '2026-08-20T09:00:00+02:00', humain: 'jeudi 20 août à 09:00' }),
    ),
};

/** Passerelle qui enregistre l'appel et le laisse passer. */
function passerelle(calls: ToolCall[]): ToolGateway {
  return {
    register: () => ok(undefined),
    list: () => [],
    restoreTrust: () => Promise.resolve(ok(undefined)),
    invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
      calls.push(call);
      return Promise.resolve(
        ok({
          status: 'CONFIRMED',
          output: { id: 'x' },
          verification: { status: 'CONFIRMED', detail: 'Fait.' },
          policy: { decision: 'ALLOW', effectiveAutonomy: 'L2', reasons: [] },
          eventId: 'evt',
          replayed: false,
          resource: null,
          provenance: 'TOOL_OUTPUT',
          suspectedInjection: false,
        } as GatewayResult),
      );
    },
  };
}

function assistantAvec(
  reponseModele: unknown,
  resolution: Resolution,
  calls: ToolCall[],
): ReturnType<typeof createAssistant> {
  const deps: AssistantDeps = {
    intent: TIER0_MUET,
    gateway: passerelle(calls),
    setGuardConfirmed: () => undefined,
    cloudEnabled: false,
    resolver: {
      resolveMention: () => Promise.resolve(ok(resolution)),
      resolveAnaphora: () => Promise.resolve(ok(resolution)),
    },
    temps: TEMPS_FIGE,
    tier1: createTier1({ model: modele(reponseModele), outils: () => OUTILS }),
  };
  return createAssistant(deps);
}

const INTROUVABLE: Resolution = { kind: 'NOT_FOUND', mention: 'référent implicite' };

const TROUVE: Resolution = {
  kind: 'RESOLVED',
  entity: {
    id: 'e1',
    kind: 'PROJECT',
    displayName: 'Rénovation salon',
    viaConfirmedAlias: false,
    privacyClass: 'ORANGE',
  },
  confidence: 0.8,
  reason: 'Seule entité évoquée au tour précédent.',
};

/* ====================================================================== *
 * 1. CE QUE ÇA REND POSSIBLE
 * ====================================================================== */

describe('un renvoi TEMPORAL devient une vraie date', () => {
  it('« faudrait que je pense au café jeudi » aboutit', async () => {
    /* Le gain le plus net d'ADR-084, et le seul qui soit complet aujourd'hui :
       le temporel ne dépend d'aucune reconnaissance d'entité. La date est
       calculée par PostgreSQL (ADR-077), jamais par le modèle. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'reminder_create',
        parametres: { title: 'acheter du café', due_at: 'jeudi' },
        referents: { due_at: 'TEMPORAL' },
      },
      INTROUVABLE,
      calls,
    );

    const reply = await assistant.say('faudrait que je pense au café jeudi');

    expect(reply.kind).toBe('DONE');
    expect(calls).toHaveLength(1);
    /* La valeur écrite est l'instant résolu, pas le mot « jeudi ».
       `ToolCall.input` est `unknown` par construction — c'est la passerelle qui
       le valide, pas l'appelant. On assertionne donc sur l'objet entier plutôt
       que d'y indexer derrière un `as`, ce qui serait le défaut qu'ADR-016
       proscrit, dans un test qui prétend garder une frontière. */
    expect(calls[0]?.input).toEqual({
      title: 'acheter du café',
      due_at: '2026-08-20T09:00:00+02:00',
    });
    if (reply.kind !== 'DONE') return;
    // Et l'instant retenu est DIT, en français (ADR-077).
    expect(reply.detail).toContain('jeudi 20 août à 09:00');
  });

  it('résout le renvoi ANAPHORA sur la preuve du contexte', async () => {
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'la' },
        referents: { title: 'ANAPHORA' },
      },
      TROUVE,
      calls,
    );

    const reply = await assistant.say('annule-la', { sessionId: 's1' });

    expect(reply.kind).toBe('DONE');
    // Le paramètre porte le nom RÉSOLU, pas le pronom.
    expect(calls[0]?.input).toEqual({ title: 'Rénovation salon' });
  });
});

/* ====================================================================== *
 * 2. CE QUE ÇA NE DONNE PAS — aucune issue silencieuse
 * ====================================================================== */

describe('le marquage ne donne aucune autorité', () => {
  it('la valeur résolue reste MODEL_OUTPUT, donc soumise à confirmation', async () => {
    /* ⚠ LE POINT LE PLUS IMPORTANT DU FICHIER.

       Après substitution, la valeur vient du RÉSOLVEUR, donc de la base. On
       pourrait la juger fiable et la marquer `USER`. On ne le fait pas : c'est
       le modèle qui a décidé QUE ce paramètre était un renvoi, et cette
       décision-là reste la sienne.

       Conserver `MODEL_OUTPUT` est conservateur — ça exige PLUS de
       confirmation, jamais moins. Si ce test devient rouge parce que quelqu'un
       a « corrigé » la provenance, c'est la garde d'ADR-084 qui tombe. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'la' },
        referents: { title: 'ANAPHORA' },
      },
      TROUVE,
      calls,
    );

    await assistant.say('annule-la', { sessionId: 's1' });

    expect(calls[0]?.parameterProvenance['title']).toBe('MODEL_OUTPUT');
    // Et le modèle ne peut jamais affirmer que l'énoncé vaut confirmation.
    expect(calls[0]?.context.userConfirmed).toBe(false);
  });

  it('un renvoi introuvable produit une QUESTION, jamais une action', async () => {
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'la' },
        referents: { title: 'ANAPHORA' },
      },
      INTROUVABLE,
      calls,
    );

    const reply = await assistant.say('annule-la', { sessionId: 's1' });

    expect(reply.kind).toBe('CLARIFY');
    expect(calls).toHaveLength(0);
  });

  it('un renvoi ambigu produit UNE question qui nomme les candidats', async () => {
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'celui-là' },
        referents: { title: 'ANAPHORA' },
      },
      {
        kind: 'AMBIGUOUS',
        candidates: [],
        question: 'Rénovation salon ou Déclaration impôts ?',
      },
      calls,
    );

    const reply = await assistant.say('annule celui-là', { sessionId: 's1' });

    expect(reply.kind).toBe('CLARIFY');
    if (reply.kind !== 'CLARIFY') return;
    expect(reply.question).toBe('Rénovation salon ou Déclaration impôts ?');
    expect(calls).toHaveLength(0);
  });

  it('sans conversation en cours, il demande plutôt que d\'inventer le passé', async () => {
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'la' },
        referents: { title: 'ANAPHORA' },
      },
      TROUVE,
      calls,
    );

    // Pas de `sessionId` : il n'y a pas de « contexte récent » à interroger.
    const reply = await assistant.say('annule-la');

    expect(reply.kind).toBe('CLARIFY');
    expect(calls).toHaveLength(0);
  });

  it('un TEMPORAL qui n\'est pas une date produit une question, pas un défaut', async () => {
    /* Marquage faux du modèle : « bientôt » n'est reconnu par aucune règle
       temporelle. Poser une date par défaut créerait une confiance fausse —
       un rappel posé pour un moment que Julien n'a pas dit. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'reminder_create',
        parametres: { title: 'rappeler Paul', due_at: 'bientôt' },
        referents: { due_at: 'TEMPORAL' },
      },
      INTROUVABLE,
      calls,
    );

    const reply = await assistant.say('faut que je rappelle Paul bientôt');

    expect(reply.kind).toBe('CLARIFY');
    expect(calls).toHaveLength(0);
  });
});

/* ====================================================================== *
 * 3. LES MARQUAGES MALFORMÉS
 * ====================================================================== */

describe('marquages hostiles ou incohérents', () => {
  it('une marque sur un paramètre absent est ignorée, pas propagée', async () => {
    /* Elle ne désigne rien. La retenir ferait échouer la résolution sur un
       champ vide et transformerait une bizarrerie de modèle en erreur. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'reminder_create',
        parametres: { title: 'acheter du pain' },
        referents: { due_at: 'TEMPORAL', fantome: 'ANAPHORA' },
      },
      INTROUVABLE,
      calls,
    );

    const reply = await assistant.say('penser au pain');

    expect(reply.kind).toBe('DONE');
    expect(calls[0]?.input).toEqual({ title: 'acheter du pain' });
  });

  it('un genre de renvoi inconnu fait rejeter la réponse entière', async () => {
    /* La frontière est un `z.enum` fermé. « SPATIAL », « ENTITY », « TOUT » :
       aucun n'a de résolveur, et en inventer un silencieusement reviendrait à
       laisser le modèle étendre le vocabulaire du système. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'task_cancel',
        parametres: { title: 'la' },
        referents: { title: 'SPATIAL' },
      },
      TROUVE,
      calls,
    );

    const reply = await assistant.say('annule-la', { sessionId: 's1' });

    /* Le `Tier 1` échoue → l'Assistant garde la réponse honnête du `Tier 0`.
       Une dégradation se subit, elle ne se propage pas (ADR-081). */
    expect(reply.kind).toBe('UNSUPPORTED');
    expect(calls).toHaveLength(0);
  });

  it('sans marquage, le comportement d\'avant ADR-084 est inchangé', async () => {
    /* Contrôle négatif : `referents` est OPTIONNEL. Un modèle qui l'ignore —
       ce que fera un petit modèle une fois sur deux — doit continuer à
       fonctionner comme avant, pas planter. */
    const calls: ToolCall[] = [];
    const assistant = assistantAvec(
      {
        action: 'APPEL',
        outil: 'reminder_create',
        parametres: { title: 'acheter du café' },
      },
      INTROUVABLE,
      calls,
    );

    const reply = await assistant.say('faudrait que je pense au café');

    expect(reply.kind).toBe('DONE');
    expect(calls[0]?.input).toEqual({ title: 'acheter du café' });
  });
});
