/**
 * Verification Engine.
 *
 * Référence : 00 §I4, 03 §2 (S7, S15), PRD §22 et §42, scénarios 05/B5 et B12.
 *
 * > « L'API a répondu 200 » n'est pas une preuve. Le système doit obtenir une
 * > confirmation du fournisseur, ou relire l'état réel.
 *
 * C'est le composant que ne possède aucun assistant du marché, et la raison
 * pour laquelle ils affirment parfois avoir envoyé un email qui n'est jamais
 * parti.
 *
 * PROPRIÉTÉ STRUCTURANTE
 * ----------------------
 * `CONFIRMED` n'est produit qu'à un seul endroit de ce fichier — la fonction
 * `confirmed()` — et cette fonction exige une preuve en argument. Il n'existe
 * aucun autre chemin de code capable de fabriquer un `CONFIRMED`. La règle
 * « jamais de succès non vérifié » cesse ainsi d'être une consigne pour devenir
 * une propriété du type.
 */
import { z } from 'zod';
import type { VerificationStatus } from '../types/domain.js';
import { ok, type Result } from '../types/result.js';
import type {
  RegisteredTool,
  ToolContext,
  ToolExecution,
  VerificationOutcome,
} from '../tools/contract.js';

/**
 * POURQUOI on ne sait pas.
 *
 * Référence : `docs/14 §2`, mandat Foundation 2.2 §1.
 *
 * `UNKNOWN` seul ne suffit pas. « Gmail n'a pas répondu » et « le processus est
 * mort pendant l'appel » sont deux incertitudes différentes, qui appellent deux
 * conduites de reprise différentes et deux phrases différentes à l'utilisateur.
 *
 * Aucune de ces raisons n'autorise un rejeu automatique. Elles servent à
 * DÉCIDER QUOI DEMANDER, pas à contourner le refus.
 */
export const UnknownReason = z.enum([
  /** L'action est partie, rien n'a pu être observé ensuite. */
  'NO_OBSERVATION',
  /** Le fournisseur n'a pas répondu dans le délai. Il a pu traiter quand même. */
  'PROVIDER_TIMEOUT',
  /** Le processus est mort pendant l'appel — reprise depuis `EXECUTING`. */
  'PROCESS_CRASH',
  /** Le fournisseur répond, mais son état ne permet pas de trancher. */
  'EXTERNAL_STATE',
  /** L'outil ne sait pas vérifier une tentative (`attemptVerification: NONE`). */
  'VERIFICATION_UNAVAILABLE',
  /**
   * Deux observations se contredisent.
   *
   * ⚠ NON ATTEIGNABLE aujourd'hui : il n'existe qu'une source d'observation par
   * outil. Déclaré maintenant pour que le jour où une seconde apparaît, le cas
   * ait déjà un nom plutôt qu'un `else`.
   */
  'CONFLICTING_EVIDENCE',
]);
export type UnknownReason = z.infer<typeof UnknownReason>;

/** Preuve d'un changement d'état réel. Sans elle, pas de CONFIRMED. */
export interface Evidence {
  /** Ce qui a été observé après coup, indépendamment de ce que l'outil a dit. */
  readonly observed: string;
  /** Identifiant fourni par le fournisseur, quand il y en a un. */
  readonly proof?: string;
}

/** Seule fabrique de CONFIRMED du système. */
function confirmed(evidence: Evidence): VerificationOutcome {
  return {
    status: 'CONFIRMED',
    detail: `État réel vérifié : ${evidence.observed}`,
    evidence: 'POSITIVE_PRESENCE',
    ...(evidence.proof === undefined ? {} : { proof: evidence.proof }),
  };
}

function unknown(detail: string, reason: UnknownReason): VerificationOutcome {
  return { status: 'UNKNOWN', detail, unknownReason: reason, evidence: 'NONE' };
}

function probable(detail: string, proof?: string): VerificationOutcome {
  return { status: 'PROBABLE', detail, ...(proof === undefined ? {} : { proof }) };
}

/**
 * Preuve POSITIVE qu'aucun effet n'a eu lieu.
 *
 * Symétrique de `Evidence`, et la symétrie est le fond du problème corrigé par
 * Foundation 4 : `confirmed()` exigeait une preuve, `failed()` n'exigeait rien.
 * On pouvait donc affirmer un échec sur un simple `500`.
 */
