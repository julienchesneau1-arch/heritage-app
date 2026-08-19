/**
 * Assistant — la boucle partagée par le CLI et la passerelle web.
 *
 * Référence : 02 Étape C, 03 §3, ADR-023.
 *
 * Ces tests utilisent des doubles pour l'Intent Engine et le Tool Gateway :
 * l'objet sous test est la BOUCLE, pas le noyau. Les cinq outils réels ne
 * produisent aucune demande de confirmation en usage normal — impossible donc
 * d'éprouver ce chemin de bout en bout aujourd'hui, alors que c'est exactement
 * celui qui protège des actions irréversibles de demain.
 */
import { describe, expect, it } from 'vitest';
import { confirmableKey, renderConfirmable } from '../../src/core/tools/confirmation.js';
import { createAssistant } from '../../src/core/assistant.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { IntentEngine, IntentProposal } from '../../src/core/intent/engine.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';

function intentOf(proposal: IntentProposal): IntentEngine {
  return { propose: () => proposal };
}

const TOOL_CALL: IntentProposal = {
  kind: 'TOOL_CALL',
  toolId: 'payment_send',
  input: { amount: 50, to: 'Paul' },
  parameterProvenance: { amount: 'USER', to: 'USER' },
  confidence: 1,
  tier: 0,
  userConfirms: false,
  // ADR-073 : toujours présent, vide quand le texte porte le contenu lui-même.
  referents: {},
};

function success(): GatewayResult {
  return {
    status: 'CONFIRMED',
    output: { id: 'x' },
    verification: { status: 'CONFIRMED', detail: 'Relu.' },
    policy: { decision: 'ALLOW', effectiveAutonomy: 'L2', reasons: [] },
    eventId: 'evt-1',
    replayed: false,
    // ADR-072 : la ressource touchée est TOUJOURS renseignée, `null` compris.
    resource: null,
    provenance: 'TOOL_OUTPUT',
    suspectedInjection: false,
  };
}

/** Gateway qui exige une confirmation tant que `context.userConfirmed` est faux. */
function gatewayRequiringConfirmation(calls: ToolCall[]): ToolGateway {
  return {
    register: () => ok(undefined),
    list: () => [],
    /* Double : le rétablissement de confiance n'est pas éprouvé ici.
       Sa sémantique l'est dans `tests/lab/provenance.test.ts`. */
    restoreTrust: () => Promise.resolve(ok(undefined)),
    invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
      calls.push(call);
      if (!call.context.userConfirmed) {
        return Promise.resolve(
          err(
            /* ⚠ CETTE DOUBLURE FABRIQUAIT SES CLÉS À LA MAIN, ET C'EST
               EXACTEMENT AINSI QU'UNE DOUBLURE DÉRIVE DU VRAI.

               Elle écrivait `montant: 50` là où le Gateway écrit désormais
               `valeur.montant` (ADR-063). Elle passe par les MÊMES fonctions
               que la production : le jour où la forme de transport rechange,
               elle suit sans qu'on y pense. */
            jarvisError('CONFIRMATION_REQUIRED', 'Confirmer ce virement ?', {
              tool: 'payment_send',
              autonomy: 'L3',
              [confirmableKey('montant')]: renderConfirmable(50),
              [confirmableKey('destinataire')]: renderConfirmable('Paul'),
            }),
          ),
        );
      }
      return Promise.resolve(ok(success()));
    },
  };
}

/**
 * Résolveur de dates FIGÉ — ADR-077.
 *
 * Une date fixe et non un calcul : ces tests éprouvent l'orchestration de
 * l'Assistant, pas l'arithmétique du calendrier. Celle-ci a son propre fichier,
 * qui l'éprouve contre PostgreSQL — le seul endroit où elle est vraie.
 */
const TEMPS_FIGE = {
  resoudre: () =>
    Promise.resolve(
      ok({ iso: '2026-08-20T09:00:00+02:00', humain: 'jeudi 20 août à 09:00' }),
    ),
};

