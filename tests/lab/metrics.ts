/**
 * MÉTRIQUES DE COÛT RÉEL — banc de défaillance, Foundation 3.
 *
 * Le mandat pose la bonne question :
 *
 *   > Un modèle à 0,01 € qui échoue 30 % du temps peut coûter plus cher qu'un
 *   > modèle à 0,03 € qui réussit 99 % du temps.
 *
 * Ce module la mesure. Et il ajoute la moitié que le calcul naïf oublie.
 *
 * CE QUI COMPTE COMME « SUCCÈS » DANS LE DÉNOMINATEUR
 * ---------------------------------------------------
 * Seul `CONFIRMED`. Ni `PROBABLE`, ni `UNKNOWN`. Sinon on divise par des
 * succès supposés, et le coût effectif devient une fiction flatteuse — c'est
 * exactement l'erreur que fait tout tableau de bord de fournisseur d'IA.
 *
 * LE COÛT QUE PERSONNE NE COMPTE
 * ------------------------------
 * Un `UNKNOWN` n'est pas un échec bon marché. Il consomme une décision
 * HUMAINE : quelqu'un doit aller vérifier si l'email est parti. Sur une
 * opération à effet externe, c'est le poste de coût dominant, très au-dessus
 * du prix du jeton.
 *
 * On le compte donc séparément, en `unknownRate`, et on refuse de le fondre
 * dans un « taux d'échec » qui le rendrait invisible.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import type { VerificationStatus } from '../../src/core/types/domain.js';
import type { PrivacyClass } from '../../src/core/types/domain.js';

export interface AttemptSample {
  readonly status: VerificationStatus | 'REFUSED';
  readonly latencyMs: number;
  /** Coût monétaire de la tentative. 0 pour un traitement local. */
  readonly costEur: number;
  /** Un repli sur un autre fournisseur a-t-il été tenté ? */
  readonly fellBack: boolean;
  /** Effets réellement constatés dans le monde. */
  readonly externalEffects: number;
}

export interface CapabilityMetrics {
  readonly label: string;
  readonly privacyClass: PrivacyClass;
  readonly attempts: number;

  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;

  /** Part des tentatives qui rendent un résultat, vérifié ou non. */
  readonly successRate: number;
  /** Part des tentatives réellement CONFIRMÉES. C'est la seule qui compte. */
  readonly verificationRate: number;
  /** Part laissée en ignorance — chacune coûte une décision humaine. */
  readonly unknownRate: number;
  readonly fallbackRate: number;

  readonly costEur: number;
  /**
   * Coût par tâche RÉELLEMENT accomplie et vérifiée.
   *
   * `Infinity` quand aucune tentative n'a été confirmée : ce n'est pas une
   * anomalie de calcul, c'est le résultat juste. Un fournisseur qui ne confirme
   * jamais n'a pas un coût élevé — il n'a pas de coût par succès, faute de
   * succès.
   */
  readonly effectiveCostEur: number;

  /** Violations de l'inégalité fondamentale. Doit valoir 0. */
  readonly doubleEffects: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export function summarise(
  label: string,
  privacyClass: PrivacyClass,
  samples: readonly AttemptSample[],
): CapabilityMetrics {
  const n = samples.length;
  const latencies = [...samples.map((s) => s.latencyMs)].sort((a, b) => a - b);

  const confirmed = samples.filter((s) => s.status === 'CONFIRMED').length;
  const returned = samples.filter(
    (s) => s.status === 'CONFIRMED' || s.status === 'PROBABLE',
  ).length;
  const unknown = samples.filter((s) => s.status === 'UNKNOWN').length;
  const fellBack = samples.filter((s) => s.fellBack).length;
  const cost = samples.reduce((sum, s) => sum + s.costEur, 0);

  return {
    label,
    privacyClass,
    attempts: n,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    successRate: n === 0 ? 0 : returned / n,
    verificationRate: n === 0 ? 0 : confirmed / n,
    unknownRate: n === 0 ? 0 : unknown / n,
    fallbackRate: n === 0 ? 0 : fellBack / n,
    costEur: cost,
    effectiveCostEur: confirmed === 0 ? Infinity : cost / confirmed,
    doubleEffects: samples.filter((s) => s.externalEffects > 1).length,
  };
}

/** Tableau lisible, destiné au rapport. */
export function renderMetrics(rows: readonly CapabilityMetrics[]): string {
  const header =
    '| Scénario | p50 | p95 | succès | vérifié | UNKNOWN | repli | coût | coût/succès | doublons |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|';

  const pct = (v: number): string => `${String(Math.round(v * 100))} %`;
  const eur = (v: number): string =>
    Number.isFinite(v) ? `${v.toFixed(4)} €` : '**∞**';

  const lines = rows.map(
    (r) =>
      `| ${r.label} | ${String(r.p50LatencyMs)} ms | ${String(r.p95LatencyMs)} ms | ` +
      `${pct(r.successRate)} | **${pct(r.verificationRate)}** | ${pct(r.unknownRate)} | ` +
      `${pct(r.fallbackRate)} | ${r.costEur.toFixed(3)} € | ${eur(r.effectiveCostEur)} | ` +
      `${String(r.doubleEffects)} |`,
  );

  return [header, rule, ...lines].join('\n');
}