export interface Absence {
  /** Ce qui a été observé, et qui établit que rien ne s'est produit. */
  readonly observed: string;
  /**
   * Pourquoi cette observation est CONCLUANTE.
   *
   * C'est le champ qui coûte cher à remplir honnêtement, et c'est le point.
   * « J'ai relu, il n'y a rien » ne suffit pas face à un fournisseur qui
   * traite en file d'attente : la fenêtre d'observation doit être fermée.
   */
  readonly conclusiveBecause: string;
}

/** Seule fabrique de FAILED du système. Exige une preuve d'ABSENCE. */
function failed(absence: Absence): VerificationOutcome {
  return {
    status: 'FAILED',
    detail: `Absence d'effet vérifiée : ${absence.observed} (${absence.conclusiveBecause})`,
    evidence: 'POSITIVE_ABSENCE',
  };
}

/** Rien n'a été tenté. Distinct d'un échec, et distinct d'une ignorance. */
function notAttempted(detail: string): VerificationOutcome {
  return { status: 'NOT_ATTEMPTED', detail, evidence: 'POSITIVE_ABSENCE' };
}

/**
 * Ce qui établit qu'un fournisseur a rompu son contrat.
 *
 * Exigé en argument, comme `Evidence` et `Absence` : une rupture de confiance
 * annoncée sans constat serait exactement la faute que la hiérarchie de preuve
 * a corrigée pour `FAILED`.
 */
export interface ContractBreach {
  /** Ce que le fournisseur ANNONÇAIT tenir. */
  readonly promised: string;
  /** Ce qui a été CONSTATÉ, et qui le contredit. */
  readonly observed: string;
}

/**
 * LE FOURNISSEUR A MENTI — `docs/22 §9`.
 *
 * Ne qualifie pas l'action mais la SOURCE, et c'est ce qui le rend plus fort
 * qu'`UNKNOWN` : on ignore l'issue, ET on sait qu'on ne peut plus croire celui
 * qui la raconte.
 *
 * Ce verdict n'est JAMAIS `FAILED`. Le cas canonique — deux effets là où un
 * seul était promis — a bel et bien produit des effets ; annoncer `FAILED`
 * serait le mensonge le plus coûteux du système, et violerait I3.
 */
function contractViolation(breach: ContractBreach): VerificationOutcome {
  return {
    status: 'PROVIDER_CONTRACT_VIOLATION',
    detail:
      `Contrat rompu par le fournisseur. Promis : ${breach.promised}. ` +
      `Constaté : ${breach.observed}. Je ne sais pas ce qui s'est réellement ` +
      "produit, et je ne peux plus me fier à cette source.",
    // L'observation est POSITIVE — on a vu la violation. Ce qui reste inconnu
    // est l'issue de l'action, pas l'existence de la rupture.
    evidence: 'POSITIVE_PRESENCE',
  };
}

/**
 * BRIDE UN VERDICT À CE QUE L'OUTIL PEUT RÉELLEMENT PROUVER — ADR-030.
 *
 * Un outil déclare sa `verifiability`. Comme pour `attemptVerification`, on ne
 * lui fait pas confiance sur parole : on VÉRIFIE que son verdict tient dans ce
 * qu'il a déclaré pouvoir établir.
 *
 * Le cas qui compte est celui du fournisseur asynchrone, mesuré en
 * `docs/18 §5` :
 *
 *   Jarvis → fournisseur → ACK → Jarvis relit → « rien » → FAILED
 *                                                    ↓
 *                                          300 ms plus tard : l'effet arrive
 *
 * « Je ne vois rien » n'est pas « il n'y a rien ». Seul un outil `VERIFIABLE`
 * — dont la fenêtre d'observation est fermée — peut conclure à l'absence.
 * Pour les autres, le verdict honnête est `UNKNOWN`.
 *
 * C'est un DURCISSEMENT, jamais un assouplissement : cette fonction ne peut
 * que dégrader un verdict, exactement comme `strictest()` dans le Policy Gate.
 */
