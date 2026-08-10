/**
 * MODÈLE D'EFFET PAR CIBLE — Foundation 4, ADR-031.
 *
 * `docs/19 §2` avait spécifié `PARTIAL`. Ce module l'implémente, avec la
 * correction que le mandat Foundation 4 impose :
 *
 *   > `PARTIAL` ne doit pas simplement devenir un statut. Il faut définir un
 *   > modèle d'effet. Sinon nous allons simplement déplacer le problème.
 *
 * L'unité d'effet n'est donc plus l'opération, c'est le couple
 * `(opération, cible)` :
 *
 *   Opération
 *    ├── cible A → CONFIRMED
 *    ├── cible B → CONFIRMED
 *    ├── cible C → UNKNOWN
 *    ├── cible D → FAILED
 *    └── cible E → NOT_ATTEMPTED
 *
 * et le statut global n'est plus déclaré : il est **projeté**.
 */
import { z } from 'zod';
import { EvidenceKind, VerificationStatus } from '../types/domain.js';

/**
 * Ce qui est arrivé à UNE cible.
 *
 * Le vocabulaire est celui de l'opération entière — pas un second vocabulaire.
 * Une cible peut être `UNKNOWN` pour exactement les mêmes raisons.
 */
export const TargetOutcome = z.object({
  /** Opaque au noyau : une adresse, un IBAN, un identifiant de ressource. */
  target: z.string().min(1),
  status: VerificationStatus,
  /** Ce qui fonde le statut. C'est LUI qui rend le statut défendable. */
  evidence: EvidenceKind,
  detail: z.string().default(''),
  proof: z.string().optional(),
  unknownReason: z.string().optional(),
});
export type TargetOutcome = z.infer<typeof TargetOutcome>;

/**
 * PROJECTION — le statut global se calcule, il ne se déclare pas.
 *
 * C'est la même discipline que `confirmed()`, seule fabrique de `CONFIRMED` :
 * un outil ne peut pas se dire `PARTIAL` pour éviter de trancher.
 *
 * L'ordre des règles est la sémantique :
 *
 *   1. rien du tout                        → NOT_ATTEMPTED
 *   2. toutes prouvées absentes            → FAILED
 *   3. toutes prouvées présentes           → CONFIRMED
 *   4. au moins une présente + une autre   → PARTIAL
 *   5. aucune preuve de présence           → PROBABLE si toutes probables,
 *                                            UNKNOWN sinon
 *
 * La règle 5 mérite un mot : un mélange de `FAILED` et d'`UNKNOWN` donne
 * `UNKNOWN`, jamais `FAILED`. On ne peut pas prouver l'absence globale tant
 * qu'une seule cible reste indéterminée.
 */
export function projectStatus(
  targets: readonly TargetOutcome[],
): VerificationStatus {
  if (targets.length === 0) return 'NOT_ATTEMPTED';

  const count = (status: VerificationStatus): number =>
    targets.filter((t) => t.status === status).length;

  /* LA PROJECTION NE FABRIQUE PAS DE PREUVE — ADR-030.
     Ce module RETOURNE un `CONFIRMED`, ce que seul le Verification Engine
     devrait pouvoir faire. Le test structurel de `redteam/failure-modes` l'a
     signalé, et il avait raison.
     La réponse n'est pas d'assouplir le test : c'est d'exiger que chaque cible
     porte la preuve correspondante. Une cible qui se dit `CONFIRMED` sans
     `POSITIVE_PRESENCE` ne compte pas, et la projection ne peut donc pas
     inventer un succès qu'aucune observation n'étaye. */
  const proven = (
    status: VerificationStatus,
    required: 'POSITIVE_PRESENCE' | 'POSITIVE_ABSENCE',
  ): number =>
    targets.filter((t) => t.status === status && t.evidence === required).length;

  const total = targets.length;
  const confirmed = proven('CONFIRMED', 'POSITIVE_PRESENCE');
  const notAttempted = proven('NOT_ATTEMPTED', 'POSITIVE_ABSENCE');
  const failed = proven('FAILED', 'POSITIVE_ABSENCE');
  const probable = count('PROBABLE');

  // 1. Rien n'a été tenté nulle part.
  if (notAttempted === total) return 'NOT_ATTEMPTED';

  // 2. Absence PROUVÉE partout. `NOT_ATTEMPTED` compte comme absence prouvée :
  //    ne pas avoir essayé est la meilleure preuve qu'il ne s'est rien passé.
  if (failed + notAttempted === total) return 'FAILED';

  // 3. Présence prouvée partout.
  if (confirmed === total) return 'CONFIRMED';

  // 4. Un effet réel quelque part, et pas partout. C'est exactement `PARTIAL`.
  if (confirmed > 0) return 'PARTIAL';

  // 5. Aucune preuve de présence nulle part.
  if (probable === total) return 'PROBABLE';
  return 'UNKNOWN';
}

/**
 * Les cibles qu'une reprise a le DROIT de servir.
 *
 * Le cœur de la reprise par cible, et la règle est asymétrique à dessein :
 *
 *   CONFIRMED      → jamais. Resservir, c'est doubler.
 *   NOT_ATTEMPTED  → oui. Ne pas avoir essayé est une preuve d'absence.
 *   FAILED         → oui, MAIS seulement sur preuve positive d'absence.
 *   UNKNOWN        → jamais automatiquement. Vérifier d'abord.
 *   PROBABLE       → jamais. Le fournisseur atteste, rien n'est vérifié.
 *
 * La ligne `FAILED` est celle qui a exigé le champ `evidence`. Un `FAILED`
 * fondé sur `INCONCLUSIVE` — « le fournisseur a répondu 500 » — ne prouve rien
 * et ne doit pas rouvrir l'exécution.
 */
export function resumableTargets(
  targets: readonly TargetOutcome[],
): readonly TargetOutcome[] {
  return targets.filter((t) => {
    if (t.status === 'NOT_ATTEMPTED') return true;
    if (t.status === 'FAILED') return t.evidence === 'POSITIVE_ABSENCE';
    return false;
  });
}

/**
 * Une cible peut-elle être annoncée comme servie ?
 *
 * Miroir par cible de `mayClaimSuccess`. Séparé pour que le jour où l'un des
 * deux change, la divergence saute aux yeux au lieu de s'installer.
 */
export function mayClaimTargetSuccess(outcome: TargetOutcome): boolean {
  return outcome.status === 'CONFIRMED' && outcome.evidence === 'POSITIVE_PRESENCE';
}

/** Résumé lisible d'un résultat partiel, destiné à l'utilisateur. */
export function describeTargets(targets: readonly TargetOutcome[]): string {
  const groups = new Map<VerificationStatus, string[]>();
  for (const outcome of targets) {
    const list = groups.get(outcome.status) ?? [];
    list.push(outcome.target);
    groups.set(outcome.status, list);
  }

  const phrase: Partial<Record<VerificationStatus, string>> = {
    CONFIRMED: 'reçu',
    FAILED: "n'a pas reçu",
    UNKNOWN: 'incertain',
    NOT_ATTEMPTED: 'non tenté',
    PROBABLE: 'annoncé sans preuve',
    PARTIAL: 'partiel',
  };

  return [...groups.entries()]
    .map(([status, list]) => `${list.join(', ')} : ${phrase[status] ?? status}`)
    .join(' · ');
}
