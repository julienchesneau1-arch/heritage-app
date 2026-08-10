/**
 * LE BAIL NE MESURE PAS LA VIE — épreuve adversariale, Foundation 4.1.
 *
 * ADR-032 affirmait : « ce qui distingue un exécutant mort d'un vivant est le
 * temps ». Cette épreuve existe pour montrer que cette phrase est FAUSSE, et
 * pour mesurer ce qu'elle laisse passer.
 *
 * CE QU'UN BAIL MESURE RÉELLEMENT
 * -------------------------------
 * Pas la vie d'un processus. Seulement :
 *
 *     depuis combien de temps personne n'a renouvelé le bail.
 *
 * Ce n'est pas la même chose, et l'écart entre les deux est exactement l'espace
 * où un double effet peut naître :
 *
 *   T0      A prend le bail, envoie la requête au fournisseur
 *   T0+800  A gèle (pause système, GC, VM suspendue, réseau bloqué)
 *   T0+5200 le bail expire — A est toujours VIVANT
 *   T0+5300 B reprend, interroge le fournisseur : rien
 *   T0+5400 B exécute            → EFFET B
 *   T0+6000 la requête de A aboutit enfin → EFFET A
 *                                  ═══════════════
 *                                    DEUX EFFETS
 *
 * CINQ NOTIONS À NE JAMAIS CONFONDRE
 * ----------------------------------
 *   PROCESS LIVENESS               le processus tourne-t-il encore ?
 *   LEASE EXPIRATION               le bail a-t-il été renouvelé ?
 *   REQUEST CANCELLATION           le fournisseur a-t-il cessé de traiter ?
 *   EXTERNAL EFFECT                le monde a-t-il changé ?
 *   EXTERNAL EFFECT VERIFICATION   peut-on le CONSTATER, maintenant ?
 *
 * `withTimeout()` côté Jarvis n'établit AUCUNE des quatre dernières. Il rend la
 * main, c'est tout. Le fournisseur, lui, continue.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import {
  commitEffect,
  createWorld,
  effectsFor,
  externalEffectCount,
  resetWorld,
  worldDb,
} from './world.js';
import type { Db } from '../../src/core/db/client.js';
import type { EffectContract } from '../../src/core/types/domain.js';
import type { OperationIdentity } from '../../src/core/tools/identity.js';

const enabled = databaseAvailable();

/**
 * `timeoutMs` des outils de cette épreuve.
 *
 * Le bail vaut `TOOL_TIMEOUT_MS + 5 000 ms`, mais aucun test ici ne l'attend :
 * les opérations sont mises en scène avec un `executing_at` vieux d'une heure.
 * C'est délibéré — l'épreuve porte sur ce que le bail ne prouve PAS, et
 * l'attendre réellement ne ferait que ralentir sans rien démontrer de plus.
 */
const TOOL_TIMEOUT_MS = 200;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PAYLOAD_DIGEST = createHash('sha256')
  .update(JSON.stringify({ payload: 'charge utile' }))
  .digest('hex');

