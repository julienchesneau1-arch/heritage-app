/**
 * OUTIL À EFFET EXTERNE — banc de défaillance, Foundation 3.
 *
 * Les cinq outils du noyau écrivent dans PostgreSQL, dans la même base que le
 * journal d'intention. PostgreSQL les protège donc gratuitement : effet et
 * trace sont commités ensemble, ou pas du tout.
 *
 * Aucun fournisseur réel n'offre cela. Cet outil-ci est le premier du dépôt
 * dont l'effet est VRAIMENT externe : il écrit dans `lab_world_effects` via
 * une connexion distincte, hors de toute transaction de Jarvis. Un `ROLLBACK`
 * ne le défait pas. C'est ce qui rend le banc représentatif.
 *
 * ⚠ INFRASTRUCTURE DE TEST. Ne doit jamais être importée depuis `src/`.
 */
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import {
  defineTool,
  type AttemptVerdict,
  type RegisteredTool,
  type ToolContext,
  type ToolExecution,
  type VerificationOutcome,
} from '../../src/core/tools/contract.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import { verificationOutcome } from '../../src/core/verification/engine.js';
import type { AutonomyLevel, EffectContract, PrivacyClass } from '../../src/core/types/domain.js';
import type { HostileProvider } from './hostile-provider.js';
import { externalEffectCount } from './world.js';

const HostileInput = z.object({
  payload: z.string().min(1),
});

export interface HostileToolOptions {
  readonly id?: string;
  readonly provider: HostileProvider;
  /** Connexion DU MONDE — celle qui sert à relire l'effet réel. */
  readonly world: Db;
  readonly autonomy?: AutonomyLevel;
  readonly privacyClass?: PrivacyClass;
  readonly verification?: 'READ_BACK' | 'PROVIDER_PROOF';
  /**
   * L'outil sait-il répondre à « as-tu déjà traité l'opération X ? »
   *
   * Quand `true`, `verifyAttempt` interroge le MONDE, pas le fournisseur —
   * c'est la forme la plus forte de vérification de tentative, et celle qu'un
   * vrai fournisseur idempotent permet via sa clé d'idempotence.
   */
  readonly canVerifyAttempt?: boolean;
  readonly timeoutMs?: number;
  readonly networkRequired?: boolean;
  /** Rend `payload` sensible, pour les scénarios de cérémonie. */
  readonly sensitivePayload?: boolean;
  /**
   * Ce que l'outil prétend pouvoir prouver.
   *
   * `OBSERVABLE` par défaut, et c'est le choix honnête : le monde du banc peut
   * recevoir un effet différé (`timing: AFTER_RESPONSE`), donc « je ne vois
   * rien » n'y prouve jamais « il n'y a rien ».
   */
  readonly verifiability?: 'VERIFIABLE' | 'OBSERVABLE' | 'UNVERIFIABLE';
  /**
   * Contrat d'effet de l'outil simulé.
   *
   * `PROVIDER_IDEMPOTENT` sert à éprouver le SEUL chemin de rejeu externe
   * autorisé ; tout le reste doit rester bloqué en `UNKNOWN`.
   */
  readonly effectContract?: EffectContract;
}

/**
 * Construit un outil dont l'effet est réellement externe.
 *
 * `readBack` relit LE MONDE, jamais la réponse du fournisseur : c'est la
 * différence entre vérifier et croire.
 */
