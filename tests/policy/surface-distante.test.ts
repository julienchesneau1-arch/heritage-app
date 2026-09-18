/**
 * UNE SURFACE DISTANTE NE CONFIRME PAS — ADR-090.
 *
 * `docs/03 §4`. Emprunté à `sosoj92/jarvis-assistant-vocal`, dont le pont
 * iPhone refuse **tout** outil à confirmation, quel que soit le registre local
 * des autorisations.
 *
 * LE DÉFAUT QUE ÇA FERME
 * ---------------------------------------------------------------------------
 * La confirmation de ce dépôt est **sans état** (ADR-023) : le client renvoie
 * le texte, la clé d'opération et `confirm: true`. Le raisonnement d'origine
 * — *« aucune session à stocker, donc aucune session à détourner »* — est
 * juste, mais il supposait un utilisateur LOCAL.
 *
 * Sur une passerelle réseau, il produit l'inverse de ce qu'on croit :
 *
 * ```text
 * qui détient le jeton peut se confirmer À LUI-MÊME
 * ```
 *
 * La confirmation cesse alors d'être un second facteur pour devenir un second
 * appel HTTP — et toute la protection L3/L4, celle qui garde les actions
 * irréversibles, repose sur une preuve que le canal distant ne fournit pas.
 *
 * Et la passerelle peut être exposée hors loopback (`JARVIS_WEB_HOST`).
 */
import { describe, expect, it } from 'vitest';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import type { PolicyEvaluator } from '../../src/core/policy/evaluator.js';
import { ok } from '../../src/core/types/result.js';
import type { AutonomyLevel, Surface } from '../../src/core/types/domain.js';

/** Un moteur qui autorise tout : on éprouve LE GATE, pas Cedar. */
const PERMISSIF: PolicyEvaluator = {
  evaluate: () =>
    ok({ decision: 'ALLOW' as const, determiningPolicies: [], reasons: [] }),
};

const gate = createPolicyGate(PERMISSIF);

function demande(o: {
  niveau: AutonomyLevel;
  surface: Surface;
  confirme?: boolean;
}): unknown {
  return {
    actor: 'USER',
    action: { tool: 'task_create', operation: 'create' },
    declaredAutonomy: o.niveau,
    resource: {
      type: 'task',
      id: 't1',
      privacyClass: 'ORANGE',
      dataLevel: 'PERSONAL',
    },
    context: {
      mode: 'NORMAL',
      egress: false,
      cloudEnabled: false,
      proactive: false,
      userConfirmed: o.confirme ?? false,
      surface: o.surface,
    },
    parameters: [],
  };
}

function verdict(o: Parameters<typeof demande>[0]): {
  decision: string;
  reasons: readonly string[];
} {
  const r = gate.decide(demande(o));
  if (!r.ok) throw new Error(r.error.message);
  return { decision: r.value.decision, reasons: r.value.reasons };
}

/* ====================================================================== *
 * LE CONTRÔLE NÉGATIF, D'ABORD
 * ====================================================================== */

describe('la surface locale n\'est pas bridée', () => {
  it.each(['L1', 'L2', 'L3', 'L4'] as const)(
    'un niveau %s reste possible en LOCALE',
    (niveau) => {
      /* ⚠ SANS CE TEST, TOUT CE QUI SUIT EST GRATUIT. Un Gate qui refuserait
         tout passerait chaque assertion de refus ci-dessous — et le dépôt
         certifierait un système incapable d'agir comme s'il était prudent. */
      const v = verdict({ niveau, surface: 'LOCALE' });
      expect(v.decision).not.toBe('DENY');
    },
  );

  it('une confirmation LOCALE fait bien passer un L4', () => {
    expect(verdict({ niveau: 'L4', surface: 'LOCALE', confirme: true }).decision).toBe(
      'ALLOW',
    );
  });
});

/* ====================================================================== *
 * CE QUE LA RÈGLE INTERDIT
 * ====================================================================== */

