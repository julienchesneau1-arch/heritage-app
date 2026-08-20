/**
 * UPDATE ENGINE — le vocabulaire d'une version candidate. `docs/07`, Phase 7.
 *
 * `CLAUDE.md` règle 5 : *« Aucune mise à jour ne va directement en production. »*
 * Ce module donne à cette phrase des types, et au module voisin de quoi la
 * faire respecter.
 *
 * ⚠ CE QUI EST CONSTRUIT, ET CE QUI NE L'EST PAS
 * ---------------------------------------------------------------------------
 * `docs/07` décrit un pipeline en douze étapes. Ce qui suit en implémente
 * **une seule** — celle qui DÉCIDE — et il faut le dire avant de lire la
 * suite :
 *
 * ```text
 * CONSTRUIT    décider si une version a le droit d'être promue
 *              décider si une version en production doit être retirée
 *              garantir que le LAB n'a pas les secrets de production
 *
 * NON CONSTRUIT  vérifier une signature (TUF/Sigstore, §4)
 *                installer, promouvoir, retirer réellement (§1)
 *                le canary sur trafic réel (§8)
 *                les backups et la reprise après sinistre (§11, §12)
 * ```
 *
 * La distinction n'est pas un aveu, c'est la même que `docs/26 §4.10` fait
 * pour l'annulation : **vrai au sens de la DÉCISION, faux au sens de
 * l'EXÉCUTION.** Les confondre serait dire que Jarvis sait se mettre à jour
 * alors qu'il sait seulement dire non.
 *
 * ET C'EST LA MOITIÉ QU'IL FALLAIT ÉCRIRE D'ABORD
 * ---------------------------------------------------------------------------
 * Pour la raison qui a présidé au CostGate (ADR-040) et au `Tier 1` (ADR-081) :
 * **l'enveloppe de sûreté s'écrit à froid.** Clouer « une signature non
 * vérifiée est refusée » est facile aujourd'hui ; ça le sera beaucoup moins le
 * jour où une mise à jour de sécurité urgente attendra derrière ce refus.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Canaux — `docs/07 §10`                                                     */
/* -------------------------------------------------------------------------- */

/**
 * La production consomme `STABLE` et `SECURITY`, jamais les deux autres.
 *
 * `SECURITY` n'est pas un raccourci : `docs/07 §10` est explicite —
 * *« l'urgence d'un correctif de sécurité raccourcit les délais, jamais le
 * pipeline »*. Il est donc traité exactement comme `STABLE` par la décision,
 * et ne diffère que par la PRIORITÉ, qui n'est pas une propriété de ce module.
 */
export const Canal = z.enum(['SECURITY', 'STABLE', 'BETA', 'EXPERIMENTAL']);
export type Canal = z.infer<typeof Canal>;

const CANAUX_DE_PRODUCTION: ReadonlySet<Canal> = new Set<Canal>(['SECURITY', 'STABLE']);

export function canalAdmisEnProduction(canal: Canal): boolean {
  return CANAUX_DE_PRODUCTION.has(canal);
}

/* -------------------------------------------------------------------------- */
/* Signature — `docs/07 §4`                                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'état de vérification d'un artefact.
 *
 * ⚠ `NON_VERIFIABLE` EXISTE, ET C'EST DÉLIBÉRÉ. On aurait pu se contenter de
 * `VERIFIEE | INVALIDE`. Mais « je n'ai pas pu vérifier » n'est ni « c'est
 * bon » ni « c'est faux » — c'est une troisième chose, et la confondre avec
 * l'une des deux est exactement le défaut que `VerificationStatus` corrige
 * ailleurs dans ce dépôt (`UNKNOWN` n'est pas `FAILED`).
 *
 * La décision les traite pareil — toutes trois refusent — mais le JOURNAL et
 * le message à l'utilisateur ne disent pas la même chose : « signature
 * invalide » appelle une alerte, « vérificateur injoignable » appelle un
 * réessai.
 */
export const EtatSignature = z.enum([
  'VERIFIEE',
  'INVALIDE',
  'ABSENTE',
  'NON_VERIFIABLE',
]);
export type EtatSignature = z.infer<typeof EtatSignature>;

/* -------------------------------------------------------------------------- */
/* Portée — `docs/07 §3`                                                      */
/* -------------------------------------------------------------------------- */

/**
 * CE QUE LA MISE À JOUR TOUCHE.
 *
 * `docs/07 §2` liste ce qui peut se mettre à jour automatiquement, `§3` ce qui
 * ne va **jamais** directement en production. Les deux listes sont recopiées
 * ici, séparées, parce que la frontière entre elles EST la décision.
 */
