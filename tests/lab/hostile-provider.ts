/**
 * FOURNISSEUR HOSTILE — banc de défaillance, Foundation 3.
 *
 * Un vrai fournisseur ne produit ses pathologies qu'une fois par mois, à
 * 3 h du matin, sans témoin. Celui-ci les produit à la demande, de façon
 * déterministe et reproductible. C'est ce qui le rend plus utile qu'un vrai.
 *
 * LE POINT CENTRAL : LE MOMENT DE L'EFFET
 * ---------------------------------------
 * Simuler « un timeout » ne prouve rien. Ce qui compte est de savoir OÙ tombe
 * la panne par rapport à l'effet :
 *
 *   Jarvis ─────► fournisseur ─────► EFFET ─────► réponse ─────► Jarvis
 *            (1)                (2)         (3)            (4)
 *
 *   une panne en (1) ou (2)  →  aucun effet. Rejouer est SÛR.
 *   une panne en (3) ou (4)  →  l'effet existe. Rejouer DOUBLE.
 *
 * Et Jarvis ne peut PAS distinguer (2) de (3) de l'extérieur : dans les deux
 * cas il voit « pas de réponse ». C'est toute la difficulté, et c'est
 * précisément ce que ce fournisseur permet de mettre en scène.
 *
 * ⚠ INFRASTRUCTURE DE TEST. Ne doit jamais être importée depuis `src/`.
 */
import type { Db } from '../../src/core/db/client.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import { commitEffect } from './world.js';

/**
 * Quand l'effet se produit, par rapport à la réponse.
 *
 * `AFTER_RESPONSE` mérite un mot : c'est le fournisseur qui accuse réception
 * puis traite en file d'attente. Il est courant (SendGrid, Stripe webhooks) et
 * particulièrement traître — un `500` rendu APRÈS l'accusé de réception ne dit
 * rien de l'effet, qui arrivera peut-être trente secondes plus tard.
 */
export type EffectTiming =
  | 'NEVER'
  | 'BEFORE_RESPONSE'
  | 'AFTER_EFFECT_BEFORE_RESPONSE'
  | 'AFTER_RESPONSE'
  | 'DURING_EFFECT';

/** Pathologies simulables. Chacune correspond à une ligne de `docs/17 §3`. */
export type HostileBehaviour =
  | { readonly kind: 'NORMAL' }
  | { readonly kind: 'LATENCY'; readonly ms: number }
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'LOST_RESPONSE' }
  | { readonly kind: 'DUPLICATE_RESPONSE' }
  | { readonly kind: 'DELAYED_RESPONSE'; readonly ms: number }
  | { readonly kind: 'HTTP'; readonly status: 429 | 500 | 503 }
  | { readonly kind: 'SUCCESS_AFTER_ERROR'; readonly failures: number }
  | { readonly kind: 'ERROR_AFTER_EFFECT' }
  | { readonly kind: 'SUCCESS_WITHOUT_EFFECT' }
  | {
      readonly kind: 'PARTIAL';
      readonly succeed: number;
    }
  | { readonly kind: 'CONNECTION_RESET' }
  | { readonly kind: 'PROCESS_KILLED' };

export interface HostileConfig {
  readonly id: string;
  readonly behaviour: HostileBehaviour;
  readonly timing: EffectTiming;
  /** Latence de base, avant toute pathologie. */
  readonly latencyMs?: number;
  /** Destinataires, pour les scénarios de succès partiel. */
  readonly targets?: readonly string[];
}

/** Ce qu'un fournisseur rend quand il répond. Jamais une preuve, une OBSERVATION. */
export interface ProviderReceipt {
  readonly providerId: string;
  readonly reference: string;
  /** Ce que le fournisseur AFFIRME. Le banc vérifie séparément ce qui est VRAI. */
  readonly claims: 'ACCEPTED' | 'PARTIALLY_ACCEPTED';
  readonly perTarget?: readonly {
    readonly target: string;
    readonly claims: 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';
  }[];
}