describe.runIf(enabled)('banc — le bail face à un exécutant vivant', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(20);
    world = worldDb(15);
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
   * Met en scène l'état exact du contre-exemple :
   *
   *   A a envoyé sa requête, puis a gelé ou est mort  → `EXECUTING` ancien
   *   SA REQUÊTE VIT ENCORE et aboutira dans `landsInMs`
   *   le bail est déjà expiré
   *   le monde est encore VIDE au moment où B regarde
   *
   * C'est la situation qu'aucune observation ne peut détecter : il n'y a rien
   * à voir, et pourtant quelque chose va arriver.
   */
  async function stageInFlightRequest(
    key: OperationIdentity,
    landsInMs: number,
    providerIsIdempotent = false,
  ): Promise<void> {
    const seeded = await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor,
          attempts, committed_at, executing_at, lease_expires_at)
       VALUES ($1,'lab_external_send','1.0.0','EXECUTING',$2,'USER',1,
               clock_timestamp() - interval '1 hour',
               clock_timestamp() - interval '1 hour',
               -- Bail DÉJÀ EXPIRÉ : on met en scène un exécutant dont
               -- l'autorité est morte, pas un exécutant courant.
               clock_timestamp() - interval '59 minutes')`,
      [key, PAYLOAD_DIGEST],
    );
    if (!seeded.ok) throw new Error(seeded.error.message);

    setTimeout(() => {
      void (async () => {
        /* La requête de A frappe LE MÊME fournisseur que celle de B. Si ce
           fournisseur dédoublonne, il dédoublonne pour les deux — sinon la
           mise en scène serait infidèle et le test mesurerait un fournisseur
           imaginaire. */
        if (providerIsIdempotent) {
          const existing = await world.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM lab_world_effects
              WHERE operation_key = $1 AND target = '-'`,
            [key],
          );
          if (existing.ok && Number(existing.value.rows[0]?.n ?? '0') > 0) return;
        }
        await commitEffect(world, {
          operationKey: key,
          providerId: 'requete-de-A',
          payload: 'effet tardif de la requête de A',
        });
      })().catch(() => undefined);
    }, landsInMs);
  }

  /** Pile de reprise, avec le contrat d'effet à éprouver. */
  function recoveryStack(contract: EffectContract, reallyIdempotent = false) {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'requete-de-B',
          behaviour: { kind: 'NORMAL' },
          timing: 'BEFORE_RESPONSE',
          reallyIdempotent,
        }),
        world,
        canVerifyAttempt: true,
        timeoutMs: TOOL_TIMEOUT_MS,
        effectContract: contract,
      }),
    );
    return stack;
  }

  /* ================================================================== *
   * LE CONTRE-EXEMPLE CENTRAL
   * ================================================================== */

  it(
    'requête EN VOL + bail expiré : aucune reprise ne doit exécuter',
    async () => {
      const key = labKey('vol-central');
      await stageInFlightRequest(key, 1_200);

      // Le monde est vide : `verifyAttempt` ne peut QUE répondre « rien ».
      expect(await externalEffectCount(world, key)).toBe(0);

      const result = await recoveryStack('EXTERNALLY_VERIFIABLE').gateway.invoke(
        labCall(key),
      );

      // La seule réponse défendable.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('UNKNOWN');

      // La requête de A aboutit ensuite.
      await sleep(1_800);
      const effects = await effectsFor(world, key);
      expect(effects.length).toBe(1);
      expect(effects[0]?.providerId).toBe('requete-de-A');
    },
    60_000,
  );

  it(
    'dix reprises simultanées sur une requête en vol — toujours un seul effet',
    async () => {
      const key = labKey('vol-concurrent');
      await stageInFlightRequest(key, 1_200);

      const stack = recoveryStack('EXTERNALLY_VERIFIABLE');
      await Promise.all(
        Array.from({ length: 10 }, () => stack.gateway.invoke(labCall(key))),
      );

      await sleep(1_800);
      expect(await externalEffectCount(world, key)).toBe(1);
    },
    60_000,
  );

  it(
    'un outil UNVERIFIABLE ne rejoue JAMAIS, quelle que soit la durée écoulée',
    async () => {
      const key = labKey('vol-unverifiable');
      await stageInFlightRequest(key, 1_000);

      /* Cinq reprises espacées sur deux secondes.

         ⚠ La propriété à tester n'est PAS « le statut reste UNKNOWN ». Une
         fois que l'effet de A a réellement abouti, le CONSTATER et dire
         `CONFIRMED` est parfaitement honnête — c'est même le but.

         Ce qui doit rester vrai est plus étroit et plus important : aucune de
         ces reprises ne doit EXÉCUTER. Le temps ne transforme jamais une
         ignorance en permission (ADR-033). */
      const stack = recoveryStack('UNVERIFIABLE');
      const statuses: string[] = [];
      for (let round = 0; round < 5; round += 1) {
        const r = await stack.gateway.invoke(labCall(key));
        if (r.ok) statuses.push(r.value.status);
        await sleep(400);
      }

      // Avant que l'effet de A n'aboutisse : ignorance assumée.
      expect(statuses[0]).toBe('UNKNOWN');
      // Après : on constate, sans avoir rien réexécuté.
      expect(await externalEffectCount(world, key)).toBe(1);

      const row = await db.query<{ attempts: number }>(
        'SELECT attempts FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (row.ok) expect(row.value.rows[0]?.attempts ?? 0).toBe(1);
    },
    60_000,
  );

  /* ================================================================== *
   * LE SEUL CHEMIN DE REJEU EXTERNE AUTORISÉ
   * ================================================================== */

  it(
    'PROVIDER_IDEMPOTENT : le rejeu est autorisé, et reste sans doublon',
    async () => {
      const key = labKey('vol-idempotent');
      await stageInFlightRequest(key, 1_200, true);

      // Le fournisseur dédoublonne RÉELLEMENT sur la clé d'opération.
      const stack = recoveryStack('PROVIDER_IDEMPOTENT', true);
      const result = await stack.gateway.invoke(labCall(key));

      // Le rejeu a bien eu lieu — c'est le seul contrat qui l'autorise.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.replayed).toBe(false);
      expect(await externalEffectCount(world, key)).toBe(1);

      // Et la requête de A, en aboutissant, ne crée pas de second effet :
      // c'est le FOURNISSEUR qui l'empêche, pas notre observation.
      await sleep(1_800);
      expect(await externalEffectCount(world, key)).toBe(1);
    },
    60_000,
  );

  /* ================================================================== *
   * RISQUE RÉSIDUEL — un fournisseur qui MENT sur son idempotence
   * ================================================================== */

  it(
    'RISQUE RÉSIDUEL : un fournisseur qui prétend dédoublonner sans le faire',
    async () => {
      /* La garantie d'ADR-033 vient d'un TIERS. Nous ne pouvons que le croire.
         Ce test mesure le prix exact de cette confiance, plutôt que de le
         passer sous silence : le double effet réapparaît, et rien dans Jarvis
         ne peut l'empêcher.

         C'est la frontière du système, et elle est ici NOMMÉE. */
      const key = labKey('vol-menteur');
      await stageInFlightRequest(key, 1_000);

      // Déclare PROVIDER_IDEMPOTENT, mais le fournisseur ne dédoublonne pas.
      const stack = recoveryStack('PROVIDER_IDEMPOTENT', false);
      await stack.gateway.invoke(labCall(key));
      await sleep(1_600);

      const effects = await effectsFor(world, key);
      expect(effects.length).toBe(2);
      expect(effects.map((e) => e.providerId).sort()).toEqual([
        'requete-de-A',
        'requete-de-B',
      ]);
    },
    60_000,
  );

  /* ================================================================== *
   * TÉMOIN — la mise en scène produit-elle vraiment un effet tardif ?
   * ================================================================== */

  it('la mise en scène produit RÉELLEMENT un effet après coup', async () => {
    // Sans ce témoin, les tests ci-dessus pourraient passer parce que rien
    // n'arrive jamais — et ne prouveraient rien du tout.
    const key = labKey('vol-temoin');
    await stageInFlightRequest(key, 300);
    expect(await externalEffectCount(world, key)).toBe(0);
    await sleep(900);
    expect(await externalEffectCount(world, key)).toBe(1);
  }, 30_000);
});
