/**
 * Interface du moteur d'évaluation de politique.
 *
 * ADR-003 : le noyau ne connaît aucun fournisseur. Cedar est un détail
 * d'implémentation vivant dans `src/providers/policy/`, et l'ADR-005 prévoit
 * explicitement de pouvoir basculer sur OPA sans réécriture.
 */
import type { Result } from '../types/result.js';
import type { PolicyRequest } from './types.js';

export type PermissionDecision = 'ALLOW' | 'DENY';

export interface PermissionVerdict {
  readonly decision: PermissionDecision;
  /** Identifiants des politiques ayant déterminé la décision — pour l'audit. */
  readonly determiningPolicies: readonly string[];
}

export interface PolicyEvaluator {
  /**
   * Répond uniquement à la question de la permission.
   *
   * Ne doit jamais renvoyer « CONFIRM » : la cérémonie relève du Gate, pas du
   * moteur. Un moteur qui déciderait de la confirmation deviendrait la logique
   * produit, ce que l'ADR-005 refuse.
   */
  evaluate(request: PolicyRequest): Result<PermissionVerdict>;
}
