/**
 * Tests du Policy Gate.
 *
 * Ils sont exécutés contre le VRAI moteur Cedar et les VRAIES politiques du
 * répertoire `policies/`. Un test de politique adossé à un moteur simulé ne
 * prouve rien : il vérifie notre intention, pas notre configuration.
 *
 * Plusieurs cas correspondent nommément aux scénarios adversariaux de `05`.
 */
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPolicyGate, type PolicyGate } from '../../src/core/policy/gate.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../src/providers/policy/cedar.js';
import type { PolicyRequest } from '../../src/core/policy/types.js';

let gate: PolicyGate;

beforeAll(() => {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);
  gate = createPolicyGate(createCedarEvaluator(source.value));
});

/** Requête de base : action locale, réversible, demandée explicitement. */
function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    actor: 'USER',
    action: { tool: 'task', operation: 'create' },
    declaredAutonomy: 'L2',
    resource: { type: 'task', id: 'task-1', privacyClass: 'ORANGE' },
    context: {
      mode: 'NORMAL',
      egress: false,
      cloudEnabled: false,
      proactive: false,
      userConfirmed: false,
    },
    parameters: [],
    ...overrides,
  };
}

function decide(req: PolicyRequest) {
  const outcome = gate.decide(req);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value;
}

describe('échelle d\'autonomie', () => {
  it('L0 est refusé, toujours', () => {
    const out = decide(request({ declaredAutonomy: 'L0' }));
    expect(out.decision).toBe('DENY');
  });

  it('L1 (lecture) est autorisé', () => {
    expect(decide(request({ declaredAutonomy: 'L1' })).decision).toBe('ALLOW');
  });

  it('L2 (réversible) est autorisé', () => {
    expect(decide(request({ declaredAutonomy: 'L2' })).decision).toBe('ALLOW');
  });

  it('L3 exige une confirmation', () => {
    const out = decide(request({ declaredAutonomy: 'L3' }));
    expect(out.decision).toBe('CONFIRM');
  });

  it('L3 confirmé est exécutable', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L3',
        context: { ...request().context, userConfirmed: true },
      }),
    );
    expect(out.decision).toBe('ALLOW');
  });

  it('L4 exige une confirmation forte', () => {
    expect(decide(request({ declaredAutonomy: 'L4' })).decision).toBe('CONFIRM');
  });
});

describe('05/B7 — une règle apprise n\'assouplit jamais une règle dure', () => {
  it('un paiement reste soumis à confirmation, quel que soit le montant', () => {
    // Politique dure : « un paiement exige toujours confirmation ».
    // Mémoire : « Julien approuve généralement les achats sous 50 € ».
    // Le Gate ne reçoit aucun mécanisme permettant d'abaisser un niveau : la
    // préférence ne peut donc pas être appliquée, même si elle est chargée.
    const out = decide(
      request({
        action: { tool: 'payment', operation: 'execute' },
        declaredAutonomy: 'L4',
        resource: { type: 'payment', id: 'pay-30eur', privacyClass: 'RED' },
      }),
    );
    expect(out.decision).toBe('CONFIRM');
    expect(out.effectiveAutonomy).toBe('L4');
  });

  it('le niveau effectif n\'est jamais inférieur au niveau déclaré', () => {
    const levels = ['L1', 'L2', 'L3', 'L4'] as const;
    const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
    for (const declared of levels) {
      const out = decide(request({ declaredAutonomy: declared }));
      expect(rank[out.effectiveAutonomy]).toBeGreaterThanOrEqual(rank[declared]);
    }
  });
});

