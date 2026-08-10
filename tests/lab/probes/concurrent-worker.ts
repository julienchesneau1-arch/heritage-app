/**
 * Sonde — concurrence MULTI-PROCESSUS sur une même clé d'opération.
 *
 * Référence : mandat Foundation 3 §2, ADR-029.
 *
 * POURQUOI UN PROCESSUS ENFANT
 * ----------------------------
 * Le test intra-processus ne prouve pas grand-chose. Une exclusion mutuelle
 * écrite avec un `Map` en mémoire le passerait, et se ferait pulvériser dès
 * qu'un second processus existe — un worker, un cron, l'application mobile et
 * le CLI ouverts en même temps.
 *
 * Seule une sonde qui tourne dans un VRAI processus séparé, avec son propre
 * pool de connexions et sa propre mémoire, établit que le goulot est bien en
 * base et non dans l'espace d'adressage.
 *
 *   npx tsx concurrent-worker.ts <operationKey> <appelsSimultanés> <latenceMs>
 *
 * Écrit sur la sortie standard une ligne JSON :
 *   {"pid":123,"engaged":1,"inFlight":9,"other":0}
 *
 * `engaged` est le nombre d'appels que CE processus a réussi à engager. La
 * somme sur tous les processus doit valoir 1.
 */
import { buildLabStack, labCall, labDb } from '../harness.js';
import { createHostileProvider } from '../hostile-provider.js';
import { createHostileTool } from '../hostile-tool.js';
import { worldDb } from '../world.js';

const [key = 'sonde', rawCount = '10', rawLatency = '25'] = process.argv.slice(2);
const count = Number(rawCount);
const latencyMs = Number(rawLatency);

async function main(): Promise<void> {
  const db = labDb(15);
  const world = worldDb(10);

  const stack = buildLabStack(db);
  stack.register(
    createHostileTool({
      provider: createHostileProvider(world, {
        id: `hostile-pid-${String(process.pid)}`,
        behaviour: { kind: 'NORMAL' },
        timing: 'BEFORE_RESPONSE',
        latencyMs,
      }),
      world,
      timeoutMs: 25_000,
    }),
  );

  const results = await Promise.all(
    Array.from({ length: count }, () => stack.gateway.invoke(labCall(key))),
  );

  /* Quatre issues possibles, et TROIS d'entre elles sont correctes.
     Les distinguer est ce qui rend le test lisible : « le perdant n'exécute
     pas » peut se produire de deux façons légitimes selon l'instant où il
     arrive, et confondre les deux produit un test instable. */
  let engaged = 0; //    a pris l'engagement et lancé l'appel — doit valoir 1
  let inFlight = 0; //   a perdu le compare-and-swap
  let replayed = 0; //   est arrivé après, a relu l'état réel sans agir
  let failed = 0; //     tout le reste — doit valoir 0
  for (const result of results) {
    if (result.ok) {
      if (result.value.replayed) replayed += 1;
      else engaged += 1;
    } else if (result.error.kind === 'OPERATION_IN_FLIGHT') {
      inFlight += 1;
    } else {
      failed += 1;
    }
  }

  process.stdout.write(
    `${JSON.stringify({ pid: process.pid, engaged, inFlight, replayed, failed })}\n`,
  );

  await db.close();
  await world.close();
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `sonde en échec : ${cause instanceof Error ? cause.message : 'inconnu'}\n`,
  );
  process.exit(1);
});
