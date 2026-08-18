/**
 * Assistant — la boucle de conversation, indépendante de l'interface.
 *
 * Référence : 02 Étape C, `06 §Style des réponses`.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le CLI et le serveur web doivent traverser **exactement** la même chaîne :
 *
 *   intention → Policy Gate → outil → vérification → journal
 *
 * Dupliquer cette logique dans chaque interface, c'est accepter qu'un jour
 * l'une des deux oublie une étape. Une interface ne décide de rien : elle
 * affiche ce que l'Assistant a décidé.
 *
 * PROPRIÉTÉ EXPLOITÉE ICI
 * -----------------------
 * L'Intent Engine est déterministe (Tier 0, règles). Rejouer le même texte
 * produit la même proposition. Cela permet un flux de confirmation **sans état
 * serveur** : le client renvoie le texte d'origine avec la clé d'opération, on
 * redérive la proposition, et on l'exécute confirmée. Aucune session à stocker,
 * donc aucune session à détourner.
 */
import { mint, type OperationIdentity } from './tools/identity.js';
import type { IntentEngine } from './intent/engine.js';
import { readConfirmables } from './tools/confirmation.js';
import type { ToolGateway } from './tools/gateway.js';
import type { Mode, VerificationStatus } from './types/domain.js';

export type AssistantReply =
  | {
      readonly kind: 'DONE';
      readonly status: VerificationStatus;
      readonly toolId: string;
      readonly detail: string;
      readonly output: unknown;
      /**
       * LES ENTITÉS ÉVOQUÉES PAR CET ÉCHANGE — ADR-072.
       *
       * Toujours présent, éventuellement vide. C'est ce qui permet à l'appelant
       * d'enregistrer le tour avec `mentionedEntityIds`, et donc au résolveur de
       * répondre à « ça » (`docs/05 §A2`).
       *
       * **AUCUNE INFÉRENCE ICI.** L'entité est retenue parce que l'outil a
       * déclaré l'avoir touchée — `resource.kind === 'entity'` —, jamais parce
       * qu'un nom a été reconnu dans une phrase. C'est la frontière qui garde
       * ce chemin compatible `Tier 0` (ADR-071).
       */
      readonly mentionedEntityIds: readonly string[];
    }
  | {
      readonly kind: 'CONFIRM';
      /** À renvoyer tel quel pour confirmer. */
      readonly operationId: OperationIdentity;
      readonly reason: string;
      /** Les VALEURS concrètes sur lesquelles porte la confirmation (03 §3). */
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'CLARIFY'; readonly question: string }
  | {
      readonly kind: 'UNSUPPORTED';
      readonly understood: string;
      readonly missing: string;
    }
  | { readonly kind: 'DENIED'; readonly reason: string }
  | { readonly kind: 'ERROR'; readonly message: string };

export interface SayOptions {
  /** Fournie pour confirmer une action préparée. Sinon générée. */
  readonly operationId?: OperationIdentity;
  readonly confirm?: boolean;
  readonly mode?: Mode;
}

export interface Assistant {
  say(text: string, options?: SayOptions): Promise<AssistantReply>;
}

export interface AssistantDeps {
  readonly intent: IntentEngine;
  readonly gateway: ToolGateway;
  /** Pilote la confirmation côté Memory Guard (voir `src/tools/index.ts`). */
  setGuardConfirmed(value: boolean): void;
  /**
   * L'INTERRUPTEUR CLOUD DE L'UTILISATEUR — invariant S13, ADR-069.
   *
   * Ce champ valait `false` EN DUR ici, et dans le runtime. La politique
   * `00_hard_security.cedar` interdit toute égression quand il est faux, avec
   * ce commentaire : *« L'utilisateur doit pouvoir couper le cloud, et cela
   * doit être vrai. »*
   *
   * Ça ne l'était pas. `config/default.json` expose `cloud.enabled`, et la clé
   * ne pilotait RIEN : la protection tenait par un littéral — le bon résultat
   * pour la mauvaise raison, ce que ce dépôt refuse partout ailleurs.
   *
   * **Un interrupteur qui n'interrompt pas est pire que pas d'interrupteur :
   * l'utilisateur se croit protégé par son choix alors qu'il l'est par un
   * hasard d'écriture.** Le jour où quelqu'un remplace le littéral, plus rien
   * ne le signale.
   *
   * Fourni par l'appelant, jamais deviné. Le défaut de `config/default.json`
   * reste `false` : ce qui change n'est pas le comportement par défaut, c'est
   * que le choix de l'utilisateur soit HONORÉ.
   */
  readonly cloudEnabled: boolean;
}

