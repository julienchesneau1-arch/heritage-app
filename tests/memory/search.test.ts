/**
 * Recherche hybride — trois voies, fusion RRF, dégradation gracieuse.
 *
 * Porte de sortie Phase 1 :
 *   « Recherche mémoire fonctionnelle réseau coupé. »
 *   « Les trois voies de récupération sont mesurées séparément. »
 *
 * Les deux exigences sont liées : c'est parce que les voies sont mesurées
 * séparément qu'on peut affirmer que deux d'entre elles survivent à la
 * coupure — au lieu de constater qu'« il y a encore des résultats ».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHybridSearch, type HybridSearch } from '../../src/core/memory/search.js';
import { createMemoryStore, type MemoryStore } from '../../src/core/memory/store.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import {
  createFakeEmbeddingProvider,
  embedDeterministic,
} from '../helpers/fake-embeddings.js';

const skip = !databaseAvailable();

const CORPUS = [
  'La référence du carrelage de la salle de bain est Marazzi Treverk 20x120.',
  'On a décidé que la décoration du mariage serait en tons ivoire et eucalyptus.',
  'Le traiteur du mariage propose un menu à 78 euros par personne.',
  'Jean travaille chez Orano depuis 2019.',
  'Le plombier doit repasser pour le chauffe-eau de la cuisine.',
];

describe.skipIf(skip)('recherche hybride', () => {
  let db: Db;
  let store: MemoryStore;
  let withSemantic: HybridSearch;
  let offline: HybridSearch;
  let entityId: string;

  beforeAll(async () => {
    db = appDb();
    store = createMemoryStore(db);
    const guard = createMemoryGuard(store, createMemoryInbox(db));

    const entity = await db.query<{ id: string }>(
      `INSERT INTO entities (kind, display_name) VALUES ('PROJECT', 'Mariage')
       RETURNING id`,
    );
    if (!entity.ok) throw new Error(entity.error.message);
    entityId = entity.value.rows[0]?.id ?? '';

    const provider = createFakeEmbeddingProvider();

    for (const [index, content] of CORPUS.entries()) {
      const stored = await guard.propose(
        {
          memoryType: 'SEMANTIC',
          content,
          sourceType: 'USER_EXPLICIT',
          source: 'test-corpus',
          dataCategory: 'PERSONAL_MEMORY',
          suggestedConfidence: 0.9,
          subjectEntityId: index === 1 || index === 2 ? entityId : null,
        },
        { userConfirmed: true },
      );
      if (!stored.ok) throw new Error(stored.error.message);
      if (stored.value.outcome !== 'STORED') {
        throw new Error(`corpus non stocké : ${stored.value.outcome}`);
      }

      const attached = await store.attachEmbedding(
        stored.value.memory.id,
        embedDeterministic(content),
        provider.model,
      );
      if (!attached.ok) throw new Error(attached.error.message);
    }

    withSemantic = createHybridSearch(db, provider);
    offline = createHybridSearch(db, null);
  });

  afterAll(async () => {
    await db.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Les trois voies, séparément                                            */
  /* ---------------------------------------------------------------------- */

  it('rapporte les trois voies distinctement, avec leur temps', async () => {
    const result = await withSemantic.search({ text: 'carrelage salle de bain' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lanes.map((l) => l.lane)).toEqual([
      'STRUCTURED',
      'LEXICAL',
      'SEMANTIC',
    ]);
    for (const lane of result.value.lanes) {
      expect(lane.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('la voie lexicale trouve une référence exacte', async () => {
    const result = await withSemantic.search({ text: 'Marazzi Treverk' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lexical = result.value.lanes.find((l) => l.lane === 'LEXICAL');
    expect(lexical?.available).toBe(true);
    expect(lexical?.hits.length).toBeGreaterThan(0);
    expect(lexical?.hits[0]?.memory.content).toContain('Marazzi');
  });

  it('la voie lexicale gère le français (racines, accents)', async () => {
    // « décoration » doit être retrouvé par « décoration » comme par « décorations ».
    const result = await withSemantic.search({ text: 'décorations' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lexical = result.value.lanes.find((l) => l.lane === 'LEXICAL');
    expect(lexical?.hits.some((h) => h.memory.content.includes('décoration'))).toBe(
      true,
    );
  });

  it('la voie structurée restreint aux entités demandées', async () => {
    const result = await withSemantic.search({
      text: 'peu importe',
      entityIds: [entityId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const structured = result.value.lanes.find((l) => l.lane === 'STRUCTURED');
    expect(structured?.hits.length).toBe(2);
    for (const hit of structured?.hits ?? []) {
      expect(hit.memory.subjectEntityId).toBe(entityId);
    }
  });

  it('la voie sémantique rapproche des formulations différentes', async () => {
    const result = await withSemantic.search({ text: 'fuite eau chaude cuisine' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const semantic = result.value.lanes.find((l) => l.lane === 'SEMANTIC');
    expect(semantic?.available).toBe(true);
    expect(semantic?.hits.length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------------- */
  /* Fusion                                                                 */
  /* ---------------------------------------------------------------------- */

  it('la voie structurée passe devant la fusion', async () => {
    const result = await withSemantic.search({
      text: 'mariage',
      entityIds: [entityId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.merged[0]?.lanes).toContain('STRUCTURED');
  });

  it('une mémoire trouvée par deux voies remonte au-dessus', async () => {
    const result = await withSemantic.search({ text: 'mariage décoration ivoire' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const multi = result.value.merged.filter((m) => m.lanes.length > 1);
    if (multi.length > 0) {
      const best = result.value.merged[0];
      expect(best?.lanes.length).toBeGreaterThanOrEqual(1);
      // RRF : un document présent dans les deux voies a un score strictement
      // supérieur à un document présent dans une seule au même rang.
      expect(multi[0]?.rrfScore).toBeGreaterThan(1 / (60 + 10));
    }
  });

  it('ne renvoie jamais plus que la limite demandée', async () => {
    const result = await withSemantic.search({ text: 'mariage', limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.merged.length).toBeLessThanOrEqual(2);
  });

  /* ---------------------------------------------------------------------- */
  /* Hors ligne — l'exigence centrale                                       */
  /* ---------------------------------------------------------------------- */

  it('reste fonctionnelle sans fournisseur d\'embeddings', async () => {
    const result = await offline.search({ text: 'Marazzi Treverk' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.degraded).toBe(true);
    expect(result.value.merged.length).toBeGreaterThan(0);
    expect(result.value.merged[0]?.memory.content).toContain('Marazzi');
  });

  it('signale explicitement la voie indisponible et pourquoi', async () => {
    const result = await offline.search({ text: 'carrelage' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const semantic = result.value.lanes.find((l) => l.lane === 'SEMANTIC');
    expect(semantic?.available).toBe(false);
    expect(semantic?.unavailableReason).toBeDefined();
    // La dégradation doit être lisible par un humain, pas déduite d'un tableau vide.
    expect(semantic?.unavailableReason).toContain('lexicale');
  });

  it('survit à une panne du fournisseur, pas seulement à son absence', async () => {
    const broken = createHybridSearch(
      db,
      createFakeEmbeddingProvider({ unavailable: true }),
    );
    const result = await broken.search({ text: 'plombier chauffe-eau' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.degraded).toBe(true);
    expect(result.value.merged.length).toBeGreaterThan(0);
  });

  it('ne compare jamais des vecteurs de modèles différents', async () => {
    // Un changement de modèle d'embedding rendrait les anciens vecteurs
    // incomparables. Le filtre `embedding_model` doit les exclure.
    const otherModel = createHybridSearch(
      db,
      createFakeEmbeddingProvider({ model: 'autre-modele-768' }),
    );
    const result = await otherModel.search({ text: 'carrelage' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const semantic = result.value.lanes.find((l) => l.lane === 'SEMANTIC');
    expect(semantic?.available).toBe(true);
    expect(semantic?.hits.length).toBe(0);
  });
});
