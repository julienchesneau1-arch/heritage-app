/**
 * COÛT EFFECTIF PAR TÂCHE ACCOMPLIE — Foundation 3.
 *
 * Mesure réelle, sur le fournisseur hostile, de ce que coûte une action
 * RÉELLEMENT vérifiée — par opposition à une action facturée.
 *
 * Le résultat qui compte n'est pas le tableau : c'est l'ordre des colonnes
 * `succès` et `vérifié`. L'écart entre les deux est la part des actions que
 * Jarvis a payées sans pouvoir affirmer qu'elles ont eu lieu.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider, type HostileBehaviour, type EffectTiming } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import { createWorld, externalEffectCount, resetWorld, worldDb } from './world.js';
import { renderMetrics, summarise, type AttemptSample, type CapabilityMetrics } from './metrics.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/** Tarif fictif mais réaliste, par tentative. Seuls les rapports comptent. */
const COST_PER_ATTEMPT_EUR = 0.01;

describe.runIf(enabled)('banc — coût effectif', () => {
  let db: Db;
  let world: Db;
  const collected: CapabilityMetrics[] = [];

  beforeAll(async () => {
    db = labDb(15);
    world = worldDb(10);
    await createWorld(world);
  });

  afterAll(async () => {
    if (collected.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n${renderMetrics(collected)}\n`);
    }
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  /** Joue `runs` opérations distinctes contre un fournisseur donné. */
  async function measure(
    label: string,
    behaviour: HostileBehaviour,
    timing: EffectTiming,
    runs = 20,
    timeoutMs = 500,
  ): Promise<CapabilityMetrics> {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: `cout-${label}`,
          behaviour,
          timing,
          latencyMs: 5,
        }),
        world,
        timeoutMs,
      }),
    );

    const samples: AttemptSample[] = [];
    for (let i = 0; i < runs; i += 1) {
      const key = labKey(`cout-${label}-${String(i)}`);
      const started = Date.now();
      const result = await stack.gateway.invoke(labCall(key));
      const latencyMs = Date.now() - started;

      // On lit le REGISTRE, pas seulement la valeur de retour.
      //
      // Les deux ne disent pas la même chose, et c'est délibéré : sur un
      // timeout, l'appelant reçoit une erreur tandis que le journal écrit
      // `UNKNOWN`. Compter la seule valeur de retour afficherait « 0 %
      // d'incertitude » sur un scénario qui n'est QUE de l'incertitude — la
      // colonne la plus importante du tableau serait vide.
      const journal = await db.query<{ state: string }>(
        'SELECT state FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      const state = journal.ok ? journal.value.rows[0]?.state : undefined;

      samples.push({
        status: result.ok
          ? result.value.status
          : state === 'UNKNOWN'
            ? 'UNKNOWN'
            : 'REFUSED',
        latencyMs,
        costEur: COST_PER_ATTEMPT_EUR,
        fellBack: false,
        externalEffects: await externalEffectCount(world, key),
      });
    }

    const metrics = summarise(label, 'GREEN', samples);
    collected.push(metrics);
    return metrics;
  }

  /* ------------------------------------------------------------------ */

  it('fournisseur sain : coût effectif = coût facturé', async () => {
    const m = await measure('sain', { kind: 'NORMAL' }, 'BEFORE_RESPONSE');

    expect(m.verificationRate).toBe(1);
    expect(m.effectiveCostEur).toBeCloseTo(COST_PER_ATTEMPT_EUR, 5);
    expect(m.doubleEffects).toBe(0);
  }, 60_000);

  it(
    'fournisseur menteur : facturé à chaque appel, ZÉRO tâche accomplie',
    async () => {
      const m = await measure(
        'menteur',
        { kind: 'SUCCESS_WITHOUT_EFFECT' },
        'NEVER',
      );

      // Le fournisseur répond « ACCEPTED » à chaque fois : un tableau de bord
      // naïf afficherait 100 % de succès.
      expect(m.verificationRate).toBe(0);
      // Le coût par tâche réellement accomplie est infini. C'est le chiffre
      // juste, et c'est celui que personne n'affiche.
      expect(m.effectiveCostEur).toBe(Infinity);
    },
    60_000,
  );

  it(
    'timeouts après effet : coût payé, et un UNKNOWN par appel',
    async () => {
      const m = await measure(
        'timeout',
        { kind: 'TIMEOUT' },
        'AFTER_EFFECT_BEFORE_RESPONSE',
        10,
        200,
      );

      expect(m.verificationRate).toBe(0);
      // Chaque appel laisse une incertitude, donc une décision humaine à
      // prendre. C'est le poste de coût dominant, et il n'est pas monétaire.
      expect(m.doubleEffects).toBe(0);
    },
    60_000,
  );

  it(
    'échecs transitoires : le coût effectif monte, sans rejeu automatique',
    async () => {
      const m = await measure(
        'transitoire',
        { kind: 'SUCCESS_AFTER_ERROR', failures: 8 },
        'BEFORE_RESPONSE',
      );

      // Une part des appels échoue, donc le coût par succès dépasse le tarif.
      expect(m.effectiveCostEur).toBeGreaterThan(COST_PER_ATTEMPT_EUR);
      expect(m.verificationRate).toBeLessThan(1);
      expect(m.verificationRate).toBeGreaterThan(0);
      // Et surtout : le Gateway n'a pas compensé par des rejeux silencieux.
      expect(m.doubleEffects).toBe(0);
    },
    60_000,
  );

  it(
    'la métrique refuse de compter PROBABLE comme un succès',
    () => {
      // Propriété du calcul lui-même, pas du fournisseur : c'est elle qui
      // interdit au tableau de bord de se mentir.
      const m = summarise('synthetique', 'GREEN', [
        { status: 'PROBABLE', latencyMs: 10, costEur: 1, fellBack: false, externalEffects: 1 },
        { status: 'PROBABLE', latencyMs: 10, costEur: 1, fellBack: false, externalEffects: 1 },
      ]);

      expect(m.successRate).toBe(1);
      expect(m.verificationRate).toBe(0);
      expect(m.effectiveCostEur).toBe(Infinity);
    },
  );
});
