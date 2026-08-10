/**
 * CHAOS RUNNER — Foundation 4.
 *
 * Le mandat impose une discipline avant toute correction :
 *
 *   DISCOVERY → REPRODUCTION → CONTRE-EXEMPLE MINIMAL → INVARIANT
 *             → ADR → CORRECTION → TEST DE RÉGRESSION → CHAOS RE-RUN
 *
 * Ce module couvre les trois premières étapes, et la troisième est celle qui
 * demande du travail : un scénario aléatoire qui casse un invariant est presque
 * inexploitable tel quel — trente appels, quatre pannes, deux crashs. Il faut
 * le RÉDUIRE jusqu'à ce qu'il ne reste que ce qui cause le défaut.
 *
 * C'est le principe du « shrinking » des tests à propriétés. Sans lui, le chaos
 * produit des rapports impressionnants et inutilisables.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import type { Db } from '../../src/core/db/client.js';
import { buildLabStack, labCall, labKey } from './harness.js';
import { createHostileProvider, type HostileBehaviour, type EffectTiming } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import { checkInvariants, renderViolations, type Violation } from './invariants.js';
import { resetWorld } from './world.js';

/* -------------------------------------------------------------------------- *
 * Générateur déterministe
 *
 * Un chaos non reproductible ne sert à rien : un contre-exemple doit pouvoir
 * être rejoué à l'identique par quelqu'un d'autre, six mois plus tard. On
 * n'utilise donc jamais `Math.random()` — chaque exécution est indexée par une
 * graine imprimée dans le rapport.
 * -------------------------------------------------------------------------- */

export interface Rng {
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
}

export function seededRng(seed: number): Rng {
  // xorshift32 — court, déterministe, suffisant pour du tirage de scénario.
  let state = seed | 0 || 0x2f6e2b1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  return {
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    bool: (probability = 0.5) => next() < probability,
  };
}

/* -------------------------------------------------------------------------- *
 * Scénario
 * -------------------------------------------------------------------------- */

/** Une opération dans un scénario de chaos. */
export interface ChaosStep {
  readonly behaviour: HostileBehaviour;
  readonly timing: EffectTiming;
  /** Appels simultanés sur la MÊME clé. */
  readonly concurrency: number;
  /** Reprises séquentielles après le premier round. */
  readonly resumes: number;
  readonly latencyMs: number;
  readonly canVerifyAttempt: boolean;
  readonly timeoutMs: number;
}

export interface ChaosScenario {
  readonly seed: number;
  readonly steps: readonly ChaosStep[];
}

const BEHAVIOURS: readonly HostileBehaviour[] = [
  { kind: 'NORMAL' },
  { kind: 'TIMEOUT' },
  { kind: 'LOST_RESPONSE' },
  { kind: 'DUPLICATE_RESPONSE' },
  { kind: 'HTTP', status: 429 },
  { kind: 'HTTP', status: 500 },
  { kind: 'HTTP', status: 503 },
  { kind: 'SUCCESS_AFTER_ERROR', failures: 2 },
  { kind: 'ERROR_AFTER_EFFECT' },
  { kind: 'SUCCESS_WITHOUT_EFFECT' },
  { kind: 'CONNECTION_RESET' },
  { kind: 'PROCESS_KILLED' },
  { kind: 'LATE_SUCCESS', afterMs: 40 },
  { kind: 'LATE_FAILURE' },
  { kind: 'OUT_OF_ORDER', maxJitterMs: 30 },
  { kind: 'DISAPPEARS', healthyCalls: 2, outageCalls: 3 },
];

const TIMINGS: readonly EffectTiming[] = [
  'NEVER',
  'BEFORE_RESPONSE',
  'AFTER_EFFECT_BEFORE_RESPONSE',
  'AFTER_RESPONSE',
];

const CONCURRENCY_LEVELS: readonly number[] = [1, 2, 5, 10, 25, 50];

export function generateScenario(seed: number, stepCount: number): ChaosScenario {
  const rng = seededRng(seed);
  const steps: ChaosStep[] = [];

  for (let i = 0; i < stepCount; i += 1) {
    steps.push({
      behaviour: rng.pick(BEHAVIOURS),
      timing: rng.pick(TIMINGS),
      concurrency: rng.pick(CONCURRENCY_LEVELS),
      resumes: rng.int(3),
      latencyMs: rng.pick([0, 5, 20, 50]),
      canVerifyAttempt: rng.bool(0.5),
      // Court à dessein : un timeout doit pouvoir se déclencher.
      timeoutMs: rng.pick([120, 300, 1000]),
    });
  }

  return { seed, steps };
}

/* -------------------------------------------------------------------------- *
 * Exécution
 * -------------------------------------------------------------------------- */

export interface ChaosResult {
  readonly scenario: ChaosScenario;
  readonly violations: readonly Violation[];
  readonly operations: number;
}

