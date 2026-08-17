/**
 * Vocabulaire du Policy Gate.
 *
 * Référence : 03 §4 et §5, ADR-005.
 *
 * Séparation des responsabilités, à garder en tête en lisant ce module :
 *
 *   Cedar répond à  « cet acteur a-t-il le DROIT ? »        → ALLOW | DENY
 *   Le Gate répond à « quelle CÉRÉMONIE cela exige-t-il ? » → ALLOW | CONFIRM | DENY
 *
 * Confondre les deux est l'erreur qui rend un moteur d'autorisation inutile.
 */
import { z } from 'zod';
import {
  Actor,
  AutonomyLevel,
  DataLevel,
  Mode,
  PrivacyClass,
  Provenance,
} from '../types/domain.js';

/** Un paramètre d'appel d'outil, avec sa provenance. */
export const PolicyParameter = z.object({
  name: z.string().min(1),
  provenance: Provenance,
  /**
   * Un paramètre est « sensible » quand une valeur erronée cause un dommage :
   * destinataire, montant, identifiant, chemin de fichier, URL.
   * C'est le contrat d'outil qui le déclare, pas le modèle.
   */
  sensitive: z.boolean(),
});
export type PolicyParameter = z.infer<typeof PolicyParameter>;

export const PolicyRequest = z.object({
  actor: Actor,

  action: z.object({
    tool: z.string().min(1),
    operation: z.string().min(1),
  }),

  /** Niveau exigé par le contrat d'outil. Le Gate peut le durcir, jamais l'assouplir. */
  declaredAutonomy: AutonomyLevel,

  resource: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    privacyClass: PrivacyClass,
    /**
     * Niveau `docs/14`, DÉRIVÉ de la catégorie par le système — jamais déclaré
     * par l'outil ni par un modèle (`docs/14 §3`).
     *
     * Il coexiste avec `privacyClass` au lieu de le remplacer : la bascule des
     * données stockées est le seul pas du Data Firewall qui ÉLARGIT, et elle
     * n'a pas eu lieu (ADR-050).
     */
    dataLevel: DataLevel,
  }),

  context: z.object({
    mode: Mode,
    /** L'action provoque-t-elle une sortie réseau ? (03 §6) */
    egress: z.boolean(),
    cloudEnabled: z.boolean(),
    /** L'action est-elle proactive, c'est-à-dire non demandée à l'instant ? */
    proactive: z.boolean(),
    /** L'utilisateur a-t-il confirmé cette action précise, sur sa valeur concrète ? */
    userConfirmed: z.boolean(),
  }),

  parameters: z.array(PolicyParameter).default([]),
});
export type PolicyRequest = z.infer<typeof PolicyRequest>;

export const GateDecision = z.enum(['ALLOW', 'DENY', 'CONFIRM']);
export type GateDecision = z.infer<typeof GateDecision>;

export interface PolicyOutcome {
  readonly decision: GateDecision;
  /** Niveau réellement appliqué, après durcissements. Jamais < declaredAutonomy. */
  readonly effectiveAutonomy: AutonomyLevel;
  /**
   * Motifs lisibles. Alimentent la réponse à « pourquoi une confirmation était
   * requise ? » (P6 du PRD) et le journal d'audit.
   */
  readonly reasons: readonly string[];
}