export function createHostileTool(options: HostileToolOptions): RegisteredTool {
  const id = options.id ?? 'lab_external_send';
  const verification = options.verification ?? 'READ_BACK';
  const world = options.world;

  return defineTool<z.infer<typeof HostileInput>>({
    definition: {
      id,
      version: '1.0.0',
      description: 'Outil de banc : produit un effet externe irréversible.',
      autonomy: options.autonomy ?? 'L2',
      privacyClass: options.privacyClass ?? 'GREEN',
      reversible: false,
      networkRequired: options.networkRequired ?? true,
      parameters: [
        { name: 'payload', sensitive: options.sensitivePayload ?? false },
      ],
      idempotency: 'OPERATION_KEY',
      verification,
      timeoutMs: options.timeoutMs ?? 2_000,
      maxRetries: 0,
      auditEvent: 'LAB_EXTERNAL_SEND',
      requiredSecrets: [],
      rollback: null,
      attemptVerification:
        options.canVerifyAttempt === true ? 'BY_OPERATION_KEY' : 'NONE',
      // Le point du banc : un effet qu'aucun ROLLBACK ne défait.
      //
      // Par défaut `EXTERNALLY_VERIFIABLE` : le monde est interrogeable, mais
      // le fournisseur ne dédoublonne PAS. C'est le cas le plus fréquent, et
      // celui qui interdit le rejeu (ADR-033).
      effect: options.effectContract ?? 'EXTERNALLY_VERIFIABLE',
      verifiability: options.verifiability ?? 'OBSERVABLE',
    },

    inputSchema: HostileInput,

    async execute(input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      const sent = await options.provider.send(ctx.operationId, input.payload);
      if (!sent.ok) return sent;

      return ok({
        output: { reference: sent.value.reference, claims: sent.value.claims },
        resource: { kind: 'lab_effect', id: sent.value.reference },
        proof: sent.value.reference,
      });
    },

    /**
     * RELECTURE DU MONDE.
     *
     * On ne relit pas ce que le fournisseur a dit — on compte ce qui existe.
     * C'est cette fonction qui démasque un fournisseur menteur.
     */
    async readBack(
      _execution: ToolExecution,
      ctx: ToolContext,
    ): Promise<Result<VerificationOutcome>> {
      let count: number;
      try {
        count = await externalEffectCount(world, ctx.operationId);
      } catch (cause: unknown) {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `Relecture du monde impossible : ${
              cause instanceof Error ? cause.message : 'inconnu'
            }`,
          ),
        );
      }

      if (count === 0) {
        // Le fournisseur a pu répondre « ACCEPTED ». Le monde dit non — POUR
        // L'INSTANT. Le Verification Engine dégradera ce verdict en UNKNOWN
        // si l'outil n'est pas VERIFIABLE : c'est exactement la protection
        // contre le fournisseur asynchrone (ADR-030).
        return ok(
          verificationOutcome.failed({
            observed: `aucun effet dans le monde pour ${ctx.operationId}`,
            conclusiveBecause:
              'lecture du monde après retour du fournisseur — concluante ' +
              'uniquement si le fournisseur est synchrone',
          }),
        );
      }

      if (count > 1) {
        // Ne devrait jamais arriver. Si cela arrive, c'est LE défaut que tout
        // le banc cherche : on ne le maquille pas en succès.
        return ok(
          verificationOutcome.failed({
            observed: `${String(count)} effets pour une opération unique`,
            conclusiveBecause:
              'violation mesurée de external_effect_count(clé, cible) ≤ 1',
          }),
        );
      }

      return ok(
        verificationOutcome.confirmed({
          observed: `1 effet constaté dans le monde pour ${ctx.operationId}`,
          proof: ctx.operationId,
        }),
      );
    },

    ...(options.canVerifyAttempt === true
      ? {
          async verifyAttempt(
            operationId: string,
          ): Promise<Result<AttemptVerdict>> {
            let count: number;
            try {
              count = await externalEffectCount(world, operationId);
            } catch (cause: unknown) {
              return err(
                jarvisError(
                  'PROVIDER_UNAVAILABLE',
                  `Vérification de tentative impossible : ${
                    cause instanceof Error ? cause.message : 'inconnu'
                  }`,
                ),
              );
            }

            if (count >= 1) {
              return ok({
                kind: 'EFFECT_CONFIRMED',
                detail: `${String(count)} effet(s) trouvé(s) pour ${operationId}`,
                proof: operationId,
              });
            }

            // ⚠ Le point le plus délicat du banc.
            //
            // « Zéro effet trouvé » n'est une preuve d'absence QUE parce que le
            // monde est ici une base transactionnelle, interrogée après coup.
            // Face à un fournisseur dont le traitement est asynchrone
            // (`timing: AFTER_RESPONSE`), la même lecture rendrait NO_EFFECT
            // alors que l'effet arrive dans dix secondes.
            //
            // C'est pourquoi `NO_EFFECT` est réservé aux fournisseurs qui
            // garantissent la synchronicité. Le banc mesure ce piège plutôt
            // que de le contourner.
            return ok({
              kind: 'NO_EFFECT',
              detail: `aucun effet trouvé pour ${operationId}`,
            });
          },
        }
      : {}),
  });
}

/**
 * Variante qui ne sait PAS relire le monde.
 *
 * Sert à mesurer ce qui se passe quand la seule information disponible est la
 * parole du fournisseur — le cas d'un vrai service d'emailing sans API de
 * consultation.
 */
export function createBlindHostileTool(options: HostileToolOptions): RegisteredTool {
  const id = options.id ?? 'lab_blind_send';

  return defineTool<z.infer<typeof HostileInput>>({
    definition: {
      id,
      version: '1.0.0',
      description: 'Outil de banc aveugle : aucune relecture indépendante.',
      autonomy: options.autonomy ?? 'L2',
      privacyClass: options.privacyClass ?? 'GREEN',
      reversible: false,
      networkRequired: options.networkRequired ?? true,
      parameters: [
        { name: 'payload', sensitive: options.sensitivePayload ?? false },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'PROVIDER_PROOF',
      timeoutMs: options.timeoutMs ?? 2_000,
      maxRetries: 0,
      auditEvent: 'LAB_BLIND_SEND',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'UNVERIFIABLE',
      // Aucune relecture : cet outil ne peut rien établir du tout.
      verifiability: 'UNVERIFIABLE',
    },

    inputSchema: HostileInput,

    async execute(input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      const sent = await options.provider.send(ctx.operationId, input.payload);
      if (!sent.ok) return sent;
      return ok({
        output: { reference: sent.value.reference },
        resource: { kind: 'lab_effect', id: sent.value.reference },
        proof: sent.value.reference,
      });
    },

    // Pas de `readBack` : `defineTool` rend alors UNKNOWN, et le Verification
    // Engine s'arrête à PROBABLE. C'est exactement le comportement voulu.
  });
}