export interface HostileProvider {
  readonly id: string;
  send(operationKey: string, payload: string): Promise<Result<ProviderReceipt>>;
  /** Compteur d'appels REÇUS — distinct des effets produits. */
  callCount(): number;
  /** Reconfigure à chaud, pour les scénarios « le fournisseur change ». */
  reconfigure(patch: Partial<HostileConfig>): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fabrique un fournisseur hostile.
 *
 * `db` doit être la connexion DU MONDE (`worldDb()`), jamais celle de
 * l'opération : un effet doit survivre au rollback de Jarvis.
 */
export function createHostileProvider(
  db: Db,
  config: HostileConfig,
): HostileProvider {
  let current: HostileConfig = config;
  let calls = 0;
  let failuresSoFar = 0;

  /** Écrit dans le monde. Irréversible, par construction. */
  async function effect(operationKey: string, payload: string, target = '-'): Promise<void> {
    await commitEffect(db, {
      operationKey,
      providerId: current.id,
      payload,
      target,
    });
  }

  async function produceEffect(operationKey: string, payload: string): Promise<void> {
    const behaviour = current.behaviour;

    if (behaviour.kind === 'PARTIAL') {
      const targets = current.targets ?? [];
      // Succès partiel : N destinataires sur M reçoivent réellement.
      for (const target of targets.slice(0, behaviour.succeed)) {
        await effect(operationKey, payload, target);
      }
      return;
    }

    if (current.timing === 'DURING_EFFECT') {
      // L'effet commence et n'aboutit pas complètement. Pour un envoi
      // multiple : le premier destinataire est servi, pas les suivants.
      const targets = current.targets ?? [];
      if (targets.length > 0) {
        await effect(operationKey, payload, targets[0] ?? '-');
        return;
      }
    }

    await effect(operationKey, payload);
  }

  return {
    id: current.id,

    callCount(): number {
      return calls;
    },

    reconfigure(patch: Partial<HostileConfig>): void {
      current = { ...current, ...patch };
    },

    async send(
      operationKey: string,
      payload: string,
    ): Promise<Result<ProviderReceipt>> {
      calls += 1;
      const behaviour = current.behaviour;

      if (current.latencyMs !== undefined && current.latencyMs > 0) {
        await sleep(current.latencyMs);
      }

      const receipt = (
        claims: ProviderReceipt['claims'] = 'ACCEPTED',
      ): ProviderReceipt => ({
        providerId: current.id,
        reference: `${current.id}:${operationKey}:${String(calls)}`,
        claims,
      });

      /* --- Pannes AVANT tout effet -------------------------------------- */

      if (behaviour.kind === 'HTTP') {
        // Un 429 / 5xx rendu avant traitement : aucun effet. Mais Jarvis ne
        // peut pas le savoir — c'est précisément le piège.
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} a répondu ${String(behaviour.status)}.`,
          ),
        );
      }

      if (behaviour.kind === 'CONNECTION_RESET') {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} : connexion réinitialisée (ECONNRESET).`,
          ),
        );
      }

      if (behaviour.kind === 'SUCCESS_AFTER_ERROR' && failuresSoFar < behaviour.failures) {
        failuresSoFar += 1;
        return err(
          jarvisError('PROVIDER_UNAVAILABLE', `${current.id} : échec transitoire.`),
        );
      }

      /* --- LE MENTEUR n°1 : succès annoncé, aucun effet ------------------
         Le cas qui interdit de traiter la réponse d'un fournisseur comme une
         preuve. Il affirme ACCEPTED ; le monde ne bouge pas. */
      if (behaviour.kind === 'SUCCESS_WITHOUT_EFFECT') {
        return ok(receipt());
      }

      /* --- L'effet, au moment déclaré ----------------------------------- */

      if (current.timing === 'BEFORE_RESPONSE' ||
          current.timing === 'AFTER_EFFECT_BEFORE_RESPONSE' ||
          current.timing === 'DURING_EFFECT') {
        await produceEffect(operationKey, payload);
      }

      /* --- LE MENTEUR n°2 : erreur annoncée, effet bien réel -------------
         L'effet vient d'avoir lieu. Le fournisseur rend une erreur. Un système
         naïf conclurait « échec » et rejouerait — deuxième virement. */
      if (behaviour.kind === 'ERROR_AFTER_EFFECT') {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} : erreur 500 après traitement.`,
          ),
        );
      }

      /* --- Pannes APRÈS l'effet, AVANT la réponse ------------------------ */

      if (behaviour.kind === 'TIMEOUT') {
        // Ne répond jamais. Le `withTimeout` du Gateway tranchera.
        await sleep(3_600_000);
        return err(jarvisError('TIMEOUT', 'inatteignable'));
      }

      if (behaviour.kind === 'LOST_RESPONSE') {
        // L'effet a eu lieu, la réponse se perd sur le réseau. Du point de vue
        // de Jarvis, indiscernable d'un fournisseur qui n'a rien fait.
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} : réponse perdue en transit.`,
          ),
        );
      }

      if (behaviour.kind === 'PROCESS_KILLED') {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} : le processus fournisseur a été tué pendant le traitement.`,
          ),
        );
      }

      if (behaviour.kind === 'DELAYED_RESPONSE') {
        await sleep(behaviour.ms);
      }

      if (behaviour.kind === 'LATENCY') {
        await sleep(behaviour.ms);
      }

      /* --- Effet différé : le fournisseur accuse réception puis traite ---- */
      if (current.timing === 'AFTER_RESPONSE') {
        // On n'attend PAS : la réponse part maintenant, l'effet suivra. C'est
        // le comportement d'une file d'attente côté fournisseur.
        setTimeout(() => {
          void produceEffect(operationKey, payload).catch(() => undefined);
        }, 10);
      }

      if (behaviour.kind === 'PARTIAL') {
        const targets = current.targets ?? [];
        return ok({
          ...receipt('PARTIALLY_ACCEPTED'),
          perTarget: targets.map((target, index) => ({
            target,
            claims:
              index < behaviour.succeed
                ? ('ACCEPTED' as const)
                : ('UNCERTAIN' as const),
          })),
        });
      }

      if (behaviour.kind === 'DUPLICATE_RESPONSE') {
        // Deux réponses pour un appel. La seconde est ignorée par le client
        // HTTP en pratique ; ce qui compte est que l'effet, lui, soit unique.
        return ok(receipt());
      }

      return ok(receipt());
    },
  };
}