export const Portee = z.enum([
  /* §2 — peut être promu automatiquement si tous les critères passent */
  'DEPENDANCE',
  'MODELE_LOCAL',
  'ADAPTATEUR',
  'PROMPT',
  'CONFIGURATION',
  'CORRECTIF_SECURITE',
  /* §3 — exige une décision humaine explicite, quoi qu'en disent les tests */
  'POLITIQUE_SECURITE',
  'MODELE_PERMISSIONS',
  'MIGRATION_BASE',
  'SEMANTIQUE_OUTIL',
  'ROUTAGE_MODELE',
  'EFFET_EXTERNE',
]);
export type Portee = z.infer<typeof Portee>;

/**
 * Les portées de `§3`, recopiées du document.
 *
 * ⚠ RECOPIÉES, PAS DÉRIVÉES — et c'est la leçon d'ADR-087. Une liste dérivée
 * de l'énumération (« tout ce qui n'est pas dans §2 ») se mettrait à jour
 * toute seule le jour où quelqu'un ajoute une portée, et déciderait donc à
 * notre place du côté où elle tombe.
 *
 * Ici, une portée nouvelle n'appartient à aucune des deux listes tant que
 * personne ne l'y met — et `porteeInconnue()` la traite comme exigeant un
 * humain. **Le défaut ferme.**
 */
const EXIGE_UN_HUMAIN: ReadonlySet<Portee> = new Set<Portee>([
  'POLITIQUE_SECURITE',
  'MODELE_PERMISSIONS',
  'MIGRATION_BASE',
  'SEMANTIQUE_OUTIL',
  'ROUTAGE_MODELE',
  'EFFET_EXTERNE',
]);

const PROMOTION_AUTOMATIQUE_POSSIBLE: ReadonlySet<Portee> = new Set<Portee>([
  'DEPENDANCE',
  'MODELE_LOCAL',
  'ADAPTATEUR',
  'PROMPT',
  'CONFIGURATION',
  'CORRECTIF_SECURITE',
]);

/**
 * Une portée exige-t-elle une décision humaine ?
 *
 * Le repli est **fermé** : une portée qui ne figure dans aucune des deux
 * listes exige un humain. C'est le seul repli qui ne peut pas élargir une
 * permission par oubli.
 */
export function exigeDecisionHumaine(portee: Portee): boolean {
  if (EXIGE_UN_HUMAIN.has(portee)) return true;
  return !PROMOTION_AUTOMATIQUE_POSSIBLE.has(portee);
}

/* -------------------------------------------------------------------------- */
/* Mesures — `docs/07 §6`                                                     */
/* -------------------------------------------------------------------------- */

/**
 * CE QUE LE LAB A MESURÉ.
 *
 * Les huit critères de `docs/07 §6`, sans en ajouter ni en retirer. Le
 * document conclut : *« Un seuil non atteint n'est jamais “acceptable pour
 * cette fois”. »*
 *
 * ⚠ CE TYPE N'EST PAS OPTIONNEL, ET SON ABSENCE NON PLUS. `Candidat.mesures`
 * vaut `null` tant que la version n'a pas traversé le LAB. `null` n'est pas
 * « pas de problème détecté » : c'est « aucune étape de mesure n'a eu lieu »,
 * et `docs/07 §1` dit qu'aucune étape n'est optionnelle.
 */
export interface Mesures {
  /** Proportion dans [0,1]. `docs/07 §6` exige 100 %. */
  readonly testsCritiques: number;
  readonly testsSecurite: number;
  readonly testsPolitique: number;
  /** Nombre de régressions observées. `docs/07 §6` exige zéro. */
  readonly regressions: number;
  /** Score de qualité du benchmark Jarvis, et la référence à égaler. */
  readonly qualite: number;
  readonly qualiteReference: number;
  readonly latenceMs: number;
  readonly latenceSeuilMs: number;
  readonly integriteMemoire: boolean;
  /**
   * Nombre de fausses confirmations observées. `docs/07 §6` exige zéro.
   *
   * C'est le critère le plus sévère du document, et il le mérite : une fausse
   * confirmation est le seul défaut qui fait MENTIR Jarvis sans qu'il le
   * sache — `CLAUDE.md` règle 3.
   */
  readonly fausseConfirmation: number;
}

/* -------------------------------------------------------------------------- */
/* Le candidat                                                                */
/* -------------------------------------------------------------------------- */

export interface Candidat {
  readonly version: string;
  readonly canal: Canal;
  readonly signature: EtatSignature;
  /** Tout ce que la mise à jour touche. Vide = elle ne touche rien de connu. */
  readonly portees: readonly Portee[];
  /** Résultats du LAB, ou `null` si la version n'y est jamais passée. */
  readonly mesures: Mesures | null;
}
