/**
 * Idempotence — 05/B6.
 *
 * Porte de sortie Phase 2 : « Une commande répétée pour cause d'erreur réseau
 * ne crée pas de doublon. »
 *
 * Le rejeu ne réexécute rien : il RELIT l'état réel. C'est le choix de
 * conception acté en migration 0004 — mémoriser l'identifiant de la ressource
 * plutôt que le résultat évite de dupliquer des données, et interdit à un rejeu
 * d'affirmer un succès que le monde ne confirme plus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';

const skip = !databaseAvailable();

const TRUSTED = {
  content: 'USER',
  privacyClass: 'SYSTEM',
  title: 'USER',
  dueAt: 'USER',
} as const;

describe.skipIf(skip)('idempotence', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('une commande rejouée ne crée pas de doublon', async () => {
    const op = operationId('idem');
    const input = { title: 'Acheter du terreau', dueAt: null };

    const first = await stack.gateway.invoke({
      toolId: 'task_create',
      input,
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    // Erreur réseau côté appelant : la même commande repart.
    const second = await stack.gateway.invoke({
      toolId: 'task_create',
      input,
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);

    const count = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tasks WHERE title = $1',
      [input.title],
    );
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value.rows[0]?.n).toBe('1');
  });

  it('un rejeu relit l\'état réel plutôt que de rejouer un résultat mémorisé', async () => {
    const op = operationId('idem-verify');
    await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note rejouée' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const replay = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note rejouée' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    // La relecture a bien eu lieu : le statut vient du monde, pas d'un cache.
    expect(replay.value.status).toBe('CONFIRMED');
    expect(replay.value.verification.detail).toContain('État réel vérifié');
  });

  it('un rejeu dont la ressource a disparu ne prétend pas au succès', async () => {
    const op = operationId('idem-gone');
    const created = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note qui va disparaître' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });
    expect(created.ok).toBe(true);

    // Quelqu'un supprime la note en dehors de Jarvis.
    const removed = await db.query(
      'DELETE FROM notes WHERE operation_id = $1',
      [op],
    );
    expect(removed.ok).toBe(true);

    const replay = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note qui va disparaître' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // C'est tout l'intérêt de relire plutôt que de mémoriser le résultat :
    // un rejeu ne peut pas affirmer un succès que le monde ne confirme plus.
    expect(replay.value.status).toBe('FAILED');
  });

  it('la même clé avec des arguments différents est refusée', async () => {
    const op = operationId('idem-conflict');

    const first = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Contenu initial' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });
    expect(first.ok).toBe(true);

    const conflicting = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Contenu tout à fait différent' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    // Ce n'est pas un rejeu, c'est un défaut d'appelant. Exécuter serait pire
    // que refuser.
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error.kind).toBe('CONFLICT');
  });

  it('deux opérations distinctes créent bien deux ressources', async () => {
    const input = { content: 'Note dupliquée volontairement' };

    await stack.gateway.invoke({
      toolId: 'note_create',
      input,
      parameterProvenance: TRUSTED,
      operationId: operationId('distinct-a'),
      actor: 'USER',
      context: callContext(),
    });
    await stack.gateway.invoke({
      toolId: 'note_create',
      input,
      parameterProvenance: TRUSTED,
      operationId: operationId('distinct-b'),
      actor: 'USER',
      context: callContext(),
    });

    const count = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM notes WHERE content = $1',
      [input.content],
    );
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value.rows[0]?.n).toBe('2');
  });
});
