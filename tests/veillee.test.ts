import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { VeilleeService } from '@/services/veillee.service';
import { ConservateurService } from '@/services/conservateur.service';
import { createMemoryStore, type KeyValueStore } from '@/lib/redis';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';
import { ONE_TAP_QUESTIONS } from '@/lib/questions';

const FAMILY = 'fam_1';
const NOW = new Date(2026, 6, 28, 20, 30);

const CORPUS = [
  {
    id: 's_oublie',
    title: 'Le déménagement de Bordeaux',
    createdAt: new Date(2021, 7, 22),
    lastViewedAt: null,
    archived: false,
    quarantined: false,
    entityCount: 1,
  },
  {
    id: 's_rassemble',
    title: 'La montre arrêtée',
    createdAt: new Date(2024, 5, 10),
    lastViewedAt: new Date(2026, 5, 15),
    archived: false,
    quarantined: false,
    entityCount: 4,
  },
  {
    id: 's_recent',
    title: 'La première tarte',
    createdAt: new Date(2026, 6, 20),
    lastViewedAt: new Date(2026, 6, 21),
    archived: false,
    quarantined: false,
    entityCount: 2,
  },
];

function buildService(corpus = CORPUS, store: KeyValueStore = createMemoryStore()) {
  let selectCalls = 0;

  const prisma = {
    story: {
      findMany: async (args: {
        where: Record<string, unknown>;
        orderBy?: Record<string, unknown>;
        take?: number;
      }) => {
        selectCalls += 1;
        const where = args.where ?? {};

        let rows = corpus.filter((story) => !story.archived && !story.quarantined);

        const idFilter = where.id as { in?: string[]; notIn?: string[] } | undefined;
        if (idFilter?.in) rows = rows.filter((story) => idFilter.in!.includes(story.id));
        if (idFilter?.notIn) rows = rows.filter((story) => !idFilter.notIn!.includes(story.id));
        if (where.OR) {
          // Clause « jamais vu, ou vu il y a plus de 12 mois ».
          rows = rows.filter(
            (story) => story.lastViewedAt === null || story.lastViewedAt < new Date(2025, 6, 28),
          );
        }

        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        if (orderBy?.linkedEntities) rows = [...rows].sort((a, b) => b.entityCount - a.entityCount);
        else if (orderBy?.createdAt === 'desc')
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        else rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        return rows.slice(0, args.take ?? undefined).map((story) => ({
          ...story,
          author: { name: 'Claire Martin', isDeleted: false },
          _count: { linkedEntities: story.entityCount },
        }));
      },
    },
  } as unknown as PrismaClient;

  const service = new VeilleeService(prisma, store, new ConservateurService(prisma, store));
  return { service, store, calls: () => selectCalls };
}

describe('La veillée — composition', () => {
  it('propose trois récits, jamais plus', async () => {
    const { service } = buildService();
    const veillee = await service.compose(FAMILY, NOW);
    expect(veillee.entries).toHaveLength(3);
  });

  it('donne trois raisons différentes d’être là', async () => {
    const { service } = buildService();
    const veillee = await service.compose(FAMILY, NOW);
    const justifications = veillee.entries.map((entry) => entry.justification);
    expect(new Set(justifications).size).toBe(3);
    for (const justification of justifications) expect(justification.length).toBeGreaterThan(10);
  });

  it('ouvre sur le récit que personne n’a relu', async () => {
    const { service } = buildService();
    const veillee = await service.compose(FAMILY, NOW);
    expect(veillee.entries[0]!.story.id).toBe('s_oublie');
  });

  it('ne répète jamais un récit dans la même veillée', async () => {
    const { service } = buildService();
    const veillee = await service.compose(FAMILY, NOW);
    const ids = veillee.entries.map((entry) => entry.story.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ne complète pas avec du remplissage quand le corpus est court', async () => {
    const { service } = buildService([CORPUS[0]!]);
    const veillee = await service.compose(FAMILY, NOW);
    expect(veillee.entries).toHaveLength(1);
  });

  it('ne propose rien plutôt qu’une veillée vide', async () => {
    const { service } = buildService([]);
    const veillee = await service.compose(FAMILY, NOW);
    expect(veillee.entries).toHaveLength(0);
  });

  it('exclut les récits archivés et en quarantaine', async () => {
    const { service } = buildService([
      { ...CORPUS[0]!, archived: true },
      { ...CORPUS[1]!, quarantined: true },
      CORPUS[2]!,
    ]);
    const veillee = await service.compose(FAMILY, NOW);
    expect(veillee.entries.map((entry) => entry.story.id)).toEqual(['s_recent']);
  });
});

describe('La veillée — une seule pour toute la famille', () => {
  it('sert exactement les mêmes récits, dans le même ordre, au second appel', async () => {
    const store = createMemoryStore();
    const first = await buildService(CORPUS, store).service.compose(FAMILY, NOW);
    // Deuxième téléphone, dans la même pièce, une minute plus tard.
    const second = await buildService(CORPUS, store).service.compose(
      FAMILY,
      new Date(NOW.getTime() + 60_000),
    );

    expect(second.entries.map((e) => e.story.id)).toEqual(first.entries.map((e) => e.story.id));
    expect(second.entries.map((e) => e.justification)).toEqual(
      first.entries.map((e) => e.justification),
    );
  });

  it('ne recompose pas la sélection au second appel', async () => {
    const store = createMemoryStore();
    await buildService(CORPUS, store).service.compose(FAMILY, NOW);

    const { service, calls } = buildService(CORPUS, store);
    await service.compose(FAMILY, NOW);
    // Une seule requête : le chargement des récits déjà choisis.
    expect(calls()).toBe(1);
  });

  it('recompose une nouvelle veillée le lendemain', async () => {
    const store = createMemoryStore();
    const soir = await buildService(CORPUS, store).service.compose(FAMILY, NOW);
    const lendemain = new Date(NOW.getTime() + 24 * 3600 * 1000);
    const suivante = await buildService(CORPUS, store).service.compose(FAMILY, lendemain);
    expect(suivante.date).not.toBe(soir.date);
  });
});

describe('La veillée — Constitution', () => {
  it('n’infère aucune émotion et ne fait aucune pression dans ses justifications', async () => {
    const { service } = buildService();
    const veillee = await service.compose(FAMILY, NOW);
    for (const { justification } of veillee.entries) {
      expect(constitutionEmotionFilter(justification)).toBe(true);
      expect(isNonCoerciveLanguage(justification)).toBe(true);
    }
  });
});

describe('Questions en un geste', () => {
  it('franchissent le filtre constitutionnel', () => {
    for (const question of ONE_TAP_QUESTIONS) {
      expect(constitutionEmotionFilter(question)).toBe(true);
      expect(isNonCoerciveLanguage(question)).toBe(true);
    }
  });

  it('restent lisibles par un enfant : courtes et ouvertes', () => {
    for (const question of ONE_TAP_QUESTIONS) {
      expect(question.length).toBeLessThanOrEqual(40);
      expect(question.endsWith('?')).toBe(true);
    }
  });

  it('sont assez peu nombreuses pour tenir sur une ligne de téléphone', () => {
    expect(ONE_TAP_QUESTIONS.length).toBeLessThanOrEqual(4);
  });
});
