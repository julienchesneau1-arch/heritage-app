/**
 * CONCURRENCE SUR UNE MÊME CLÉ D'OPÉRATION — Foundation 3.
 *
 * `docs/17 §6` nommait ce manque comme « le plus probable prochain endroit où
 * une faille se cache ». Ce fichier va chercher la faille.
 *
 * LA QUESTION
 * -----------
 * Le journal d'intention protège contre le TEMPS : un crash, un redémarrage,
 * un rejeu plus tard. Protège-t-il contre l'ESPACE — deux appels au même
 * instant ?
 *
 *              même operation_key
 *                     │
 *            ┌────────┴────────┐
 *            ▼                 ▼
 *        Requête A         Requête B
 *            │                 │
 *      SELECT (rien)     SELECT (rien)
 *            │                 │
 *            └────────┬────────┘
 *                     ▼
 *              DEUX EXÉCUTIONS ?
 *
 * La mesure est la seule qui compte : `external_effect_count`.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey, type LabStack } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import {
  createWorld,
  effectsFor,
  externalEffectCount,
  resetWorld,
  worldDb,
} from './world.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

describe.runIf(enabled)('banc — concurrence sur une même clé', () => {
  let db: Db;
  let world: Db;
  let stack: LabStack;

  beforeAll(async () => {
    db = labDb(40);
    world = worldDb(20);
    await createWorld(world);

    stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'hostile-A',
          behaviour: { kind: 'NORMAL' },
          timing: 'BEFORE_RESPONSE',
          // Une latence non nulle est indispensable : sans elle, l'exécution
          // est si brève que la fenêtre de course ne s'ouvre jamais et le test
          // passerait pour de mauvaises raisons.
          latencyMs: 25,
        }),
        world,
        timeoutMs: 25_000,
      }),
    );
  });

  afterAll(async () => {
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  /**
   * Lance N appels RÉELLEMENT simultanés sur la même clé et rend le nombre
   * d'effets produits dans le monde.
   */
  async function stampede(n: number): Promise<{
    key: string;
    effects: number;
    succeeded: number;
    failed: number;
  }> {
    const key = labKey('conc');
    const calls = Array.from({ length: n }, () => stack.gateway.invoke(labCall(key)));
    const results = await Promise.all(calls);

    return {
      key,
      effects: await externalEffectCount(world, key),
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  }

  it('2 appels simultanés — external_effect_count ≤ 1', async () => {
    const run = await stampede(2);
    if (run.effects > 1) {
      // Diagnostic exploitable plutôt qu'un simple « attendu 1, reçu 2 ».
      const detail = await effectsFor(world, run.key);
      throw new Error(
        `VIOLATION : ${String(run.effects)} effets pour une clé unique.\n` +
          detail.map((e, i) => `  ${String(i + 1)}. ${e.payload}`).join('\n'),
      );
    }
    expect(run.effects).toBeLessThanOrEqual(1);
  });

  it('10 appels simultanés — external_effect_count ≤ 1', async () => {
    const run = await stampede(10);
    expect(run.effects).toBeLessThanOrEqual(1);
  });

  it('100 appels simultanés — external_effect_count ≤ 1', async () => {
    const run = await stampede(100);
    expect(run.effects).toBeLessThanOrEqual(1);
  });

  it('1 000 appels simultanés — external_effect_count ≤ 1', async () => {
    const run = await stampede(1_000);
    expect(run.effects).toBeLessThanOrEqual(1);
  }, 120_000);

  /**
   * Le cas qui inquiète le plus.
   *
   * Une opération laissée en `PLANNED` — parce qu'un processus est mort entre
   * l'inscription de l'intention et la barrière de durabilité — est reprise
   * par DEUX processus en même temps. Chacun lit `PLANNED`, chacun conclut
   * « aucun appel n'a été lancé », chacun exécute.
   */
  it('reprise concurrente depuis PLANNED — external_effect_count ≤ 1', async () => {
    const key = labKey('planned');

    // On met la table dans l'état qu'un crash aurait laissé : intention
    // inscrite, aucun appel parti.
    const seeded = await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor, attempts)
       VALUES ($1, 'lab_external_send', '1.0.0', 'PLANNED', $2, 'USER', 0)`,
      [key, digestOfDefaultPayload()],
    );
    expect(seeded.ok).toBe(true);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => stack.gateway.invoke(labCall(key))),
    );
    expect(results.length).toBe(20);

    const effects = await externalEffectCount(world, key);
    if (effects > 1) {
      const detail = await effectsFor(world, key);
      throw new Error(
        `VIOLATION depuis PLANNED : ${String(effects)} effets.\n` +
          detail.map((e, i) => `  ${String(i + 1)}. ${e.providerId}`).join('\n'),
      );
    }
    expect(effects).toBeLessThanOrEqual(1);
  });

  /**
   * `attempts` est le témoin interne : le journal compte lui-même le nombre
   * d'exécutions lancées. S'il dépasse 1, le journal d'intention a été
   * contourné — même si le monde s'en est tiré par chance.
   */
  it('le compteur attempts du journal ne dépasse jamais 1', async () => {
    const run = await stampede(50);

    const row = await db.query<{ attempts: number; state: string }>(
      'SELECT attempts, state FROM tool_operations WHERE operation_id = $1',
      [run.key],
    );
    expect(row.ok).toBe(true);
    if (!row.ok) return;

    const operation = row.value.rows[0];
    expect(operation).toBeDefined();
    expect(operation?.attempts ?? 0).toBeLessThanOrEqual(1);
  });
});

/** Empreinte de la charge utile par défaut de `labCall`, pour amorcer une ligne. */
function digestOfDefaultPayload(): string {
  // Doit correspondre à `inputDigest` du Gateway : sha256 du JSON de l'entrée
  // validée. `payload` est le seul champ du schéma.
  return createHash('sha256')
    .update(JSON.stringify({ payload: 'charge utile' }))
    .digest('hex');
}
