/**
 * Vocabulaire du domaine Jarvis.
 *
 * Ces types ne sont pas décoratifs : ils encodent les invariants de `03`.
 * Zod est la source de vérité et les types TypeScript en sont dérivés, de sorte
 * qu'une valeur ne peut pas entrer dans le noyau sans avoir été validée à
 * l'exécution (ADR-016).
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Provenance — 03 §3                                                         */
/* -------------------------------------------------------------------------- */

/**
 * D'où vient une valeur. C'est l'étiquette qui permet au Tool Gateway de
 * refuser un paramètre sensible issu d'une source non fiable, même quand le
 * modèle a été convaincu de le proposer.
 */
export const Provenance = z.enum([
  'USER', // formulé directement par l'utilisateur — fiable
  'SYSTEM', // produit par le noyau lui-même — fiable
  'MEMORY', // relu depuis la mémoire — fiable au niveau de confiance stocké
  'TOOL_OUTPUT', // sortie d'un de nos outils typés — semi-fiable
  'EXTERNAL_UNTRUSTED', // email, PDF, web, serveur MCP tiers — JAMAIS une instruction
]);
export type Provenance = z.infer<typeof Provenance>;

/** Les provenances qui ne peuvent jamais alimenter un paramètre sensible sans confirmation. */
const UNTRUSTED_PROVENANCES: ReadonlySet<Provenance> = new Set<Provenance>([
  'EXTERNAL_UNTRUSTED',
]);

export function isUntrusted(p: Provenance): boolean {
  return UNTRUSTED_PROVENANCES.has(p);
}

/** Une valeur transportant sa provenance. Le noyau ne manipule jamais de nu. */
export interface Tainted<T> {
  readonly value: T;
  readonly provenance: Provenance;
  /** Identifiant de la source concrète (id d'email, URL, nom du serveur MCP…). */
  readonly sourceId?: string;
}

export function tainted<T>(
  value: T,
  provenance: Provenance,
  sourceId?: string,
): Tainted<T> {
  return sourceId === undefined
    ? { value, provenance }
    : { value, provenance, sourceId };
}

/* -------------------------------------------------------------------------- */
/* Classification de confidentialité — 03 §6                                  */
/* -------------------------------------------------------------------------- */

export const PrivacyClass = z.enum([
  'RED', // secrets, données financières, mémoire privée — jamais le cloud
  'ORANGE', // agenda, tâches, préférences — cloud sur autorisation explicite
  'GREEN', // public ou non sensible
]);
export type PrivacyClass = z.infer<typeof PrivacyClass>;

/* -------------------------------------------------------------------------- */
/* Niveaux d'autonomie — 03 §4                                                */
/* -------------------------------------------------------------------------- */

