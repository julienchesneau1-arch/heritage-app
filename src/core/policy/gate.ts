/**
 * Policy Gate — la porte.
 *
 * Référence : 03 §4 et §5, ADR-005, invariants S4/S5.
 *
 * PROPRIÉTÉ STRUCTURANTE DE CE MODULE
 * ------------------------------------
 * Le niveau d'autonomie ne peut que **monter**. Il n'existe volontairement
 * aucune fonction ici capable d'abaisser un niveau, et les durcissements sont
 * combinés par `strictest()`. C'est ce qui rend impossible, par construction,
 * qu'une règle apprise ou une préférence assouplisse une règle dure — plutôt
 * que de compter sur la vigilance du prochain lecteur.
 *
 *   « Politique dure : un paiement exige toujours confirmation.
 *     Mémoire : Julien approuve généralement les achats sous 50 €.
 *     Résultat : le paiement exige toujours confirmation. »  (03 §5)
 */
import { strictest, isUntrusted, type AutonomyLevel } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { PolicyEvaluator } from './evaluator.js';
import {
  PolicyRequest,
  type GateDecision,
  type PolicyOutcome,
} from './types.js';

export interface PolicyGate {
  /** `request` est typé `unknown` : c'est une frontière, validée à l'exécution. */
  decide(request: unknown): Result<PolicyOutcome>;
}

/** Les niveaux qui exigent une intervention humaine avant exécution. */
function requiresConfirmation(level: AutonomyLevel): boolean {
  return level === 'L3' || level === 'L4';
}

export function createPolicyGate(evaluator: PolicyEvaluator): PolicyGate {
  return {
    decide(request: unknown): Result<PolicyOutcome> {
      const parsed = PolicyRequest.safeParse(request);
      if (!parsed.success) {
        return err(
          jarvisError('VALIDATION', 'Requête de politique invalide', {
            issues: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(' | '),
          }),
        );
      }
      const req = parsed.data;
      const reasons: string[] = [];

      /* ------------------------------------------------------------------ */
      /* 1. L0 — court-circuit. Rien ne peut autoriser une action interdite. */
      /* ------------------------------------------------------------------ */
      if (req.declaredAutonomy === 'L0') {
        return ok({
          decision: 'DENY',
          effectiveAutonomy: 'L0',
          reasons: ['Action de niveau L0 : interdite par construction.'],
        });
      }

      /* ------------------------------------------------------------------ */
      /* 2. Durcissements. Ils ne peuvent que monter le niveau.             */
      /* ------------------------------------------------------------------ */
      let level: AutonomyLevel = req.declaredAutonomy;

      // 2a. Provenance non fiable sur un paramètre sensible (03 §3, T1).
      // C'est la défense qui tient même quand le modèle a été convaincu :
      // l'utilisateur doit confirmer la VALEUR concrète, pas l'intention.
      const taintedSensitive = req.parameters.filter(
        (p) => p.sensitive && isUntrusted(p.provenance),
      );
      if (taintedSensitive.length > 0) {
        level = strictest(level, 'L4');
        reasons.push(
          `Paramètre(s) sensible(s) d'origine non fiable : ${taintedSensitive
            .map((p) => p.name)
            .join(', ')}. Confirmation sur la valeur exigée.`,
        );
      }

      // 2b. Garde de proactivité (03 §4).
      // Une action proactive ne peut jamais être plus permissive qu'une action
      // explicite : ce qui s'exécuterait seul sur demande doit être approuvé
      // quand personne n'a rien demandé.
      if (req.context.proactive && !requiresConfirmation(level)) {
        level = strictest(level, 'L3');
        reasons.push(
          'Action proactive : approbation requise, une action non sollicitée ' +
            'ne peut pas être plus permissive qu\'une action explicite.',
        );
      }

      // 2c. Sortie réseau d'une donnée RED (03 §6). Le Data Firewall bloquera
      // aussi en aval ; le Gate refuse ici pour que l'action ne soit même pas
      // préparée.
      if (req.context.egress && req.resource.privacyClass === 'RED') {
        return ok({
          decision: 'DENY',
          effectiveAutonomy: level,
          reasons: [
            ...reasons,
            'Donnée classée RED : aucune sortie réseau, sans exception.',
          ],
        });
      }

      // 2d. Mode privé (03 §7).
      if (req.context.mode === 'PRIVATE' && req.context.egress) {
        return ok({
          decision: 'DENY',
          effectiveAutonomy: level,
          reasons: [...reasons, 'Mode privé actif : aucune sortie réseau.'],
        });
      }

      /* ------------------------------------------------------------------ */
      /* 3. Permission — délégué au moteur (Cedar).                         */
      /* ------------------------------------------------------------------ */
      const verdict = evaluator.evaluate({
        ...req,
        // Le moteur est interrogé sur le niveau DURCI, jamais sur le niveau
        // déclaré : sinon un durcissement du Gate pourrait être contourné par
        // une politique écrite pour le niveau d'origine.
        declaredAutonomy: level,
      });
      if (!verdict.ok) return verdict;

      if (verdict.value.decision === 'DENY') {
        return ok({
          decision: 'DENY',
          effectiveAutonomy: level,
          reasons: [
            ...reasons,
            verdict.value.determiningPolicies.length > 0
              ? `Refusé par la politique : ${verdict.value.determiningPolicies.join(', ')}.`
              : 'Aucune politique n\'autorise cette action (refus par défaut).',
          ],
        });
      }

      /* ------------------------------------------------------------------ */
      /* 4. Cérémonie — notre décision, pas celle du moteur.                */
      /* ------------------------------------------------------------------ */
      let decision: GateDecision;
      if (requiresConfirmation(level)) {
        if (req.context.userConfirmed) {
          decision = 'ALLOW';
          reasons.push('Confirmation explicite de l\'utilisateur obtenue.');
        } else {
          decision = 'CONFIRM';
          reasons.push(
            `Niveau ${level} : préparation autorisée, exécution soumise à confirmation.`,
          );
        }
      } else {
        decision = 'ALLOW';
      }

      return ok({ decision, effectiveAutonomy: level, reasons });
    },
  };
}
