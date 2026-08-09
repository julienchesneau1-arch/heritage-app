/**
 * De la phrase française à l'action vérifiée.
 *
 * Référence : 02 Étape C, critères de succès V1 (`00 §7`).
 *
 * Ces tests couvrent la **couture** entre l'Intent Engine et le Tool Gateway —
 * l'endroit où deux défauts sont apparus au premier usage réel, invisibles pour
 * les tests unitaires de chaque côté :
 *
 *   — « Retiens que X » était stocké en HYPOTHESIS au lieu de FACT, parce que
 *     l'ordre explicite de mémorisation n'était pas transmis comme
 *     confirmation ;
 *   — les lectures étaient journalisées avec un suffixe `_NO_UNDO`, polluant
 *     l'audit d'une alerte sans objet.
 *
 * D'où ce fichier : chaque défaut trouvé en usage devient un scénario doré.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, type Stack } from '../helpers/stack.js';

const skip = !databaseAvailable();
const intent = createIntentEngine();

/**
 * Marqueur unique par exécution.
 *
 * Sans lui, ce fichier échouait ou passait SELON L'ORDRE des fichiers de test :
 * `guard.test.ts` mémorise « La chaudière a été révisée en mars 2026 », et la
 * déduplication du Memory Guard renvoyait alors DEDUPLICATED au lieu de STORED.
 *
 * Un test dont le résultat dépend de l'ordre d'exécution est pire que pas de
 * test : il donne une confiance qu'il ne mérite pas.
 */
const TAG = `flux-${String(Date.now())}`;

describe.skipIf(skip)('phrase française → action vérifiée', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Rejoue exactement ce que fait la boucle du CLI. */
  async function say(text: string) {
    const proposal = intent.propose(text);
    if (proposal.kind !== 'TOOL_CALL') {
      throw new Error(`« ${text} » n'a pas produit d'appel d'outil`);
    }
    stack.setUserConfirmed(proposal.userConfirms);
    const result = await stack.gateway.invoke({
      toolId: proposal.toolId,
      input: proposal.input,
      parameterProvenance: proposal.parameterProvenance,
      operationId: randomUUID(),
      actor: 'USER',
      context: {
        mode: 'NORMAL',
        cloudEnabled: false,
        proactive: false,
        userConfirmed: false,
      },
    });
    stack.setUserConfirmed(false);
    return { proposal, result };
  }

  it('« Ajoute du café à ma liste » crée une tâche vérifiée', async () => {
    const { result } = await say(`Ajoute du café ${TAG} à ma liste`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');

    const found = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tasks WHERE title = $1',
      [`du café ${TAG}`],
    );
    if (found.ok) expect(found.value.rows[0]?.n).toBe('1');
  });

  it('« Retiens que X » produit un FACT, pas une hypothèse', async () => {
    // Régression : l'ordre explicite de mémorisation vaut confirmation.
    // Sans cela, le Guard rétrogradait l'origine et plafonnait la confiance.
    const { result } = await say(
      `Retiens que la chaudière a été révisée en mars 2026 (${TAG})`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.value.output as { kind?: unknown; outcome?: unknown };
    expect(output.outcome).toBe('STORED');
    expect(output.kind).toBe('FACT');
  });

  it('une lecture n\'est pas journalisée comme mutation sans annulation', async () => {
    // Régression : le suffixe `_NO_UNDO` s'appliquait à toute absence de
    // capture, y compris quand il n'y avait rien à annuler.
    const { result } = await say('Mes tâches');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await stack.ledger.recent(20);
    expect(events.ok).toBe(true);
    if (!events.ok) return;

    const listed = events.value.find((e) => e.eventType.startsWith('TASK_LISTED'));
    expect(listed?.eventType).toBe('TASK_LISTED');
    expect(listed?.eventType).not.toContain('_NO_UNDO');
  });

  it('une mutation reste journalisée avec sa capture d\'annulation', async () => {
    const { result } = await say(`Note que le portail grince ${TAG}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await stack.ledger.recent(20);
    if (!events.ok) return;
    const created = events.value.find((e) => e.eventType.startsWith('NOTE_CREATED'));
    expect(created?.eventType).toBe('NOTE_CREATED');
  });

  it('« Que sais-tu sur X » retrouve ce qui a été mémorisé', async () => {
    await say(`Retiens que le carrelage est un Marazzi Treverk ${TAG}`);
    const { result } = await say(`Que sais-tu sur Marazzi ${TAG}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output as {
      results?: { content?: unknown }[];
      degraded?: unknown;
    };
    expect(output.results?.length).toBeGreaterThan(0);
    expect(String(output.results?.[0]?.content)).toContain('Marazzi');
    // La dégradation est remontée, jamais masquée.
    expect(output.degraded).toBe(true);
  });

  it('la chaîne d\'audit reste intacte après une session complète', async () => {
    const chain = await stack.ledger.verifyChain();
    expect(chain.ok).toBe(true);
    if (chain.ok) expect(chain.value.valid).toBe(true);
  });
});