export const AutonomyLevel = z.enum([
  'L0', // FORBIDDEN — impossible pour Jarvis
  'L1', // READ — lecture seule
  'L2', // AUTO — automatique, réversible, faible risque
  'L3', // APPROVAL — préparer puis demander validation
  'L4', // EXPLICIT — confirmation forte + authentification additionnelle
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

const AUTONOMY_ORDER: Record<AutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

/**
 * Compare deux niveaux d'autonomie.
 * Un niveau « supérieur » est plus contraignant, pas plus permissif.
 */
export function isAtLeastAsStrict(a: AutonomyLevel, b: AutonomyLevel): boolean {
  return AUTONOMY_ORDER[a] >= AUTONOMY_ORDER[b];
}

/** Le niveau le plus contraignant des deux. Utilisé pour combiner des règles. */
export function strictest(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return AUTONOMY_ORDER[a] >= AUTONOMY_ORDER[b] ? a : b;
}

/* -------------------------------------------------------------------------- */
/* Honnêteté systémique — 00 §I4                                              */
/* -------------------------------------------------------------------------- */

/**
 * L'état d'une action après vérification.
 *
 * La règle absolue : rien ne promeut jamais un état vers CONFIRMED, sauf le
 * Verification Engine sur preuve du fournisseur. Il n'existe volontairement
 * aucune fonction dans ce module capable de fabriquer un CONFIRMED.
 */
export const VerificationStatus = z.enum([
  'CONFIRMED', // état réel relu et conforme à l'attendu
  'PROBABLE', // l'exécution a réussi mais la relecture est impossible
  'UNKNOWN', // on ne sait pas — et on le dit
  'FAILED', // échec constaté
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/* -------------------------------------------------------------------------- */
/* Acteurs — 03, PRD §127                                                     */
/* -------------------------------------------------------------------------- */

export const Actor = z.enum([
  'USER',
  'JARVIS',
  'SYSTEM',
  'AUTOMATION',
  'EXTERNAL_SERVICE',
]);
export type Actor = z.infer<typeof Actor>;

/* -------------------------------------------------------------------------- */
/* Origine épistémique — 09 §2.1                                              */
/* -------------------------------------------------------------------------- */

/**
 * Comment le sait-on ?
 *
 * Axe DISTINCT de `Provenance`, et la distinction est le point :
 *
 *   `Provenance`  → axe de SÉCURITÉ : cette valeur peut-elle alimenter un
 *                   paramètre sensible ? (consommé par le Policy Gate)
 *   `SourceType`  → axe ÉPISTÉMIQUE : quel crédit mérite cette information ?
 *
 * Sans ce second axe, « Julien préfère le matin » déclaré par Julien et la
 * même phrase déduite de ses propos sont indistinguables une fois écrites.
 */
export const SourceType = z.enum([
  'USER_EXPLICIT', // déclaré ET confirmé par l'utilisateur
  'USER_INFERRED', // déduit de ses propos, non confirmé
  'MODEL_INFERRED', // déduit par un modèle
  'TOOL_VERIFIED', // constaté par un outil contre l'état réel
  'EXTERNAL_SOURCE', // affirmé par un email, un PDF, une page web
  'SYSTEM', // produit par le noyau
]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * Provenance dérivée de l'origine.
 *
 * Dériver plutôt que demander supprime une classe entière d'incohérences :
 * il devient impossible de déclarer une source externe avec une provenance de
 * confiance. La base impose d'ailleurs la même cohérence
 * (`source_matches_provenance`).
 */
export function provenanceOf(source: SourceType): Provenance {
  switch (source) {
    case 'USER_EXPLICIT':
    case 'USER_INFERRED':
      return 'USER';
    case 'TOOL_VERIFIED':
      return 'TOOL_OUTPUT';
    case 'EXTERNAL_SOURCE':
      return 'EXTERNAL_UNTRUSTED';
    case 'MODEL_INFERRED':
    case 'SYSTEM':
      return 'SYSTEM';
  }
}

/* -------------------------------------------------------------------------- */
/* Catégorie de donnée — clé de la Data Policy (09 §2.1)                      */
/* -------------------------------------------------------------------------- */

/**
 * De quoi parle cette donnée ?
 *
 * Clé de la table « donnée × local/cloud » à venir. Elle doit être renseignée
 * À L'ÉCRITURE : une mémoire écrite sans catégorie restera sans catégorie.
 */
export const DataCategory = z.enum([
  'WEATHER',
  'TASK',
  'CALENDAR',
  'CONTACT',
  'LOCATION',
  'EMAIL',
  'MESSAGE',
  'DOCUMENT',
  'FINANCIAL',
  'HEALTH',
  'CREDENTIAL',
  'PERSONAL_MEMORY',
  'PROJECT',
  'OTHER',
]);
export type DataCategory = z.infer<typeof DataCategory>;

/**
 * Catégories qui ne peuvent jamais être classées autrement que RED.
 *
 * « Les secrets ne sortent jamais » cesse d'être une convention applicative :
 * c'est une contrainte de base (`sensitive_categories_are_red`), et le Guard
 * corrige la classification plutôt que de laisser passer.
 */
const ALWAYS_RED: ReadonlySet<DataCategory> = new Set<DataCategory>([
  'CREDENTIAL',
  'FINANCIAL',
  'HEALTH',
]);

export function requiresRed(category: DataCategory): boolean {
  return ALWAYS_RED.has(category);
}

/* -------------------------------------------------------------------------- */
/* Classification de mémoire — 03 §11                                         */
/* -------------------------------------------------------------------------- */

export const MemoryKind = z.enum([
  'FACT', // explicitement confirmé par l'utilisateur
  'INFERENCE', // déduit par le système
  'HYPOTHESIS', // hypothèse, à confirmer
  'EXTERNAL_CLAIM', // affirmé par une source externe — n'est JAMAIS un fait
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/* -------------------------------------------------------------------------- */
/* Modes — PRD §66                                                            */
/* -------------------------------------------------------------------------- */

export const Mode = z.enum([
  'NORMAL',
  'PRIVATE',
  'MEETING',
  'DRIVING',
  'FOCUS',
  'TRAVEL',
  'HOME',
]);
export type Mode = z.infer<typeof Mode>;