export function createAssistant(deps: AssistantDeps): Assistant {
  return {
    async say(text: string, options: SayOptions = {}): Promise<AssistantReply> {
      const proposal = deps.intent.propose(text);

      if (proposal.kind === 'CLARIFY') {
        return { kind: 'CLARIFY', question: proposal.question };
      }
      if (proposal.kind === 'UNSUPPORTED') {
        return {
          kind: 'UNSUPPORTED',
          understood: proposal.understood,
          missing: proposal.missing,
        };
      }

      /* LE POINT DE FRAPPE UNIQUE — ADR-030.
         Une intention utilisateur donne UNE identité d'opération. Tout ce qui
         suit — reprise, vérification, et un jour repli sur un autre
         fournisseur — doit la conserver.
         `tests/lab/invariants.test.ts` (I5) vérifie que `mint()` n'est appelé
         nulle part ailleurs dans `src/`. */
      const operationId = options.operationId ?? mint();
      const confirm = options.confirm === true;

      // « Retiens que X » vaut confirmation par lui-même ; les autres non.
      deps.setGuardConfirmed(proposal.userConfirms || confirm);
      try {
        const result = await deps.gateway.invoke({
          toolId: proposal.toolId,
          input: proposal.input,
          parameterProvenance: proposal.parameterProvenance,
          operationId,
          actor: 'USER',
          context: {
            mode: options.mode ?? 'NORMAL',
            cloudEnabled: deps.cloudEnabled,
            proactive: false,
            userConfirmed: confirm,
          },
        });

        if (!result.ok) {
          if (result.error.kind === 'CONFIRMATION_REQUIRED') {
            /* LISTE BLANCHE PARTAGÉE — ADR-063. Ce tri existait ici ET dans
               le CLI, chacun par `key !== 'tool' && key !== 'autonomy'`. Deux
               tris du même fait finissent par diverger. */
            const values: Record<string, string> = {};
            for (const v of readConfirmables(result.error.details)) {
              values[v.nom] = v.rendu;
            }
            return {
              kind: 'CONFIRM',
              operationId,
              reason: result.error.message,
              values,
            };
          }
          if (result.error.kind === 'POLICY_DENIED') {
            return { kind: 'DENIED', reason: result.error.message };
          }
          return { kind: 'ERROR', message: result.error.message };
        }

        /* CE QUE L'ÉCHANGE A ÉVOQUÉ — ADR-072.
           L'outil DÉCLARE la ressource touchée ; on ne devine rien et on ne
           connaît la forme d'aucun `output`. Une ressource d'un autre genre —
           note, tâche, mémoire — n'est pas une entité résoluble, et la liste
           reste vide plutôt que d'être remplie approximativement. */
        const touchee = result.value.resource;
        return {
          kind: 'DONE',
          status: result.value.status,
          toolId: proposal.toolId,
          detail: result.value.verification.detail,
          output: result.value.output,
          mentionedEntityIds:
            touchee !== null && touchee.kind === 'entity' ? [touchee.id] : [],
        };
      } finally {
        // La confirmation ne doit jamais fuir vers l'appel suivant.
        deps.setGuardConfirmed(false);
      }
    },
  };
}