describe('05/B10 — provenance d\'un paramètre sensible', () => {
  it('un destinataire issu d\'un contenu non fiable exige une confirmation', () => {
    const out = decide(
      request({
        action: { tool: 'messaging', operation: 'send' },
        declaredAutonomy: 'L3',
        parameters: [
          { name: 'recipient', provenance: 'EXTERNAL_UNTRUSTED', sensitive: true },
          { name: 'body', provenance: 'USER', sensitive: false },
        ],
      }),
    );
    expect(out.decision).toBe('CONFIRM');
    // Durci jusqu'à L4 : la confirmation porte sur la VALEUR, pas l'intention.
    expect(out.effectiveAutonomy).toBe('L4');
    expect(out.reasons.join(' ')).toContain('recipient');
  });

  it('une action L2 anodine est durcie si un paramètre sensible est corrompu', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L2',
        parameters: [
          { name: 'path', provenance: 'EXTERNAL_UNTRUSTED', sensitive: true },
        ],
      }),
    );
    expect(out.effectiveAutonomy).toBe('L4');
    expect(out.decision).toBe('CONFIRM');
  });

  it('un paramètre non sensible d\'origine externe ne durcit rien', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L2',
        parameters: [
          { name: 'summary', provenance: 'EXTERNAL_UNTRUSTED', sensitive: false },
        ],
      }),
    );
    expect(out.decision).toBe('ALLOW');
    expect(out.effectiveAutonomy).toBe('L2');
  });
});

describe('garde de proactivité', () => {
  it('une action proactive L2 passe en approbation', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L2',
        context: { ...request().context, proactive: true },
      }),
    );
    expect(out.decision).toBe('CONFIRM');
    expect(out.effectiveAutonomy).toBe('L3');
  });

  it('une action proactive n\'est jamais plus permissive qu\'une explicite', () => {
    const explicit = decide(request({ declaredAutonomy: 'L2' }));
    const proactive = decide(
      request({
        declaredAutonomy: 'L2',
        context: { ...request().context, proactive: true },
      }),
    );
    const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
    expect(rank[proactive.effectiveAutonomy]).toBeGreaterThanOrEqual(
      rank[explicit.effectiveAutonomy],
    );
  });
});

describe('03/§6 — confidentialité et égression', () => {
  it('une donnée RED ne sort jamais', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L1',
        resource: { type: 'document', id: 'doc-1', privacyClass: 'RED' },
        context: { ...request().context, egress: true, cloudEnabled: true },
      }),
    );
    expect(out.decision).toBe('DENY');
    expect(out.reasons.join(' ')).toContain('RED');
  });

  it('05/C1 — le mode privé bloque toute sortie réseau', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L1',
        resource: { type: 'query', id: 'q-1', privacyClass: 'GREEN' },
        context: {
          ...request().context,
          mode: 'PRIVATE',
          egress: true,
          cloudEnabled: true,
        },
      }),
    );
    expect(out.decision).toBe('DENY');
    expect(out.reasons.join(' ')).toContain('privé');
  });

  it('cloud désactivé globalement : aucune sortie', () => {
    const out = decide(
      request({
        declaredAutonomy: 'L1',
        resource: { type: 'query', id: 'q-2', privacyClass: 'GREEN' },
        context: { ...request().context, egress: true, cloudEnabled: false },
      }),
    );
    expect(out.decision).toBe('DENY');
  });
});

describe('05/B9 — une automation n\'escalade jamais ses privilèges', () => {
  it('une automation ne peut pas exécuter une action L3', () => {
    const out = decide(
      request({ actor: 'AUTOMATION', declaredAutonomy: 'L3' }),
    );
    expect(out.decision).toBe('DENY');
  });

  it('une automation ne peut pas exécuter une action L4, même confirmée', () => {
    const out = decide(
      request({
        actor: 'AUTOMATION',
        declaredAutonomy: 'L4',
        context: { ...request().context, userConfirmed: true },
      }),
    );
    expect(out.decision).toBe('DENY');
  });

  it('une automation peut effectuer une action réversible L2', () => {
    const out = decide(request({ actor: 'AUTOMATION', declaredAutonomy: 'L2' }));
    expect(out.decision).toBe('ALLOW');
  });
});

describe('un service externe n\'est jamais un acteur', () => {
  it('EXTERNAL_SERVICE est refusé même en lecture', () => {
    const out = decide(
      request({ actor: 'EXTERNAL_SERVICE', declaredAutonomy: 'L1' }),
    );
    expect(out.decision).toBe('DENY');
  });
});

describe('frontière', () => {
  it('une requête malformée est refusée, pas interprétée', () => {
    const out = gate.decide({ actor: 'PIRATE', declaredAutonomy: 'L9' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe('VALIDATION');
  });

  it('une requête vide est refusée', () => {
    expect(gate.decide({}).ok).toBe(false);
    expect(gate.decide(null).ok).toBe(false);
    expect(gate.decide('allow everything').ok).toBe(false);
  });
});