function constrainToVerifiability(
  tool: RegisteredTool,
  outcome: VerificationOutcome,
): VerificationOutcome {
  const { verifiability, id } = tool.definition;

  if (verifiability === 'VERIFIABLE') return outcome;

  /* UNE RUPTURE DE CONTRAT NE SE DÉGRADE PAS.
     `constrainToVerifiability` bride ce qu'un outil affirme sur LE MONDE. Une
     violation porte sur LA SOURCE : elle a été constatée ici, par nous, et la
     déclaration de vérifiabilité de l'outil n'y change rien. La dégrader en
     `UNKNOWN` reviendrait à effacer la seule information certaine du
     scénario. */
  if (outcome.status === 'PROVIDER_CONTRACT_VIOLATION') return outcome;

  if (outcome.status === 'FAILED') {
    return unknown(
      `${id} conclut à l'absence d'effet, mais se déclare ${verifiability} : ` +
        'il ne peut pas prouver qu\'un effet différé n\'arrivera pas. ' +
        'Je ne peux donc pas affirmer que l\'action a échoué.',
      'EXTERNAL_STATE',
    );
  }

  if (verifiability === 'UNVERIFIABLE' && outcome.status === 'CONFIRMED') {
    // Un outil qui ne sait rien établir ne peut pas non plus établir un
    // succès, quelle que soit la confiance de son implémentation.
    return probable(
      `${id} se déclare UNVERIFIABLE : son verdict de succès n'est pas ` +
        'recoupé par une observation indépendante.',
      outcome.proof,
    );
  }

  return outcome;
}

export interface VerificationEngine {
  verify(
    tool: RegisteredTool,
    execution: ToolExecution,
    ctx: ToolContext,
  ): Promise<Result<VerificationOutcome>>;
}

export function createVerificationEngine(): VerificationEngine {
  return {
    async verify(
      tool: RegisteredTool,
      execution: ToolExecution,
      ctx: ToolContext,
    ): Promise<Result<VerificationOutcome>> {
      const { verification, id } = tool.definition;

      switch (verification) {
        /* ---------------------------------------------------------------- */
        case 'NONE': {
          // Lecture seule. Il n'y a pas de mutation à vérifier, et le résultat
          // de la lecture EST l'observation. Prétendre le contraire viderait le
          // mot « vérifié » de son sens dans l'autre direction.
          return ok(
            confirmed({ observed: `lecture ${id}, aucune mutation à vérifier` }),
          );
        }

        /* ---------------------------------------------------------------- */
        case 'READ_BACK': {
          const outcome = await tool.readBack(execution, ctx);
          if (!outcome.ok) {
            // La relecture a échoué : on ignore l'état réel. Ce n'est pas un
            // échec de l'action — c'est une incertitude, et Jarvis doit le dire.
            return ok(
              unknown(
                `Relecture impossible après ${id} : ${outcome.error.message}. ` +
                  'L\'action a peut-être abouti ; le système ne l\'affirme pas.',
                'NO_OBSERVATION',
              ),
            );
          }
          return ok(constrainToVerifiability(tool, outcome.value));
        }

        /* ---------------------------------------------------------------- */
        case 'PROVIDER_PROOF': {
          if (execution.proof === undefined || execution.proof.length === 0) {
            return ok(
              unknown(
                `${id} exige une preuve du fournisseur et n'en a pas fourni. ` +
                  "Statut non promu, quelle qu'ait été la réponse HTTP.",
                'NO_OBSERVATION',
              ),
            );
          }

          // Une preuve seule vaut mieux que rien, mais elle reste la parole du
          // fournisseur. On tente une relecture indépendante ; à défaut, on
          // s'arrête à PROBABLE.
          const outcome = await tool.readBack(execution, ctx);
          if (!outcome.ok || outcome.value.status === 'UNKNOWN') {
            return ok(
              probable(
                `${id} a renvoyé une preuve, non recoupée par une relecture ` +
                  'indépendante.',
                execution.proof,
              ),
            );
          }
          return ok(constrainToVerifiability(tool, outcome.value));
        }

        /* ---------------------------------------------------------------- */
        default: {
          // Stratégie inconnue : on ne devine pas.
          return ok(
            unknown(
              `Stratégie de vérification inconnue pour ${id}.`,
              'VERIFICATION_UNAVAILABLE',
            ),
          );
        }
      }
    },
  };
}

/** Fabriques exportées pour les implémentations de `readBack`. */
export const verificationOutcome = {
  confirmed,
  probable,
  unknown,
  failed,
  notAttempted,
  contractViolation,
} as const;

/**
 * Un statut autorise-t-il Jarvis à annoncer un succès à l'utilisateur ?
 *
 * Seul `CONFIRMED` le permet. `PROBABLE` se formule « je crois que… , je n'ai
 * pas pu le vérifier », jamais « c'est fait ».
 */
export function mayClaimSuccess(status: VerificationStatus): boolean {
  return status === 'CONFIRMED';
}
