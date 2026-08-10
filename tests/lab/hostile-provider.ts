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
  | { readonly kind: 'PROCESS_KILLED' }
  /* ---- Foundation 4 : les pathologies qui manquaient ------------------- */
  /**
   * SUCCÈS TARDIF — la plus dangereuse de toutes.
   *
   * Le fournisseur répond en erreur (ou ne répond pas), puis produit l'effet
   * `afterMs` plus tard. Tout système qui conclut « échec » et rejoue produit
   * alors DEUX effets, et le second arrive avant même le premier.
   */
  | { readonly kind: 'LATE_SUCCESS'; readonly afterMs: number }
  /**
   * ÉCHEC TARDIF — le miroir, et il trompe dans l'autre sens.
   *
   * Le fournisseur accuse réception, puis abandonne silencieusement. Un `ACK`
   * n'a jamais valu preuve d'effet ; ce comportement le démontre.
   */
  | { readonly kind: 'LATE_FAILURE' }
  /**
   * RÉPONSES DÉSORDONNÉES.
   *
   * Chaque appel attend une durée tirée au hasard : sous concurrence, les
   * réponses reviennent dans un ordre sans rapport avec celui des envois.
   */
  | { readonly kind: 'OUT_OF_ORDER'; readonly maxJitterMs: number }
  /**
   * LE FOURNISSEUR DISPARAÎT PUIS REVIENT.
   *
   * Sain pendant `healthyCalls`, absent pendant `outageCalls`, puis sain de
   * nouveau. C'est la panne d'exploitation ordinaire — celle qui arrive
   * vraiment, et pendant laquelle les reprises s'accumulent.
   */
  | {
      readonly kind: 'DISAPPEARS';
      readonly healthyCalls: number;
      readonly outageCalls: number;
    };

export interface HostileConfig {
  readonly id: string;
  readonly behaviour: HostileBehaviour;
  readonly timing: EffectTiming;
  /** Latence de base, avant toute pathologie. */
  readonly latencyMs?: number;
  /** Destinataires, pour les scénarios de succès partiel. */
  readonly targets?: readonly string[];
  /**
   * Le fournisseur DÉDOUBLONNE-T-IL réellement sur la clé d'opération ?
   *
   * Distinct du contrat DÉCLARÉ par l'outil, et c'est tout l'intérêt : le banc
   * peut mettre en scène un fournisseur qui PRÉTEND être idempotent sans
   * l'être. C'est le risque résiduel d'ADR-033 — la garantie vient d'un tiers,
   * et nous ne pouvons que le croire.
   */
  readonly reallyIdempotent?: boolean;
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
  /**
   * Attend que les effets DIFFÉRÉS aient eu lieu.
   *
   * Indispensable dès qu'un scénario comporte un `LATE_SUCCESS` : sans cela le
   * banc mesurerait le monde avant qu'il ait fini de changer, et conclurait à
   * une absence d'effet qui n'existe pas. C'est le piège que ce simulateur est
   * censé mettre en scène — il ne doit pas y tomber lui-même.
   */
  settle(): Promise<void>;
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
  /* Effets différés en vol. Le banc doit pouvoir les attendre : sinon un test
     se terminerait avant que le monde ait fini de changer, et mesurerait une
     photo prise trop tôt. */
  const pending = new Set<Promise<void>>();

  function schedule(work: () => Promise<void>, delayMs: number): void {
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        void work().catch(() => undefined).finally(resolve);
      }, delayMs);
    });
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  }

  /** Écrit dans le monde. Irréversible, par construction. */
  async function effect(operationKey: string, payload: string, target = '-'): Promise<void> {
    if (current.reallyIdempotent === true) {
      // Un vrai fournisseur idempotent refuse le doublon LUI-MÊME, sans rien
      // demander à son client. C'est ce qui rend le rejeu sûr même quand une
      // requête antérieure aboutit plus tard.
      const existing = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lab_world_effects
          WHERE operation_key = $1 AND target = $2`,
        [operationKey, target],
      );
      if (existing.ok && Number(existing.value.rows[0]?.n ?? '0') > 0) return;
    }
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

    /** Attend que tous les effets différés aient eu lieu. */
    async settle(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
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

      /* --- Foundation 4 : effets DIFFÉRÉS -------------------------------- */

      if (behaviour.kind === 'LATE_SUCCESS') {
        // L'effet arrivera. Mais Jarvis reçoit une erreur MAINTENANT, et ne
        // dispose d'aucun moyen de savoir que le monde changera plus tard.
        schedule(() => produceEffect(operationKey, payload), behaviour.afterMs);
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `${current.id} : erreur immédiate, traitement différé en file.`,
          ),
        );
      }

      if (behaviour.kind === 'LATE_FAILURE') {
        // Accusé de réception, puis abandon silencieux. Aucun effet, jamais.
        return ok(receipt());
      }

      if (behaviour.kind === 'DISAPPEARS') {
        const cycle = behaviour.healthyCalls + behaviour.outageCalls;
        const position = (calls - 1) % Math.max(1, cycle);
        if (position >= behaviour.healthyCalls) {
          return err(
            jarvisError(
              'PROVIDER_UNAVAILABLE',
              `${current.id} : service momentanément indisponible.`,
            ),
          );
        }
      }

      if (behaviour.kind === 'OUT_OF_ORDER') {
        // Le désordre se fabrique par une attente tirée au hasard AVANT
        // l'effet : deux appels concurrents s'entrelacent alors réellement.
        await sleep(Math.floor(Math.random() * behaviour.maxJitterMs));
      }

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
