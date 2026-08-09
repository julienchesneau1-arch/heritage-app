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
import type { VerificationStatus } from '../types/domain.js';
import { ok, type Result } from '../types/result.js';
import type {
  RegisteredTool,
  ToolContext,
  ToolExecution,
  VerificationOutcome,
} from '../tools/contract.js';

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
    ...(evidence.proof === undefined ? {} : { proof: evidence.proof }),
  };
}

function unknown(detail: string): VerificationOutcome {
  return { status: 'UNKNOWN', detail };
}

function probable(detail: string, proof?: string): VerificationOutcome {
  return { status: 'PROBABLE', detail, ...(proof === undefined ? {} : { proof }) };
}

function failed(detail: string): VerificationOutcome {
  return { status: 'FAILED', detail };
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
              ),
            );
          }
          return ok(outcome.value);
        }

        /* ---------------------------------------------------------------- */
        case 'PROVIDER_PROOF': {
          if (execution.proof === undefined || execution.proof.length === 0) {
            return ok(
              unknown(
                `${id} exige une preuve du fournisseur et n'en a pas fourni. ` +
                  "Statut non promu, quelle qu'ait été la réponse HTTP.",
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
          return ok(outcome.value);
        }

        /* ---------------------------------------------------------------- */
        default: {
          // Stratégie inconnue : on ne devine pas.
          return ok(
            unknown(`Stratégie de vérification inconnue pour ${id}.`),
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
