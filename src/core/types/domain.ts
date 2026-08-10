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
  'SYSTEM', // produit par le NOYAU lui-même — fiable
  'MEMORY', // relu depuis la mémoire — fiable au niveau de confiance stocké
  'TOOL_OUTPUT', // sortie d'un de nos outils typés — semi-fiable
  'MODEL_OUTPUT', // déduit par un modèle — JAMAIS une autorité (ADR-024)
  'EXTERNAL_UNTRUSTED', // email, PDF, web, serveur MCP tiers — JAMAIS une instruction
]);
export type Provenance = z.infer<typeof Provenance>;

/**
 * Les provenances qui ne peuvent jamais alimenter un paramètre sensible sans
 * confirmation portant sur la VALEUR.
 *
 * `MODEL_OUTPUT` y figure depuis l'audit `docs/11` (CRIT-2). Il manquait, et
 * l'omission était invisible : `MODEL_INFERRED` était rangé en `SYSTEM`,
 * c'est-à-dire avec ce que le noyau produit lui-même. Une IA pouvait ainsi
 * s'auto-élever au rang d'autorité — l'inverse exact de S1 (ADR-024).
 *
 * Les deux provenances non fiables le sont pour des raisons différentes, et la
 * distinction se paierait cher si on la perdait :
 *   `EXTERNAL_UNTRUSTED` — un tiers l'a écrit, il peut être hostile ;
 *   `MODEL_OUTPUT`       — personne n'est hostile, mais rien ne garantit que
 *                          la déduction soit exacte.
 */