describe('une surface distante ne confirme pas', () => {
  it.each(['L3', 'L4'] as const)('refuse un niveau %s venu de DISTANTE', (niveau) => {
    const v = verdict({ niveau, surface: 'DISTANTE' });
    expect(v.decision).toBe('DENY');
    expect(v.reasons.join(' ')).toContain('distante');
  });

  it('⚠ et `userConfirmed: true` NE RACHÈTE RIEN — c\'est tout le sujet', () => {
    /* LE CŒUR DE L'ADR.

       Un client distant qui détient le jeton peut poser `confirm: true` aussi
       facilement qu'il a posé la demande. Accepter cette confirmation
       reviendrait à traiter comme une preuve ce qui n'est qu'un second appel
       HTTP du même appelant.

       Si ce test devient vert sur `ALLOW`, la protection L3/L4 de la
       passerelle web a disparu. */
    const v = verdict({ niveau: 'L4', surface: 'DISTANTE', confirme: true });
    expect(v.decision).toBe('DENY');
    expect(v.decision).not.toBe('ALLOW');
  });

  it('le refus EXPLIQUE, il ne se contente pas de refuser', () => {
    /* Un refus muet enverrait l'utilisateur chercher une panne là où il y a
       une règle. Le message dit quoi faire : le faire depuis la machine. */
    const v = verdict({ niveau: 'L4', surface: 'DISTANTE' });
    expect(v.reasons.join(' ')).toContain('machine');
  });
});

/* ====================================================================== *
 * CE QUE LA RÈGLE NE TOUCHE PAS — la passerelle reste utile
 * ====================================================================== */

describe('la passerelle distante garde tout ce qui ne demande rien', () => {
  it.each(['L1', 'L2'] as const)('autorise un niveau %s depuis DISTANTE', (niveau) => {
    /* Lire ses tâches, prendre une note, chercher en mémoire : rien de tout
       cela n'exige de confirmation, donc rien n'est perdu. La règle coûte
       exactement ce qu'elle doit coûter — l'irréversible, et rien d'autre. */
    expect(verdict({ niveau, surface: 'DISTANTE' }).decision).toBe('ALLOW');
  });
});

/* ====================================================================== *
 * L'ARTICULATION AVEC LES AUTRES DURCISSEMENTS
 * ====================================================================== */

describe('la règle se combine avec les durcissements existants', () => {
  it('un L2 DURCI en L3 par la proactivité est refusé à distance', () => {
    /* La règle ne lit pas le niveau DÉCLARÉ mais le niveau EFFECTIF. Sinon un
       L2 rendu L3 par un durcissement passerait à distance — c'est-à-dire que
       le durcissement aurait ouvert une porte au lieu d'en fermer une.

       C'est la même leçon que `declaredAutonomy: level` passé à Cedar : on
       interroge toujours l'état APRÈS durcissement. */
    const r = gate.decide({
      ...(demande({ niveau: 'L2', surface: 'DISTANTE' }) as Record<string, unknown>),
      context: {
        mode: 'NORMAL',
        egress: false,
        cloudEnabled: false,
        proactive: true,
        userConfirmed: false,
        surface: 'DISTANTE',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('DENY');
  });

  it('L0 reste refusé d\'où qu\'il vienne — rien ne précède l\'interdit', () => {
    expect(verdict({ niveau: 'L0', surface: 'LOCALE' }).decision).toBe('DENY');
    expect(verdict({ niveau: 'L0', surface: 'DISTANTE' }).decision).toBe('DENY');
  });

  it('la surface est REQUISE — une demande sans elle est refusée à la frontière', () => {
    /* `PolicyRequest` est validé par Zod. Une requête sans `surface` n'est pas
       traitée comme locale par défaut : elle est INVALIDE. C'est ce qui
       empêche qu'un appelant futur hérite du régime permissif en oubliant de
       se déclarer. */
    const sansSurface = demande({ niveau: 'L4', surface: 'LOCALE' }) as {
      context: Record<string, unknown>;
    };
    delete sansSurface.context['surface'];
    const r = gate.decide(sansSurface);
    expect(r.ok).toBe(false);
  });
});
