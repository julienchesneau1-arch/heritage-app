/**
 * CRASH + CONCURRENCE + REPRISE — Foundation 3.
 *
 * Le scénario que le mandat désigne comme le plus dangereux :
 *
 *     Requête A ──► PLANNED ──► EXECUTING ──► 💥
 *     Requête B ──► même operation_key, AU MÊME MOMENT
 *     Processus C ──► reprise
 *
 * Trois façons de se tromper, et le banc les vérifie une par une :
 *
 *   1. B rejoue pendant que A est encore en vol            → double effet
 *   2. C conclut « pas de trace de succès, donc pas fait » → double effet
 *   3. C conclut « UNKNOWN, donc je réessaie »             → double effet
 *
 * La règle absolue : `UNKNOWN` n'est jamais une permission de réessayer. Seule
 * une affirmation POSITIVE d'absence d'effet rouvre l'exécution.
 */
import { execFile } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey, type LabStack } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import { createWorld, externalEffectCount, resetWorld, worldDb } from './world.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/** Lance la sonde suicidaire et attend sa mort. Ne rejette jamais. */
function crash(point: 'AVANT_EFFET' | 'APRES_EFFET', key: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'npx',
      ['tsx', 'tests/lab/probes/crash-worker.ts', point, key],
      { cwd: process.cwd(), env: process.env },
      () => {
        resolve();
      },
    );
  });
}

describe.runIf(enabled)('banc — crash pendant un effet externe', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(20);
    world = worldDb(10);
    await createWorld(world);
  });

  afterAll(async () => {
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  async function stateOf(key: string): Promise<string | undefined> {
    const row = await db.query<{ state: string }>(
      'SELECT state FROM tool_operations WHERE operation_id = $1',
      [key],
    );
    return row.ok ? row.value.rows[0]?.state : undefined;
  }

  /** Monte une pile de reprise, avec ou sans capacité de vérification. */
  function recoveryStack(canVerifyAttempt: boolean): LabStack {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'hostile-reprise',
          behaviour: { kind: 'NORMAL' },
          timing: 'BEFORE_RESPONSE',
          latencyMs: 20,
        }),
        world,
        canVerifyAttempt,
        timeoutMs: 20_000,
      }),
    );
    return stack;
  }

  /* ------------------------------------------------------------------ */

  it('mort APRÈS l\'effet : l\'opération reste EXECUTING, le monde a 1 effet', async () => {
    const key = labKey('crash-apres');
    await crash('APRES_EFFET', key);

    expect(await stateOf(key)).toBe('EXECUTING');
    expect(await externalEffectCount(world, key)).toBe(1);
  }, 60_000);

  it('mort AVANT l\'effet : même état EXECUTING, mais 0 effet', async () => {
    const key = labKey('crash-avant');
    await crash('AVANT_EFFET', key);

    // Le point du sprint : les deux crashs laissent le MÊME état. Jarvis ne
    // peut pas les distinguer sans interroger le monde.
    expect(await stateOf(key)).toBe('EXECUTING');
    expect(await externalEffectCount(world, key)).toBe(0);
  }, 60_000);

  /* ------------------------------------------------------------------ */

  it(
    'reprise CONCURRENTE après un crash post-effet — jamais de second effet',
    async () => {
      const key = labKey('crash-conc');
      await crash('APRES_EFFET', key);
      expect(await externalEffectCount(world, key)).toBe(1);

      // 30 reprises simultanées, sur un outil incapable de vérifier.
      const stack = recoveryStack(false);
      const results = await Promise.all(
        Array.from({ length: 30 }, () => stack.gateway.invoke(labCall(key))),
      );

      // Aucune n'a rejoué.
      expect(await externalEffectCount(world, key)).toBe(1);

      // Toutes disent UNKNOWN, avec la bonne cause.
      const verdicts = results.filter((r) => r.ok).map((r) => r.value);
      expect(verdicts.length).toBeGreaterThan(0);
      for (const verdict of verdicts) {
        expect(verdict.status).toBe('UNKNOWN');
        expect(verdict.verification.unknownReason).toBe('VERIFICATION_UNAVAILABLE');
        expect(verdict.replayed).toBe(true);
      }
    },
    120_000,
  );

  it(
    'reprise avec vérification : effet trouvé → CONFIRMED sans réexécution',
    async () => {
      const key = labKey('crash-verif');
      await crash('APRES_EFFET', key);
      expect(await externalEffectCount(world, key)).toBe(1);

      const stack = recoveryStack(true);
      const resumed = await stack.gateway.invoke(labCall(key));

      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.value.status).toBe('CONFIRMED');
      expect(resumed.value.replayed).toBe(true);
      // CONFIRMÉ sans que le monde ait changé une seconde fois.
      expect(await externalEffectCount(world, key)).toBe(1);
    },
    60_000,
  );

  it(
    'reprise avec vérification : AUCUN effet trouvé → exécution, et une seule',
    async () => {
      const key = labKey('crash-noeffect');
      await crash('AVANT_EFFET', key);
      expect(await externalEffectCount(world, key)).toBe(0);

      // 25 reprises simultanées. Chacune obtiendra `NO_EFFECT` — le seul verdict
      // qui rouvre l'exécution. Si le compare-and-swap ne tenait pas, ce test
      // produirait 25 effets.
      const stack = recoveryStack(true);
      await Promise.all(
        Array.from({ length: 25 }, () => stack.gateway.invoke(labCall(key))),
      );

      expect(await externalEffectCount(world, key)).toBeLessThanOrEqual(1);
    },
    120_000,
  );

  /* ------------------------------------------------------------------ */

  it(
    'un UNKNOWN ne mûrit jamais en succès, quel que soit le nombre de reprises',
    async () => {
      const key = labKey('crash-mature');
      await crash('APRES_EFFET', key);

      const stack = recoveryStack(false);
      for (let round = 0; round < 5; round += 1) {
        const resumed = await stack.gateway.invoke(labCall(key));
        expect(resumed.ok).toBe(true);
        if (resumed.ok) expect(resumed.value.status).toBe('UNKNOWN');
        expect(await externalEffectCount(world, key)).toBe(1);
      }
    },
    120_000,
  );

  it(
    'le compteur de tentatives reste à 1 après un crash suivi de 20 reprises',
    async () => {
      const key = labKey('crash-attempts');
      await crash('APRES_EFFET', key);

      const stack = recoveryStack(false);
      await Promise.all(
        Array.from({ length: 20 }, () => stack.gateway.invoke(labCall(key))),
      );

      const row = await db.query<{ attempts: number }>(
        'SELECT attempts FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;
      expect(row.value.rows[0]?.attempts ?? 0).toBe(1);
    },
    120_000,
  );
});
