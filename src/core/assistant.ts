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
import type { EntityResolver } from './context/resolver.js';
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
  /**
   * La conversation en cours, pour résoudre « ça » — ADR-073.
   *
   * OPTIONNELLE, et c'est un fait plutôt qu'un oubli : un appelant sans session
   * existe. Mais son absence ne relâche RIEN — sans elle, un référent produit
   * une question, jamais une supposition.
   */
  readonly sessionId?: string;
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
  /**
   * LE RÉSOLVEUR DE RÉFÉRENTS — ADR-073.
   *
   * La résolution vit ICI plutôt que dans le moteur d'intention, et le choix
   * est une propriété qu'on refuse de perdre : `propose(text)` est une fonction
   * PURE du texte — déterministe, éprouvable sans base, incapable d'échouer
   * pour une raison d'infrastructure.
   *
   * La rendre asynchrone aurait fait dépendre la COMPRÉHENSION d'une
   * entrée-sortie. L'Assistant, lui, est déjà asynchrone et orchestre déjà :
   * c'est sa place.
   */
  readonly resolver: EntityResolver;
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

      /* RÉSOUDRE LES RÉFÉRENTS — `docs/05 §A2`, ADR-073.

         > *Attendu : Jarvis résout le référent depuis le contexte récent.*
         > *Interdit : **deviner** si deux interprétations ont un impact
         >  différent.*

         L'INTERDIT GOUVERNE TOUT CE BLOC. Quatre issues, une seule agit :
         résolu → on substitue ; ambigu, introuvable, ou pas de session → **on
         demande**. Aucun chemin ne remplit un paramètre par défaut, et c'est
         exactement ce qui distingue « résoudre » de « choisir à la place de
         quelqu'un ». */
      let input: Readonly<Record<string, unknown>> = proposal.input;
      const aResoudre = Object.keys(proposal.referents);
      if (aResoudre.length > 0) {
        if (options.sessionId === undefined) {
          /* Sans session, il n'y a pas de « contexte récent ». Deviner
             reviendrait à inventer le passé de la conversation. */
          return {
            kind: 'CLARIFY',
            question: 'À quoi fais-tu référence ? Je n’ai pas de conversation en cours.',
          };
        }

        const resolution = await deps.resolver.resolveAnaphora(options.sessionId);
        if (!resolution.ok) return { kind: 'ERROR', message: resolution.error.message };

        if (resolution.value.kind === 'AMBIGUOUS') {
          // Le résolveur formule LA question — une seule à la fois (`05/A3`).
          return { kind: 'CLARIFY', question: resolution.value.question };
        }
        if (resolution.value.kind === 'NOT_FOUND') {
          return {
            kind: 'CLARIFY',
            question: 'À quoi fais-tu référence ? Rien n’a été évoqué récemment.',
          };
        }

        const nom = resolution.value.entity.displayName;
        input = Object.fromEntries(
          Object.entries(proposal.input).map(([cle, valeur]) =>
            aResoudre.includes(cle) ? [cle, nom] : [cle, valeur],
          ),
        );
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
          input,
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