describe('Assistant', () => {
  it('relaie une demande de précision sans rien exécuter', async () => {
    const calls: ToolCall[] = [];
    const assistant = createAssistant({
      intent: intentOf({ kind: 'CLARIFY', question: 'Quoi retenir ?', understood: '' }),
      gateway: gatewayRequiringConfirmation(calls),
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    const reply = await assistant.say('Note que');
    expect(reply.kind).toBe('CLARIFY');
    expect(calls).toHaveLength(0);
  });

  it('dit ce qui manque plutôt que « je n\'ai pas compris »', async () => {
    const assistant = createAssistant({
      intent: intentOf({
        kind: 'UNSUPPORTED',
        understood: 'un envoi de message',
        missing: 'la capacité d\'envoyer des emails',
      }),
      gateway: gatewayRequiringConfirmation([]),
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    const reply = await assistant.say('Envoie un mail à Paul');
    expect(reply.kind).toBe('UNSUPPORTED');
    if (reply.kind !== 'UNSUPPORTED') return;
    expect(reply.missing).toContain('emails');
  });

  it('porte la confirmation sur les VALEURS, pas sur l\'intention résumée', async () => {
    // 03 §3 : une confirmation qui ne montre pas le destinataire et le montant
    // ne protège de rien face à une injection qui a modifié ces valeurs.
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: gatewayRequiringConfirmation([]),
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    const reply = await assistant.say('Vire 50 € à Paul');
    expect(reply.kind).toBe('CONFIRM');
    if (reply.kind !== 'CONFIRM') return;
    expect(reply.values).toEqual({ montant: '50', destinataire: 'Paul' });
    // Ni le nom de l'outil ni le niveau d'autonomie : ce ne sont pas des
    // valeurs sur lesquelles un humain peut se prononcer.
    expect(Object.keys(reply.values)).not.toContain('tool');
    expect(Object.keys(reply.values)).not.toContain('autonomy');
  });

  it('confirme la MÊME opération, sans état serveur', async () => {
    // C'est la propriété qui rend le flux web sûr : l'Intent Engine étant
    // déterministe, il n'y a aucune session de confirmation à détourner.
    const calls: ToolCall[] = [];
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: gatewayRequiringConfirmation(calls),
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    const asked = await assistant.say('Vire 50 € à Paul');
    if (asked.kind !== 'CONFIRM') throw new Error('confirmation attendue');

    const done = await assistant.say('Vire 50 € à Paul', {
      operationId: asked.operationId,
      confirm: true,
    });

    expect(done.kind).toBe('DONE');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.operationId).toBe(calls[0]?.operationId);
    expect(calls[0]?.context.userConfirmed).toBe(false);
    expect(calls[1]?.context.userConfirmed).toBe(true);
  });

  it('n\'exécute rien de plus que ce qui a été confirmé', async () => {
    const calls: ToolCall[] = [];
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: gatewayRequiringConfirmation(calls),
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    await assistant.say('Vire 50 € à Paul');
    expect(calls).toHaveLength(1); // aucune exécution avant l'accord
  });

  it('remet la confirmation du Memory Guard à zéro après chaque tour', async () => {
    // Une confirmation qui fuirait vers l'appel suivant transformerait un « oui »
    // ponctuel en autorisation permanente.
    const states: boolean[] = [];
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: {
        register: () => ok(undefined),
        list: () => [],
        /* Double : le rétablissement de confiance n'est pas éprouvé ici.
           Sa sémantique l'est dans `tests/lab/provenance.test.ts`. */
        restoreTrust: () => Promise.resolve(ok(undefined)),
        invoke: () => Promise.resolve(ok(success())),
      },
      setGuardConfirmed: (value: boolean) => states.push(value),
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    await assistant.say('Vire 50 € à Paul', { confirm: true });
    expect(states).toEqual([true, false]);
  });

  it('remet la confirmation à zéro même si l\'outil lève', async () => {
    const states: boolean[] = [];
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: {
        register: () => ok(undefined),
        list: () => [],
        /* Double : le rétablissement de confiance n'est pas éprouvé ici.
           Sa sémantique l'est dans `tests/lab/provenance.test.ts`. */
        restoreTrust: () => Promise.resolve(ok(undefined)),
        invoke: () => Promise.reject(new Error('base injoignable')),
      },
      setGuardConfirmed: (value: boolean) => states.push(value),
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    await expect(assistant.say('Vire 50 € à Paul', { confirm: true })).rejects.toThrow();
    expect(states).toEqual([true, false]);
  });

  it('rapporte un refus de politique comme un refus, pas comme une erreur', async () => {
    const assistant = createAssistant({
      intent: intentOf(TOOL_CALL),
      gateway: {
        register: () => ok(undefined),
        list: () => [],
        /* Double : le rétablissement de confiance n'est pas éprouvé ici.
           Sa sémantique l'est dans `tests/lab/provenance.test.ts`. */
        restoreTrust: () => Promise.resolve(ok(undefined)),
        invoke: () =>
          Promise.resolve(err(jarvisError('POLICY_DENIED', 'Interdit par politique dure.'))),
      },
      setGuardConfirmed: () => undefined,
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    const reply = await assistant.say('Vire 50 € à Paul');
    expect(reply.kind).toBe('DENIED');
  });

  it('transmet « retiens que » comme une confirmation, sans en redemander une', async () => {
    // PRD §137 : exiger un second accord sur un ordre explicite de mémorisation
    // ajouterait de la friction sans rien protéger.
    const states: boolean[] = [];
    const assistant = createAssistant({
      intent: intentOf({ ...TOOL_CALL, toolId: 'memory_add', userConfirms: true }),
      gateway: {
        register: () => ok(undefined),
        list: () => [],
        /* Double : le rétablissement de confiance n'est pas éprouvé ici.
           Sa sémantique l'est dans `tests/lab/provenance.test.ts`. */
        restoreTrust: () => Promise.resolve(ok(undefined)),
        invoke: () => Promise.resolve(ok(success())),
      },
      setGuardConfirmed: (value: boolean) => states.push(value),
      // S13 (ADR-069) : l'interrupteur est FOURNI, jamais deviné.
      cloudEnabled: false,
      /* ADR-073 : un résolveur qui ne trouve rien. Ces tests ne portent pas
         sur la résolution, et un référent non résolu doit produire une
         QUESTION — jamais une supposition. */
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      temps: TEMPS_FIGE,
    });

    await assistant.say('Retiens que Jean travaille chez Orano');
    expect(states[0]).toBe(true);
  });
});
