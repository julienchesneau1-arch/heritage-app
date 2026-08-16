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

  /**
   * Attend l'expiration du bail d'exécution (ADR-032).
   *
   * CE QUE CETTE ATTENTE RÉVÈLE, et qu'il faut assumer : depuis Foundation 4,
   * une reprise après crash n'est plus immédiate. Elle est bornée par le
   * `timeoutMs` de l'outil plus la marge — parce qu'AUCUN moyen ne permet de
   * distinguer « mort il y a une seconde » de « encore en train de tourner »
   * sans battement de cœur.
   *
   * C'est un échange délibéré : on paie une latence de reprise pour ne jamais
   * doubler un effet.
   */
  async function waitForLease(key: string): Promise<void> {
    /* ON N'ESTIME PLUS L'ÉCHÉANCE, ON LA LIT — même leçon qu'ADR-036.

       Cette attente valait `toolTimeoutMs + 5 200`, c'est-à-dire une échéance
       RECONSTITUÉE par l'observateur à partir du délai qu'il croyait
       applicable. Elle était fausse, et les tests passaient quand même : la
       sonde de crash prenait son bail avec 20 000 ms, le repreneur recalculait
       avec 300 ms, et tout le monde tombait d'accord sur une échéance que
       personne n'avait fixée.

       La base connaît l'échéance. On la lui demande. */
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const row = await db.query<{ expire: boolean }>(
        `SELECT COALESCE(lease_expires_at, 'infinity'::timestamptz) <= now() AS expire
           FROM tool_operations WHERE operation_id = $1`,
        [key],
      );
      if (row.ok && row.value.rows[0]?.expire === true) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`le bail de ${key} n'a jamais expiré`);
  }

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
        // Court À DESSEIN : le bail vaut `timeoutMs + marge`, et ces tests
        // portent sur la reprise, pas sur son délai. Le délai lui-même est
        // vérifié par le test « le bail refuse une reprise prématurée ».
        timeoutMs: 300,
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
      await waitForLease(key);

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
      await waitForLease(key);

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
      await waitForLease(key);

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
      await waitForLease(key);

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
    'le bail REFUSE une reprise prématurée, et le dit honnêtement',
    async () => {
      /* La contrepartie assumée d'ADR-032. Juste après un crash, Jarvis ne
         peut PAS savoir que le processus est mort : de l'extérieur, « mort il
         y a une seconde » et « encore en train de tourner » sont identiques.

         Il refuse donc de reprendre, et le formule sans mentir : « je n'ai
         rien tenté ». C'est une latence de reprise échangée contre la
         certitude de ne jamais doubler un effet. */
      const key = labKey('crash-bail');
      await crash('APRES_EFFET', key);
      expect(await stateOf(key)).toBe('EXECUTING');

      // Reprise IMMÉDIATE, bail encore vivant.
      const stack = recoveryStack(true);
      const premature = await stack.gateway.invoke(labCall(key));

      expect(premature.ok).toBe(false);
      if (premature.ok) return;
      expect(premature.error.kind).toBe('OPERATION_IN_FLIGHT');
      expect(premature.error.message).toContain("rien tenté");

      // Et surtout : aucun effet supplémentaire n'a été produit.
      expect(await externalEffectCount(world, key)).toBe(1);

      // Une fois le bail expiré, la reprise redevient possible.
      await waitForLease(key);
      const resumed = await stack.gateway.invoke(labCall(key));
      expect(resumed.ok).toBe(true);
      if (resumed.ok) expect(resumed.value.status).toBe('CONFIRMED');
      expect(await externalEffectCount(world, key)).toBe(1);
    },
    60_000,
  );

  it(
    'RÉGRESSION F4 — un exécutant VIVANT n\'est jamais pris pour un mort',
    async () => {
      /* Contre-exemple minimal trouvé par le chaos runner (`docs/20 §2`).
         Trois appels simultanés suffisaient à produire deux effets :

           A gagne le CAS et part exécuter (60 ms)
           B lit EXECUTING, interroge le monde — encore VIDE
           B conclut NO_EFFECT, rembobine, exécute

         Le compteur `attempts` ne départageait pas les deux cas : un exécutant
         vivant porte la même valeur qu'un mort. Seul le TEMPS les distingue —
         d'où le bail (ADR-032). */
      const stack = buildLabStack(db);
      stack.register(
        createHostileTool({
          provider: createHostileProvider(world, {
            id: 'hostile-vivant',
            behaviour: { kind: 'NORMAL' },
            timing: 'BEFORE_RESPONSE',
            // Assez long pour que les concurrents arrivent pendant l'appel.
            latencyMs: 60,
          }),
          world,
          // La vérification de tentative est CE QUI REND le défaut possible :
          // sans elle, la reprise reste en UNKNOWN et ne rejoue jamais.
          canVerifyAttempt: true,
          timeoutMs: 5_000,
        }),
      );

      const key = labKey('vivant');
      await Promise.all(
        Array.from({ length: 5 }, () => stack.gateway.invoke(labCall(key))),
      );

      expect(await externalEffectCount(world, key)).toBe(1);

      const row = await db.query<{ attempts: number }>(
        'SELECT attempts FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;
      expect(row.value.rows[0]?.attempts ?? 0).toBe(1);
    },
    60_000,
  );

  it(
    'le compteur de tentatives reste à 1 après un crash suivi de 20 reprises',
    async () => {
      const key = labKey('crash-attempts');
      await crash('APRES_EFFET', key);
      await waitForLease(key);

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
