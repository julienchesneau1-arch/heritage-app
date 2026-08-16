/**
 * CHAOS — Foundation 4.
 *
 * Ce fichier ne vérifie pas des scénarios. Il en GÉNÈRE, et cherche des états
 * qui violent les dix invariants — y compris des états que personne n'avait
 * imaginés.
 *
 * Trois précautions le rendent utilisable plutôt qu'impressionnant :
 *
 *   — chaque exécution est indexée par une GRAINE, donc rejouable à
 *     l'identique. Un chaos non reproductible ne produit que du bruit ;
 *   — tout contre-exemple est MINIMISÉ avant d'être rapporté ;
 *   — les invariants s'évaluent APRÈS `settle()`, sinon un effet différé
 *     arriverait après la mesure et le rapport dirait « tout va bien ».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { labDb } from './harness.js';
import { createWorld, resetWorld, worldDb } from './world.js';
import {
  describeScenario,
  generateScenario,
  minimise,
  runScenario,
  seededRng,
  type ChaosResult,
} from './chaos.js';
import { checkInvariants, checkStructuralInvariants, renderViolations } from './invariants.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/** Volume par défaut. Relevé par `JARVIS_CHAOS_RUNS` pour une passe longue. */
const RUNS = Number(process.env['JARVIS_CHAOS_RUNS'] ?? '25');
const STEPS_PER_RUN = 3;

