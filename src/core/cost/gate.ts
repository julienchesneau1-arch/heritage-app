/**
 * Le CostGate — `docs/04 §9-11`, ADR-040.
 *
 * LE PROBLÈME QU'IL RÉSOUT, ET QUI N'EST PAS « COMPTER »
 * ------------------------------------------------------
 * `docs/04` pose « 0 € récurrent » comme invariant. Il était tenu **par
 * absence de dépense** — aucun fournisseur cloud n'est branché — et non **par
 * mécanisme**. Un invariant qui repose sur le fait que rien n'est branché
 * cesse d'être un invariant au premier branchement.
 *
 * L'ORDRE, QUI EST TOUT — `docs/14 §4`
 * -------------------------------------
 *   REQUÊTE → CLASSIFICATION → POLITIQUE → CAPACITÉS AUTORISÉES
 *           → CHOIX DU MODÈLE (le moins cher parmi les ÉLIGIBLES)
 *           → BUDGET
 *
 * Le coût intervient EN DERNIER, et jamais :
 *
 *   ✗ LOCAL → échec → CLOUD → échec → PREMIUM
 *
 * > Un modèle non autorisé n'existe pas comme repli — même si tous les
 * > modèles autorisés sont indisponibles.
 *
 * D'où la propriété structurante de ce module : **le CostGate ne peut que
 * RESTREINDRE.** Il transforme un `ALLOW_CLOUD` en `DENY` quand le budget est
 * atteint ; il ne transforme jamais un `LOCAL_ONLY` en `ALLOW_CLOUD`, quel que
 * soit le budget disponible ou l'indisponibilité du local.
 *
 * LA MONNAIE EST EN ENTIERS
 * -------------------------
 * Micro-euros (millionièmes), en entiers. Un budget en flottant dérive :
 * additionner dix mille appels à 0,0001 € ne rend pas exactement 1 €, et
 * « blocage dur à 100 % » devient « blocage dur vers 100 % ». Sur un seuil,
 * l'approximation n'est pas acceptable.
 */
import type { Db } from '../db/client.js';
import type { PrivacyClass } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

/** Millionièmes d'euro. Type marqué pour interdire un euro flottant égaré. */
export type Micros = number & { readonly __brand: 'Micros' };

/** Convertit des euros en micro-euros, en arrondissant AU SUPÉRIEUR. */
export function eurosToMicros(euros: number): Micros {
  /* L'arrondi supérieur est délibéré. Un budget arrondi vers le bas serait
     dépassé d'un centième sans que rien ne le signale ; une estimation
     arrondie vers le bas laisserait passer un appel qui déborde. Les deux
     erreurs vont dans la même direction, et ce n'est pas la bonne. */
  return Math.ceil(euros * 1_000_000) as Micros;
}

export function microsToEuros(micros: Micros | number): number {
  return micros / 1_000_000;
}

/**
 * Ce que la POLITIQUE a autorisé, avant que le coût n'ait son mot à dire.
 *
 * Ce n'est PAS un paramètre parmi d'autres : c'est le résultat des étapes
 * amont de `docs/14 §4`, et le CostGate ne peut que le restreindre.
 */
export type PolicyAllowance =
  /** La politique interdit toute sortie. Le coût n'y changera rien. */
  | 'LOCAL_ONLY'
  /** La politique autorise le cloud. Reste à savoir si le budget le permet. */
  | 'LOCAL_OR_CLOUD';

export type CostDecision = 'ALLOW_LOCAL' | 'ALLOW_CLOUD' | 'ASK_USER' | 'DENY';

export interface CostRequest {
  readonly provider: string;
  readonly model: string;
  /** Ce que la politique a déjà tranché. Le coût ne le rouvre jamais. */
  readonly allowance: PolicyAllowance;
  readonly estimated: Micros;
  readonly privacyClass: PrivacyClass;
  /** Une opération importante peut justifier de DEMANDER plutôt que refuser. */
  readonly importance: 'ROUTINE' | 'IMPORTANT';
  readonly operationId?: string;
}

export interface CostVerdict {
  readonly decision: CostDecision;
  /** Toujours renseignée : `docs/04 §10` exige la raison du routage. */
  readonly reason: string;
  readonly spentMicros: number;
  readonly budgetMicros: number;
  /** Le seuil d'alerte est-il franchi ? `docs/04 §9` : alerte à 50 %. */
  readonly alert: boolean;
}

export interface SpendSummary {
  readonly todayMicros: number;
  readonly weekMicros: number;
  readonly monthMicros: number;
  readonly byProvider: readonly { provider: string; micros: number; calls: number }[];
  /** `docs/04 §11` — « le pourcentage local augmente continûment ». */
  readonly localRatio: number;
  readonly mostExpensive: { provider: string; model: string; micros: number } | null;
}

