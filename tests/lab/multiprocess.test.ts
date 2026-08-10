/**
 * CONCURRENCE MULTI-PROCESSUS ET CRASH — Foundation 3.
 *
 * Le test intra-processus (`concurrency.test.ts`) est nécessaire mais faible :
 * une exclusion mutuelle en mémoire le passerait. Ici, chaque appelant est un
 * VRAI processus, avec son pool et sa mémoire à lui. Le seul terrain commun
 * est PostgreSQL — donc le seul goulot possible y est aussi.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { labDb, labKey } from './harness.js';
import { createWorld, effectsFor, externalEffectCount, resetWorld, worldDb } from './world.js';
import type { Db } from '../../src/core/db/client.js';

const run = promisify(execFile);
const enabled = databaseAvailable();

interface WorkerReport {
  pid: number;
  engaged: number;
  inFlight: number;
  replayed: number;
  failed: number;
}

describe.runIf(enabled)('banc — concurrence multi-processus', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(10);
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

  /** Lance `processes` sondes en parallèle, chacune tirant `each` appels. */
  async function stampede(
    key: string,
    processes: number,
    each: number,
    latencyMs = 40,
  ): Promise<readonly WorkerReport[]> {
    const spawned = Array.from({ length: processes }, () =>
      run(
        'npx',
        [
          'tsx',
          'tests/lab/probes/concurrent-worker.ts',
          key,
          String(each),
          String(latencyMs),
        ],
        { cwd: process.cwd(), env: process.env },
      ),
    );

    const outputs = await Promise.all(spawned);
    return outputs.map((out) => JSON.parse(out.stdout.trim()) as WorkerReport);
  }

  it(
    '4 processus × 25 appels sur la même clé — un seul effet dans le monde',
    async () => {
      const key = labKey('mp');
      const reports = await stampede(key, 4, 25);

      // Les quatre processus ont bien tourné.
      expect(reports.length).toBe(4);
      expect(new Set(reports.map((r) => r.pid)).size).toBe(4);

      const effects = await externalEffectCount(world, key);
      if (effects > 1) {
        const detail = await effectsFor(world, key);
        throw new Error(
          `VIOLATION multi-processus : ${String(effects)} effets.\n` +
            detail.map((e) => `  ${e.providerId}`).join('\n'),
        );
      }
      expect(effects).toBeLessThanOrEqual(1);

      // Exactement un appel, TOUS PROCESSUS CONFONDUS, a pris l'engagement.
      const engaged = reports.reduce((sum, r) => sum + r.engaged, 0);
      expect(engaged).toBe(1);
    },
    120_000,
  );

  it(
    'aucun perdant ne tombe en erreur : tous refusent proprement',
    async () => {
      const key = labKey('mp-loser');
      const total = 3 * 10;
      const reports = await stampede(key, 3, 10);

      const sum = (pick: (r: WorkerReport) => number): number =>
        reports.reduce((acc, r) => acc + pick(r), 0);

      expect(sum((r) => r.engaged)).toBe(1);

      /* Un perdant peut perdre de DEUX façons, toutes deux correctes, et
         laquelle survient dépend de l'instant où il arrive :

           avant que le gagnant n'atteigne EXECUTING   → il perd le
                                                          compare-and-swap
           après                                       → il lit l'état réel et
                                                          ne rejoue pas

         Exiger l'une des deux rendrait le test instable sans rien prouver de
         plus. Ce qui compte est qu'AUCUN ne tombe dans une quatrième
         catégorie — une erreur inattendue serait le vrai signal. */
      expect(sum((r) => r.failed)).toBe(0);
      expect(sum((r) => r.engaged) + sum((r) => r.inFlight) + sum((r) => r.replayed)).toBe(
        total,
      );

      expect(await externalEffectCount(world, key)).toBeLessThanOrEqual(1);
    },
    120_000,
  );

  it(
    'le journal ne compte jamais plus d\'une tentative, tous processus confondus',
    async () => {
      const key = labKey('mp-attempts');
      await stampede(key, 4, 20);

      const row = await db.query<{ attempts: number; state: string }>(
        'SELECT attempts, state FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;

      expect(row.value.rows[0]?.attempts ?? 0).toBeLessThanOrEqual(1);
    },
    120_000,
  );
});
