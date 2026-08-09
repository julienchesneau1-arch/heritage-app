/**
 * Registre des dérivés — « oublie ça » doit pouvoir tout supprimer.
 *
 * Référence : 09 §2.1, proposition n°11, 03 §12.
 *
 * Ce que ces tests protègent : un dérivé créé sans être enregistré est un
 * dérivé qu'on ne saura pas retrouver. Aujourd'hui l'embedding disparaît en
 * cascade ; ce ne sera plus vrai au premier index externe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDerivativeRegistry,
  type DerivativeRegistry,
} from '../../src/core/memory/derivatives.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import { createMemoryStore, type MemoryStore } from '../../src/core/memory/store.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { embedDeterministic } from '../helpers/fake-embeddings.js';

const skip = !databaseAvailable();

describe.skipIf(skip)('registre des dérivés', () => {
  let db: Db;
  let store: MemoryStore;
  let registry: DerivativeRegistry;
  let memoryId: string;

  beforeAll(async () => {
    db = appDb();
    store = createMemoryStore(db);
    registry = createDerivativeRegistry(db);

    const guard = createMemoryGuard(store, createMemoryInbox(db));
    const stored = await guard.propose(
      {
        memoryType: 'SEMANTIC',
        content: 'Le portail se ferme avec la télécommande grise',
        sourceType: 'USER_EXPLICIT',
        source: 'conversation',
        dataCategory: 'PERSONAL_MEMORY',
        suggestedConfidence: 0.9,
      },
      { userConfirmed: true },
    );
    if (!stored.ok || stored.value.outcome !== 'STORED') {
      throw new Error('mémoire de test non créée');
    }
    memoryId = stored.value.memory.id;
  });

  afterAll(async () => {
    await db.close();
  });

  it('attacher un embedding l\'enregistre comme dérivé', async () => {
    const attached = await store.attachEmbedding(
      memoryId,
      embedDeterministic('portail télécommande grise'),
      'fake-bow-768',
    );
    expect(attached.ok).toBe(true);

    const derivatives = await registry.listFor(memoryId);
    expect(derivatives.ok).toBe(true);
    if (!derivatives.ok) return;

    const embedding = derivatives.value.find((d) => d.kind === 'EMBEDDING');
    expect(embedding).toBeDefined();
    expect(embedding?.locator).toContain('memories.embedding');
    // L'embedding vit sur la même ligne : il disparaît en cascade.
    expect(embedding?.cascades).toBe(true);
  });

  it('un même dérivé enregistré deux fois ne se duplique pas', async () => {
    await store.attachEmbedding(
      memoryId,
      embedDeterministic('portail télécommande grise'),
      'fake-bow-768',
    );

    const derivatives = await registry.listFor(memoryId);
    expect(derivatives.ok).toBe(true);
    if (!derivatives.ok) return;

    const embeddings = derivatives.value.filter((d) => d.kind === 'EMBEDDING');
    expect(embeddings.length).toBe(1);
  });

  it('distingue les dérivés exigeant une suppression explicite', async () => {
    // Un index externe ne disparaît pas avec la ligne : c'est exactement le
    // cas que ce registre existe pour rendre traçable.
    const registered = await registry.register(
      memoryId,
      'INDEX_ENTRY',
      'index-externe://memoires/portail',
      false,
    );
    expect(registered.ok).toBe(true);

    const manual = await registry.requiringManualDeletion(memoryId);
    expect(manual.ok).toBe(true);
    if (!manual.ok) return;

    expect(manual.value.length).toBe(1);
    expect(manual.value[0]?.kind).toBe('INDEX_ENTRY');
    expect(manual.value[0]?.cascades).toBe(false);
  });

  it('supprimer la mémoire emporte les dérivés en cascade', async () => {
    const removed = await db.query('DELETE FROM memories WHERE id = $1', [
      memoryId,
    ]);
    expect(removed.ok).toBe(true);

    const derivatives = await registry.listFor(memoryId);
    expect(derivatives.ok).toBe(true);
    if (derivatives.ok) expect(derivatives.value).toEqual([]);
  });
});