export interface CostGate {
  /** Décide AVANT l'appel, sur l'estimation. */
  decide(request: CostRequest): Promise<Result<CostVerdict>>;
  /** Enregistre APRÈS l'appel, sur le coût réel. */
  record(entry: {
    readonly provider: string;
    readonly model: string;
    readonly decision: CostDecision;
    readonly reason: string;
    readonly privacyClass: PrivacyClass;
    readonly estimated: Micros;
    readonly actual?: Micros;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly latencyMs?: number;
    readonly operationId?: string;
  }): Promise<Result<{ readonly overrun: boolean }>>;
  summary(): Promise<Result<SpendSummary>>;
}

export interface CostGateConfig {
  readonly budgetMonthlyEur: number;
  readonly alertAtPercent: number;
  readonly hardBlockAtPercent: number;
  /** I2 — le cloud doit pouvoir être coupé globalement. */
  readonly cloudEnabled: boolean;
}

export function createCostGate(deps: { db: Db; config: CostGateConfig }): CostGate {
  const budget = eurosToMicros(deps.config.budgetMonthlyEur);

  /**
   * Dépense du mois EN COURS, calculée PAR LA BASE.
   *
   * `date_trunc('month', clock_timestamp())` et non une borne calculée en
   * JavaScript : la leçon d'ADR-036 et d'ADR-037 réunies — l'observateur ne
   * redéfinit ni l'échéance ni le mois. Un processus dont l'horloge dérive
   * d'un mois lirait sinon un budget vide.
   */
  async function spentThisMonth(): Promise<Result<number>> {
    const rows = await deps.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(COALESCE(actual_micros, estimated_micros)), 0)::text AS total
         FROM cloud_spend
        WHERE occurred_at >= date_trunc('month', clock_timestamp())
          AND decision = 'ALLOW_CLOUD'`,
    );
    if (!rows.ok) return rows;
    return ok(Number(rows.value.rows[0]?.total ?? '0'));
  }

  return {
    async decide(request: CostRequest): Promise<Result<CostVerdict>> {
      const spent = await spentThisMonth();
      if (!spent.ok) return spent;

      const alertThreshold = (budget * deps.config.alertAtPercent) / 100;
      const blockThreshold = (budget * deps.config.hardBlockAtPercent) / 100;
      const alert = budget > 0 && spent.value >= alertThreshold;

      const base = {
        spentMicros: spent.value,
        budgetMicros: budget,
        alert,
      };

      /* ══ 1. LA POLITIQUE D'ABORD, ET ELLE NE SE REDISCUTE PAS ══════════
         Le cas le plus important du module, et celui qu'un test dédié
         attaque : `LOCAL_ONLY` reste local même avec un budget illimité.
         Le coût n'a pas le droit d'ouvrir une porte que la confidentialité a
         fermée. */
      if (request.allowance === 'LOCAL_ONLY') {
        return ok({
          ...base,
          decision: 'ALLOW_LOCAL',
          reason:
            `La politique restreint cette requête au local (classe ` +
            `${request.privacyClass}). Le budget n'entre pas en ligne de compte.`,
        });
      }

      /* ══ 2. L'interrupteur global — I2 ═══════════════════════════════ */
      if (!deps.config.cloudEnabled) {
        return ok({
          ...base,
          decision: 'ALLOW_LOCAL',
          reason: 'Le cloud est désactivé globalement. Traitement local uniquement.',
        });
      }

      /* ══ 3. LE BUDGET, EN DERNIER ════════════════════════════════════
         « Aucun dépassement silencieux, jamais » (`docs/04 §9`). La décision
         se prend sur `dépensé + estimation`, pas sur `dépensé` seul : un
         appel qui déborderait est refusé AVANT de partir, jamais constaté
         après. */
      const projected = spent.value + request.estimated;

      if (budget === 0) {
        /* Le DÉFAUT du pack, et il doit se comporter comme un vrai zéro.
           Un budget nul n'autorise aucun appel cloud — pas « presque
           aucun ». */
        return ok({
          ...base,
          decision: 'ALLOW_LOCAL',
          reason:
            'Budget cloud à 0 € — le défaut du pack. Aucun appel payant ' +
            "n'est engagé ; la requête est traitée localement.",
        });
      }

      if (projected > blockThreshold) {
        /* Blocage dur. `ASK_USER` plutôt que `DENY` quand la requête est
           IMPORTANTE : refuser silencieusement une opération importante
           serait une dégradation invisible, et `docs/04` interdit surtout le
           dépassement SILENCIEUX — pas la question posée. */
        const decision: CostDecision =
          request.importance === 'IMPORTANT' ? 'ASK_USER' : 'DENY';
        return ok({
          ...base,
          decision,
          reason:
            `Blocage dur : ${formatEuros(projected)} projeté dépasse le ` +
            `plafond de ${formatEuros(blockThreshold)} ` +
            `(${String(deps.config.hardBlockAtPercent)} % de ` +
            `${formatEuros(budget)}). Dépensé ce mois : ${formatEuros(spent.value)}.`,
        });
      }

      return ok({
        ...base,
        decision: 'ALLOW_CLOUD',
        reason: alert
          ? `Autorisé, mais le seuil d'alerte de ` +
            `${String(deps.config.alertAtPercent)} % est franchi : ` +
            `${formatEuros(spent.value)} sur ${formatEuros(budget)}.`
          : `Autorisé. Estimation ${formatEuros(request.estimated)} ; ` +
            `dépensé ce mois ${formatEuros(spent.value)} sur ${formatEuros(budget)}.`,
      });
    },

    async record(entry): Promise<Result<{ readonly overrun: boolean }>> {
      const written = await deps.db.query(
        `INSERT INTO cloud_spend
           (provider, model, estimated_micros, actual_micros, tokens_in,
            tokens_out, latency_ms, privacy_class, routing_reason, decision,
            operation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entry.provider,
          entry.model,
          String(entry.estimated),
          entry.actual === undefined ? null : String(entry.actual),
          String(entry.tokensIn ?? 0),
          String(entry.tokensOut ?? 0),
          entry.latencyMs === undefined ? null : String(entry.latencyMs),
          entry.privacyClass,
          entry.reason,
          entry.decision,
          entry.operationId ?? null,
        ],
      );
      if (!written.ok) return written;

      /* LE DÉPASSEMENT QUI ARRIVE QUAND MÊME.
         Une estimation peut être basse — c'est une estimation. Le blocage dur
         travaille dessus, donc il peut être franchi APRÈS coup, sur le coût
         réel. Ce cas n'est pas évitable ; ce qui l'est, c'est qu'il passe
         inaperçu. On le rend, l'appelant doit le dire. */
      const spent = await spentThisMonth();
      if (!spent.ok) return spent;
      const blockThreshold = (budget * deps.config.hardBlockAtPercent) / 100;
      return ok({ overrun: budget > 0 && spent.value > blockThreshold });
    },

    async summary(): Promise<Result<SpendSummary>> {
      const totals = await deps.db.query<{
        today: string;
        week: string;
        month: string;
      }>(
        `SELECT
           COALESCE(SUM(COALESCE(actual_micros, estimated_micros))
             FILTER (WHERE occurred_at >= date_trunc('day', clock_timestamp())), 0)::text AS today,
           COALESCE(SUM(COALESCE(actual_micros, estimated_micros))
             FILTER (WHERE occurred_at >= date_trunc('week', clock_timestamp())), 0)::text AS week,
           COALESCE(SUM(COALESCE(actual_micros, estimated_micros))
             FILTER (WHERE occurred_at >= date_trunc('month', clock_timestamp())), 0)::text AS month
         FROM cloud_spend WHERE decision = 'ALLOW_CLOUD'`,
      );
      if (!totals.ok) return totals;

      const perProvider = await deps.db.query<{
        provider: string;
        micros: string;
        calls: string;
      }>(
        `SELECT provider,
                COALESCE(SUM(COALESCE(actual_micros, estimated_micros)), 0)::text AS micros,
                count(*)::text AS calls
           FROM cloud_spend WHERE decision = 'ALLOW_CLOUD'
          GROUP BY provider ORDER BY 2 DESC`,
      );
      if (!perProvider.ok) return perProvider;

      const ratio = await deps.db.query<{ local: string; total: string }>(
        `SELECT count(*) FILTER (WHERE decision = 'ALLOW_LOCAL')::text AS local,
                count(*)::text AS total
           FROM cloud_spend`,
      );
      if (!ratio.ok) return ratio;

      const top = await deps.db.query<{
        provider: string;
        model: string;
        micros: string;
      }>(
        `SELECT provider, model,
                COALESCE(actual_micros, estimated_micros)::text AS micros
           FROM cloud_spend WHERE decision = 'ALLOW_CLOUD'
          ORDER BY COALESCE(actual_micros, estimated_micros) DESC LIMIT 1`,
      );
      if (!top.ok) return top;

      const row = totals.value.rows[0];
      const counts = ratio.value.rows[0];
      const total = Number(counts?.total ?? '0');
      const first = top.value.rows[0];

      return ok({
        todayMicros: Number(row?.today ?? '0'),
        weekMicros: Number(row?.week ?? '0'),
        monthMicros: Number(row?.month ?? '0'),
        byProvider: perProvider.value.rows.map((p) => ({
          provider: p.provider,
          micros: Number(p.micros),
          calls: Number(p.calls),
        })),
        /* Un dépôt sans aucun appel affiche 100 % local, et c'est exact :
           tout ce qui a été fait l'a été localement. Rendre 0 laisserait
           croire à une dérive qui n'existe pas. */
        localRatio: total === 0 ? 1 : Number(counts?.local ?? '0') / total,
        mostExpensive:
          first === undefined
            ? null
            : {
                provider: first.provider,
                model: first.model,
                micros: Number(first.micros),
              },
      });
    },
  };
}

/** Rendu monétaire à quatre décimales — un micro-euro reste visible. */
function formatEuros(micros: number): string {
  return `${microsToEuros(micros).toFixed(4)} €`;
}

/** Refus type quand la configuration du budget est incohérente. */
export function invalidBudget(detail: string): Result<never> {
  return err(jarvisError('CONFIGURATION', `Budget cloud incohérent : ${detail}`));
}