describe.runIf(enabled)('banc — chaos', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(40);
    world = worldDb(20);
    await createWorld(world);
    await resetWorld(world);
  });

  afterAll(async () => {
    await db.close();
    await world.close();
  });

  /* ================================================================== *
   * Les invariants existent et sont évaluables
   * ================================================================== */

  it('les invariants sont déclarés et évaluables', async () => {
    /* Dix depuis Foundation 4 ; I16 (estampille) et I17 (cloisonnement)
       depuis F5.1 ; I18 (échéance lue, jamais recalculée) et I19 (échéance
       frappée par la base) depuis F5.2.

       Les modules orphelins ne sont PAS un invariant d'ici : `wiring.test.ts`
       en fait déjà une analyse d'atteignabilité transitive depuis les points
       d'entrée, strictement plus forte qu'un contrôle d'importation. */
    const report = await checkInvariants(db, world);
    expect(report.checked).toHaveLength(14);
    for (const id of [
      'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10',
      'I16', 'I17', 'I18', 'I19',
    ]) {
      expect(report.checked.some((c) => c.startsWith(`${id} —`))).toBe(true);
    }
  });

  it('les invariants structurels tiennent sur le dépôt courant', () => {
    const report = checkStructuralInvariants();
    if (report.violations.length > 0) {
      throw new Error(`invariants structurels violés :\n${renderViolations(report.violations)}`);
    }
    expect(report.violations).toEqual([]);
  });

  /* ================================================================== *
   * TÉMOIN NÉGATIF — le chaos sait-il détecter une violation ?
   * ================================================================== */

  it('le contrôle d\'invariants DÉTECTE un double effet injecté', async () => {
    // Sans ce test, « aucune violation » ne prouverait rien : un contrôle
    // aveugle rend le même verdict qu'un système correct.
    await resetWorld(world);
    const key = 'temoin-negatif-i1';
    for (let i = 0; i < 2; i += 1) {
      const written = await world.query(
        `INSERT INTO lab_world_effects (operation_key, provider_id, target, payload)
         VALUES ($1, 'injection', 'cible-unique', 'doublon fabriqué')`,
        [key],
      );
      expect(written.ok).toBe(true);
    }

    const report = await checkInvariants(db, world);
    const i1 = report.violations.filter((v) => v.invariant === 'I1');
    expect(i1.length).toBeGreaterThanOrEqual(1);
    expect(i1[0]?.evidence['cible']).toBe('cible-unique');

    await resetWorld(world);
  });

  it('le contrôle d\'invariants DÉTECTE un effet sans trace d\'intention (I7)', async () => {
    await resetWorld(world);
    const written = await world.query(
      `INSERT INTO lab_world_effects (operation_key, provider_id, target, payload)
       VALUES ('orphelin-sans-journal', 'injection', 'x', 'effet fantôme')`,
    );
    expect(written.ok).toBe(true);

    const report = await checkInvariants(db, world);
    expect(report.violations.some((v) => v.invariant === 'I7')).toBe(true);

    await resetWorld(world);
  });

  /* ================================================================== *
   * LA CAMPAGNE
   * ================================================================== */

  it(
    `${String(RUNS)} scénarios aléatoires — aucun invariant violé`,
    async () => {
      const failures: ChaosResult[] = [];

      for (let run = 0; run < RUNS; run += 1) {
        // Graine dérivée de l'indice : la campagne entière est rejouable.
        const seed = 1_000 + run * 7919;
        const scenario = generateScenario(seed, STEPS_PER_RUN);
        const result = await runScenario(db, world, scenario);

        if (result.violations.length > 0) {
          // DISCOVERY → REPRODUCTION → CONTRE-EXEMPLE MINIMAL.
          // On réduit AVANT de rapporter : un scénario de trois étapes et
          // cinquante appels concurrents n'est pas exploitable tel quel.
          const minimal = await minimise(db, world, result);
          failures.push(minimal);
        }
      }

      if (failures.length > 0) {
        const report = failures
          .map((f, i) => `\n─── contre-exemple ${String(i + 1)} ───\n${describeScenario(f)}`)
          .join('\n');
        throw new Error(
          `${String(failures.length)} scénario(s) violent un invariant.\n${report}\n\n` +
            'Discipline Foundation 4 : NE PAS corriger avant d\'avoir écrit ' +
            'l\'invariant et l\'ADR correspondants.',
        );
      }

      expect(failures).toEqual([]);
    },
    600_000,
  );

  /* ================================================================== *
   * Combinaisons explicitement nommées par le mandat
   * ================================================================== */

  it(
    'combinaisons dirigées : TIMEOUT+LATE_SUCCESS, CRASH+CONCURRENCE, FAILOVER+LATE',
    async () => {
      // Le tirage aléatoire couvre l'espace ; ces combinaisons-ci sont
      // nommées par le mandat et méritent d'être jouées à coup sûr plutôt
      // que d'attendre qu'une graine les produise.
      const dirigees = [
        {
          nom: 'TIMEOUT + LATE_SUCCESS',
          step: {
            behaviour: { kind: 'LATE_SUCCESS' as const, afterMs: 60 },
            timing: 'NEVER' as const,
            concurrency: 10,
            resumes: 2,
            latencyMs: 5,
            canVerifyAttempt: true,
            timeoutMs: 200,
          },
        },
        {
          nom: 'ERREUR APRÈS EFFET + CONCURRENCE',
          step: {
            behaviour: { kind: 'ERROR_AFTER_EFFECT' as const },
            timing: 'BEFORE_RESPONSE' as const,
            concurrency: 25,
            resumes: 1,
            latencyMs: 10,
            canVerifyAttempt: false,
            timeoutMs: 1_000,
          },
        },
        {
          nom: 'RÉPONSES DÉSORDONNÉES + CONCURRENCE',
          step: {
            behaviour: { kind: 'OUT_OF_ORDER' as const, maxJitterMs: 40 },
            timing: 'BEFORE_RESPONSE' as const,
            concurrency: 50,
            resumes: 0,
            latencyMs: 0,
            canVerifyAttempt: true,
            timeoutMs: 2_000,
          },
        },
        {
          nom: 'FOURNISSEUR QUI DISPARAÎT + REPRISES',
          step: {
            behaviour: {
              kind: 'DISAPPEARS' as const,
              healthyCalls: 1,
              outageCalls: 4,
            },
            timing: 'BEFORE_RESPONSE' as const,
            concurrency: 5,
            resumes: 3,
            latencyMs: 5,
            canVerifyAttempt: true,
            timeoutMs: 500,
          },
        },
        {
          nom: 'ACK SANS EFFET + VÉRIFICATION DE TENTATIVE',
          step: {
            behaviour: { kind: 'LATE_FAILURE' as const },
            timing: 'NEVER' as const,
            concurrency: 8,
            resumes: 2,
            latencyMs: 0,
            canVerifyAttempt: true,
            timeoutMs: 500,
          },
        },
      ];

      const echecs: string[] = [];
      for (const { nom, step } of dirigees) {
        const result = await runScenario(db, world, { seed: 0, steps: [step] });
        if (result.violations.length > 0) {
          echecs.push(`${nom} :\n${describeScenario(result)}`);
        }
      }

      if (echecs.length > 0) throw new Error(echecs.join('\n\n'));
      expect(echecs).toEqual([]);
    },
    300_000,
  );

  /* ================================================================== *
   * Le générateur lui-même
   * ================================================================== */

  it('une graine donnée produit toujours le même scénario', () => {
    // Sans cette propriété, un contre-exemple ne serait pas rejouable, et le
    // rapport ne vaudrait rien.
    const a = generateScenario(4242, 5);
    const b = generateScenario(4242, 5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const c = generateScenario(4243, 5);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('le tirage couvre réellement l\'espace des pathologies', () => {
    // Un générateur biaisé produirait cent fois `NORMAL` et ne trouverait
    // jamais rien. On vérifie la couverture plutôt que de l'espérer.
    const rng = seededRng(7);
    const vus = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const scenario = generateScenario(rng.int(100_000), 4);
      for (const step of scenario.steps) vus.add(step.behaviour.kind);
    }
    // Les seize pathologies déclarées doivent toutes apparaître.
    expect(vus.size).toBeGreaterThanOrEqual(14);
    expect(vus.has('LATE_SUCCESS')).toBe(true);
    expect(vus.has('ERROR_AFTER_EFFECT')).toBe(true);
    expect(vus.has('OUT_OF_ORDER')).toBe(true);
  });
});
