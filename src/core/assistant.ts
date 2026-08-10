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
import { randomUUID } from 'node:crypto';
import type { IntentEngine } from './intent/engine.js';
import type { ToolGateway } from './tools/gateway.js';
import type { Mode, VerificationStatus } from './types/domain.js';

export type AssistantReply =
  | {
      readonly kind: 'DONE';
      readonly status: VerificationStatus;
      readonly toolId: string;
      readonly detail: string;
      readonly output: unknown;
    }
  | {
      readonly kind: 'CONFIRM';
      /** À renvoyer tel quel pour confirmer. */
      readonly operationId: string;
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
  readonly operationId?: string;
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

      const operationId = options.operationId ?? randomUUID();
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
            cloudEnabled: false,
            proactive: false,
            userConfirmed: confirm,
          },
        });

        if (!result.ok) {
          if (result.error.kind === 'CONFIRMATION_REQUIRED') {
            const values: Record<string, string> = {};
            for (const [key, value] of Object.entries(result.error.details ?? {})) {
              if (key === 'tool' || key === 'autonomy') continue;
              values[key] = String(value);
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

        return {
          kind: 'DONE',
          status: result.value.status,
          toolId: proposal.toolId,
          detail: result.value.verification.detail,
          output: result.value.output,
        };
      } finally {
        // La confirmation ne doit jamais fuir vers l'appel suivant.
        deps.setGuardConfirmed(false);
      }
    },
  };
}