/**
 * Joue un scénario, puis évalue les dix invariants.
 *
 * ⚠ `settle()` avant la vérification : un scénario comportant un
 * `LATE_SUCCESS` change encore le monde après le retour de l'appel. Mesurer
 * trop tôt donnerait un « aucune violation » qui ne veut rien dire.
 */
export async function runScenario(
  db: Db,
  world: Db,
  scenario: ChaosScenario,
): Promise<ChaosResult> {
  await resetWorld(world);
  await db.query("DELETE FROM tool_operations WHERE tool_id LIKE 'lab_%'");

  let operations = 0;

  for (const step of scenario.steps) {
    const provider = createHostileProvider(world, {
      id: 'chaos',
      behaviour: step.behaviour,
      timing: step.timing,
      latencyMs: step.latencyMs,
    });

    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider,
        world,
        canVerifyAttempt: step.canVerifyAttempt,
        timeoutMs: step.timeoutMs,
      }),
    );

    const key = labKey('chaos');
    operations += 1;

    // Rafale concurrente sur une clé unique.
    await Promise.all(
      Array.from({ length: step.concurrency }, () => stack.gateway.invoke(labCall(key))),
    );

    // Puis des reprises séquentielles — la combinaison qui a révélé CRIT-4.
    for (let r = 0; r < step.resumes; r += 1) {
      await stack.gateway.invoke(labCall(key));
    }

    await provider.settle();
  }

  const report = await checkInvariants(db, world);
  return { scenario, violations: report.violations, operations };
}

/* -------------------------------------------------------------------------- *
 * Minimisation — l'étape que le mandat exige avant toute correction
 * -------------------------------------------------------------------------- */

/**
 * Réduit un scénario fautif jusqu'à un contre-exemple minimal.
 *
 * Trois passes, de la plus grossière à la plus fine :
 *
 *   1. supprimer des étapes    — combien d'opérations faut-il vraiment ?
 *   2. baisser la concurrence  — le défaut existe-t-il à 2 appels ?
 *   3. retirer les reprises    — la reprise est-elle nécessaire ?
 *
 * On ne conserve une réduction que si elle REPRODUIT la même famille de
 * violation. Sinon on l'annule : réduire jusqu'à faire disparaître le défaut
 * transformerait un contre-exemple en illusion de correction.
 */
export async function minimise(
  db: Db,
  world: Db,
  failing: ChaosResult,
  maxAttempts = 40,
): Promise<ChaosResult> {
  const target = new Set(failing.violations.map((v) => v.invariant));
  let best = failing;
  let attempts = 0;

  const reproduces = (result: ChaosResult): boolean =>
    result.violations.some((v) => target.has(v.invariant));

  /* 1. Moins d'étapes. */
  for (let index = best.scenario.steps.length - 1; index >= 0; index -= 1) {
    if (attempts >= maxAttempts) break;
    if (best.scenario.steps.length <= 1) break;
    attempts += 1;

    const steps = best.scenario.steps.filter((_, i) => i !== index);
    const candidate = await runScenario(db, world, { ...best.scenario, steps });
    if (reproduces(candidate)) best = candidate;
  }

  /* 2. Moins de concurrence. */
  for (const level of CONCURRENCY_LEVELS) {
    if (attempts >= maxAttempts) break;
    attempts += 1;

    const steps = best.scenario.steps.map((s) => ({
      ...s,
      concurrency: Math.min(s.concurrency, level),
    }));
    const candidate = await runScenario(db, world, { ...best.scenario, steps });
    if (reproduces(candidate)) {
      best = candidate;
      break; // Le plus petit niveau qui reproduit suffit.
    }
  }

  /* 3. Moins de reprises. */
  if (attempts < maxAttempts) {
    const steps = best.scenario.steps.map((s) => ({ ...s, resumes: 0 }));
    const candidate = await runScenario(db, world, { ...best.scenario, steps });
    if (reproduces(candidate)) best = candidate;
  }

  return best;
}

/** Rapport reproductible d'un contre-exemple. */
export function describeScenario(result: ChaosResult): string {
  const lines = [
    `graine : ${String(result.scenario.seed)}`,
    `opérations : ${String(result.operations)}`,
    '',
  ];

  result.scenario.steps.forEach((step, index) => {
    lines.push(
      `  étape ${String(index + 1)} : ${step.behaviour.kind} · effet ${step.timing} · ` +
        `${String(step.concurrency)} simultanés · ${String(step.resumes)} reprises · ` +
        `latence ${String(step.latencyMs)} ms · timeout ${String(step.timeoutMs)} ms · ` +
        `vérif. tentative ${step.canVerifyAttempt ? 'oui' : 'non'}`,
    );
  });

  lines.push('', renderViolations(result.violations));
  return lines.join('\n');
}