const UNTRUSTED_PROVENANCES: ReadonlySet<Provenance> = new Set<Provenance>([
  'EXTERNAL_UNTRUSTED',
  'MODEL_OUTPUT',
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
  'CONFIRMED', // preuve POSITIVE que l'effet a eu lieu
  'PROBABLE', // le fournisseur atteste, aucune relecture indépendante
  'PARTIAL', // certaines cibles confirmées, d'autres non — projection
  'UNKNOWN', // aucune preuve suffisante dans un sens ni dans l'autre
  'FAILED', // preuve POSITIVE que l'effet n'a PAS eu lieu
  'NOT_ATTEMPTED', // rien n'a été tenté — distinct d'un échec
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/**
 * LA HIÉRARCHIE DE PREUVE — Foundation 4.
 *
 * C'est la correction sémantique la plus importante du projet, et elle tient en
 * une symétrie :
 *
 *   CONFIRMED   ← preuve positive d'EFFET
 *   FAILED      ← preuve positive d'ABSENCE d'effet
 *   UNKNOWN     ← aucune preuve suffisante
 *
 * `FAILED` cessait d'être vrai dès qu'un fournisseur traitait de façon
 * asynchrone : « je ne vois rien » n'est pas « il n'y a rien ». Un accusé de
 * réception suivi d'un traitement différé produisait `FAILED` pour une action
 * qui aboutissait trois cents millisecondes plus tard.
 *
 * Quatre corollaires, tous testés :
 *
 *   timeout           ≠ FAILED
 *   500               ≠ FAILED
 *   connection reset  ≠ FAILED
 *   ACK sans preuve   ≠ CONFIRMED
 */
export const EvidenceKind = z.enum([
  /** L'effet a été OBSERVÉ. Seule preuve qui autorise `CONFIRMED`. */
  'POSITIVE_PRESENCE',
  /**
   * L'absence d'effet a été observée, ET l'observation est CONCLUANTE.
   *
   * Elle ne l'est que si la fenêtre d'observation est fermée : un fournisseur
   * synchrone, ou une ressource transactionnelle. Face à une file d'attente,
   * « zéro ligne » ne prouve rien.
   */
  'POSITIVE_ABSENCE',
  /** Une observation a eu lieu, elle ne tranche pas. */
  'INCONCLUSIVE',
  /** Aucune observation n'a été possible. */
  'NONE',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * Ce qu'un outil est CAPABLE de prouver — Foundation 4.
 *
 * Distinct de `verification`, qui dit COMMENT il s'y prend. Ici on déclare ce
 * qu'il peut établir, et la déclaration est vérifiée à l'enregistrement.
 *
 *   VERIFIABLE     peut prouver la présence ET l'absence
 *                  → fichier créé, ligne en base, événement d'agenda
 *
 *   OBSERVABLE     peut prouver la présence, JAMAIS l'absence
 *                  → un email : on peut voir qu'il est parti, on ne peut pas
 *                    prouver qu'il ne partira pas
 *
 *   UNVERIFIABLE   ne peut établir ni l'une ni l'autre
 *                  → un webhook chez un tiers sans API de consultation
 */
export const Verifiability = z.enum(['VERIFIABLE', 'OBSERVABLE', 'UNVERIFIABLE']);
export type Verifiability = z.infer<typeof Verifiability>;

/**
 * CONTRAT D'EFFET — Foundation 4.1, ADR-033.
 *
 * Ce champ décide d'UNE seule chose, et c'est la plus importante du système :
 *
 *     qu'a-t-on le droit de faire après un `UNKNOWN` ?
 *
 * POURQUOI IL REMPLACE `effect`
 * -----------------------------
 * `effect: LOCAL_TRANSACTIONAL | EXTERNAL` répondait à « une erreur prouve-t-elle
 * l'absence ? ». Utile, mais insuffisant : parmi les effets externes, certains
 * peuvent être rejoués sans danger et d'autres jamais. Confondre les deux a
 * produit le double effet mesuré en `docs/21 §2`.
 *
 * LA QUESTION QUE LE MOTEUR NE DOIT PLUS POSER
 * --------------------------------------------
 * Pas « puis-je réessayer ? » — question à laquelle on répond par optimisme.
 * Mais « quel contrat d'effet possède cet outil ? » — question à laquelle on
 * répond par lecture.
 */
export const EffectContract = z.enum([
  /** Lecture pure. Rejouer est sans conséquence. */
  'NO_EXTERNAL_EFFECT',
  /**
   * Effet écrit dans la MÊME base que le journal d'intention.
   *
   * Une erreur entraîne un `ROLLBACK` : l'absence est garantie par PostgreSQL,
   * et aucune requête ne peut « rester en vol ».
   */
  'LOCAL_TRANSACTIONAL',
  /**
   * Le FOURNISSEUR garantit qu'une même identité d'opération ne produit jamais
   * deux effets.
   *
   * C'est le SEUL contrat externe qui autorise un rejeu — et il l'autorise
   * pour une raison qui ne dépend pas de notre observation : même si une
   * requête antérieure aboutit plus tard, le fournisseur la dédoublonne.
   */
  'PROVIDER_IDEMPOTENT',
  /**
   * Le fournisseur est interrogeable, mais NON idempotent.
   *
   * On peut donc faire passer un `UNKNOWN` à `CONFIRMED`. On ne peut JAMAIS
   * rejouer : « je n'ai rien vu à l'instant t » ne prouve pas qu'une requête
   * ne soit pas encore en vol.
   */
  'EXTERNALLY_VERIFIABLE',
  /** Ni idempotent, ni interrogeable. `UNKNOWN` est définitif. */
  'UNVERIFIABLE',
]);
export type EffectContract = z.infer<typeof EffectContract>;

/**
 * LA CONDITION DE REJEU — ADR-034.
 *
 * La règle n'est PAS une liste de contrats. C'est une condition :
 *
 *   > Une opération externe après `UNKNOWN` n'est rejouable que si son contrat
 *   > fournit une garantie DÉMONTRABLE que le rejeu ne peut produire un second
 *   > effet.
 *
 * POURQUOI CETTE DISTINCTION N'EST PAS COSMÉTIQUE
 * ----------------------------------------------
 * ADR-033 écrivait « `PROVIDER_IDEMPOTENT` est le seul contrat externe
 * rejouable ». C'est vrai aujourd'hui, et ce serait une erreur de l'encoder
 * comme une vérité éternelle : d'autres mécanismes satisfont la même condition
 * sans être une clé d'idempotence —
 *
 *   transaction distribuée à deux phases · réservation puis validation ·
 *   déduplication portée par la ressource · opération intrinsèquement
 *   idempotente (un `PUT` absolu) · compensation vérifiée
 *
 * Figer la liste aurait verrouillé l'architecture sur le premier mécanisme
 * rencontré. On énonce donc la condition, et on tient le registre de ce qui la
 * satisfait.
 *
 * CE QUE CHAQUE ENTRÉE DOIT JUSTIFIER
 * -----------------------------------
 * `independentOfObservation` est le champ qui coûte, et c'est lui qui trie.
 * Une garantie qui dépend de ce que NOUS observons ne vaut rien face à une
 * requête encore en vol : au moment où on regarde, il n'y a rien à voir
 * (`docs/21 §2`).
 */
export interface ReplaySafety {
  /** La garantie invoquée. Doit être démontrable, pas plausible. */
  readonly guarantee: string;
  /** Pourquoi elle ne dépend PAS de notre observation à l'instant t. */
  readonly independentOfObservation: string;
}

/**
 * Registre des contrats qui satisfont la condition, avec leur justification.
 *
 * `Partial<Record<…>>` sur l'énumération complète : ajouter un contrat sans
 * décider s'il entre ici reste un choix visible, et l'omission vaut refus —
 * `FAIL CLOSED` appliqué à l'extension du registre.
 */
const REPLAY_SAFE_CONTRACTS: Partial<Record<EffectContract, ReplaySafety>> = {
  NO_EXTERNAL_EFFECT: {
    guarantee: "aucun effet externe n'existe, donc aucun doublon n'est possible",
    independentOfObservation: 'propriété de l\'opération elle-même',
  },
  LOCAL_TRANSACTIONAL: {
    guarantee: 'une erreur entraîne un ROLLBACK PostgreSQL',
    independentOfObservation:
      'garanti par le moteur transactionnel ; aucune requête ne peut rester ' +
      'en vol hors de la transaction',
  },
  PROVIDER_IDEMPOTENT: {
    guarantee:
      "le fournisseur refuse lui-même un second effet pour une même identité " +
      "d'opération",
    independentOfObservation:
      "c'est le fournisseur qui dédoublonne, pas nous qui constatons — la " +
      'garantie tient même si une requête antérieure aboutit dix minutes plus tard',
  },
};

/**
 * Un rejeu est-il autorisé après un `UNKNOWN` ?
 *
 * Ne décide de rien par elle-même : elle CONSULTE le registre. Toute la
 * substance est dans les justifications ci-dessus, et c'est voulu — un `switch`
 * aurait caché le raisonnement derrière une liste de `return true`.
 */
export function mayReplayAfterUnknown(contract: EffectContract): boolean {
  return REPLAY_SAFE_CONTRACTS[contract] !== undefined;
}

/**
 * Pourquoi ce contrat autorise-t-il un rejeu ?
 *
 * Sert à répondre à « pourquoi refuses-tu de recommencer ? » — ou à
 * « pourquoi t'autorises-tu à recommencer ? », question qu'on doit pouvoir
 * poser tout autant.
 */
export function replaySafetyOf(contract: EffectContract): ReplaySafety | undefined {
  return REPLAY_SAFE_CONTRACTS[contract];
}

/** Cet effet échappe-t-il à nos transactions ? */
export function isExternalEffect(contract: EffectContract): boolean {
  return contract !== 'NO_EXTERNAL_EFFECT' && contract !== 'LOCAL_TRANSACTIONAL';
}

/**
 * Un statut autorise-t-il à parler d'un effet accompli ?
 *
 * Volontairement séparé de `mayClaimSuccess` : `PARTIAL` décrit bien un effet
 * réel sur certaines cibles, sans autoriser à dire « c'est fait ».
 */
export function hasAnyEffect(status: VerificationStatus): boolean {
  return status === 'CONFIRMED' || status === 'PARTIAL';
}

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
      // Surtout PAS 'SYSTEM'. Voir ADR-024 : une déduction de modèle n'est pas
      // une production du noyau, et ne doit jamais en hériter la confiance.
      return 'MODEL_OUTPUT';
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
/* États de connaissance — ADR-025 §A                                         */
/* -------------------------------------------------------------------------- */

/**
 * « Que sais-tu, au juste ? »
 *
 * TROIS AXES INDÉPENDANTS, ET C'EST LE POINT.
 *
 * Une énumération unique aurait paru plus simple une semaine, puis serait
 * devenue indécidable : que vaut une information à la fois contradictoire et
 * périmée ? Le code aurait dû choisir, et aurait choisi mal.
 *
 * Les trois axes se combinent librement :
 *
 *   KNOWN   + STALE      + IN_SCOPE        « 4 800 €, mais ça date de 8 mois »
 *   KNOWN   + VERIFIED   + IN_SCOPE        « 4 800 €, relu à l'instant »
 *   UNKNOWN + UNVERIFIED + NOT_AUTHORIZED  « rien trouvé — tes emails me sont fermés »
 */

/** Axe 1 — que sait-on ? */
export const KnowledgeVerdict = z.enum([
  'KNOWN', // une réponse existe
  'UNKNOWN', // aucune réponse dans ce qui a été consulté
  'CONFLICTING', // plusieurs réponses incompatibles, sans arbitrage possible
]);
export type KnowledgeVerdict = z.infer<typeof KnowledgeVerdict>;

/** Axe 2 — quel crédit lui accorder ? */
export const KnowledgeQuality = z.enum([
  'VERIFIED', // relu contre l'état réel
  'UNVERIFIED', // jamais recoupé depuis l'enregistrement
  'STALE', // recoupé autrefois, mais l'information a vieilli
]);
export type KnowledgeQuality = z.infer<typeof KnowledgeQuality>;

/**
 * Axe 3 — où a-t-on cherché, et surtout : où n'a-t-on PAS cherché ?
 *
 * C'est le prolongement direct du `scope` posé au Sprint 1. Il répond à la
 * question que l'utilisateur ne pense pas à poser, et dont dépend pourtant
 * toute la valeur de la réponse.
 */
export const KnowledgeScope = z.enum([
  'IN_SCOPE', // la source était accessible et a été consultée
  'OUT_OF_SCOPE', // Jarvis ne sait pas atteindre cette source — capacité absente
  'NOT_AUTHORIZED', // la source existe, l'accès n'a pas été accordé
]);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

/** Ce qu'une source a donné, et ce qu'elle n'a pas pu donner. */
export interface SourceCoverage {
  readonly source: string;
  readonly scope: KnowledgeScope;
  /** Lisible par un humain. Affiché tel quel, jamais reformulé. */
  readonly detail: string;
}

/**
 * Une réponse complète : le verdict, sa qualité, et la couverture réelle.
 *
 * Les trois voyagent ensemble. Séparer le verdict de sa couverture, c'est
 * rendre possible « je n'ai rien trouvé » sans « je n'ai pas regardé partout ».
 */
export interface KnowledgeAnswer {
  readonly verdict: KnowledgeVerdict;
  readonly quality: KnowledgeQuality;
  readonly coverage: readonly SourceCoverage[];
}

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
