/**
 * Sonde — mort du processus PENDANT un appel à effet externe.
 *
 * Référence : mandat Foundation 3 §3, ADR-027, ADR-029.
 *
 * La sonde de `tests/redteam/probes/crash-probe.ts` tue le processus autour
 * d'un effet TRANSACTIONNEL (une insertion PostgreSQL). Celle-ci le tue autour
 * d'un effet réellement EXTERNE — une écriture dans le monde du banc, que
 * personne ne peut annuler. C'est la seule qui reproduise le double virement.
 *
 *   npx tsx crash-worker.ts <point> <operationKey>
 *
 * Points :
 *   AVANT_EFFET   le processus meurt avant que le monde change  → 0 effet
 *   APRES_EFFET   le processus meurt juste après                → 1 effet
 *
 * Dans les deux cas l'opération reste en `EXECUTING` : de l'extérieur, Jarvis
 * ne peut PAS les distinguer. C'est tout le problème, et c'est pourquoi la
 * reprise doit chercher à SAVOIR plutôt que supposer.
 *
 * Le crochet de panne est ici, côté test. `src/` n'en contient aucun — un
 * interrupteur de plantage en production finirait par être actionné.
 */
import { buildLabStack, labCall, labDb } from '../harness.js';
import { createHostileTool } from '../hostile-tool.js';
import { commitEffect, worldDb } from '../world.js';
import type { HostileProvider, ProviderReceipt } from '../hostile-provider.js';
import { ok, type Result } from '../../../src/core/types/result.js';
import type { Db } from '../../../src/core/db/client.js';

const [point = 'APRES_EFFET', key = 'sonde'] = process.argv.slice(2);

/** Meurt sans rien pouvoir écrire — pas de `finally`, pas de fermeture propre. */
function die(): never {
  process.kill(process.pid, 'SIGKILL');
  // Inatteignable ; présent pour le typage.
  throw new Error('inatteignable');
}

/**
 * Fournisseur qui meurt à un instant choisi PAR RAPPORT À L'EFFET.
 *
 * C'est la seule chose qui compte : « mourir pendant l'appel » ne dit rien
 * tant qu'on ne précise pas de quel côté de l'effet.
 */
function createSuicidalProvider(world: Db): HostileProvider {
  return {
    id: 'hostile-suicidaire',
    callCount: () => 1,
    reconfigure: () => undefined,
    async send(operationKey: string, payload: string): Promise<Result<ProviderReceipt>> {
      if (point === 'AVANT_EFFET') die();

      await commitEffect(world, {
        operationKey,
        providerId: 'hostile-suicidaire',
        payload,
      });

      if (point === 'APRES_EFFET') die();

      return ok({
        providerId: 'hostile-suicidaire',
        reference: `hostile-suicidaire:${operationKey}`,
        claims: 'ACCEPTED',
      });
    },
  };
}

async function main(): Promise<void> {
  const db = labDb(5);
  const world = worldDb(5);

  const stack = buildLabStack(db);
  stack.register(
    createHostileTool({
      provider: createSuicidalProvider(world),
      world,
      timeoutMs: 20_000,
    }),
  );

  await stack.gateway.invoke(labCall(key));

  // Ne devrait jamais être atteint : la sonde est censée mourir.
  process.stdout.write('SURVECU\n');
  await db.close();
  await world.close();
}

main().catch(() => {
  process.exit(1);
});
