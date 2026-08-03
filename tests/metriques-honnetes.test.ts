import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MetricsService, MIN_STORIES_FOR_RATE } from '@/services/metrics.service';
import { ConservateurService } from '@/services/conservateur.service';
import { createMemoryStore } from '@/lib/redis';

const FAMILY = 'fam_1';

/**
 * Un défaut de forme identique traversait la page Transmission : afficher un
 * zéro là où rien n'avait pu être mesuré. « Distorsion 0/100 » se lit
 * « mémoire parfaitement fidèle » ; « transmission 0 % » se lit comme un
 * échec. Dans les deux cas, le produit affirmait ce qu'il ignorait.
 *
 * Ces tests fixent la règle : une mesure impossible vaut `null`, jamais 0.
 */

function metricsWith(storiesCount: number, passages: Array<{ parentStoryId: string; childStoryId: string; latencyDays: number }>, conversations: Array<{ status: string; count: number }> = []) {
  const prisma = {
    story: { count: async () => storiesCount },
    passage: { findMany: async () => passages },
    conversation: {
      groupBy: async () => conversations.map((c) => ({ status: c.status, _count: { status: c.count } })),
    },
  } as unknown as PrismaClient;
  return new MetricsService(prisma);
}

describe('Taux de transmission — pas de verdict sans dossier', () => {
  it('ne se prononce pas sur une famille de trois récits', async () => {
    // 0 % ici se lirait comme un échec. C'est un manque de matière.
    const metrics = await metricsWith(3, []).transmission(FAMILY);
    expect(metrics.transmissionRate).toBeNull();
    expect(metrics.basisSufficient).toBe(false);
  });

  it('ne se prononce pas sur une famille vide', async () => {
    const metrics = await metricsWith(0, []).transmission(FAMILY);
    expect(metrics.transmissionRate).toBeNull();
    expect(metrics.rawPassageRatio).toBeNull();
  });

  it('se prononce dès que la mesure peut exprimer sa cible', async () => {
    // L'objectif est « une histoire sur cinq » : il faut cinq récits pour
    // que le chiffre puisse seulement s'en approcher.
    const metrics = await metricsWith(MIN_STORIES_FOR_RATE, [
      { parentStoryId: 's1', childStoryId: 's2', latencyDays: 10 },
    ]).transmission(FAMILY);

    expect(metrics.basisSufficient).toBe(true);
    expect(metrics.transmissionRate).toBe(0.2);
  });

  it('un vrai zéro sur un corpus suffisant reste un vrai zéro', async () => {
    // Dix récits, aucun passage : là, le constat est légitime.
    const metrics = await metricsWith(10, []).transmission(FAMILY);
    expect(metrics.transmissionRate).toBe(0);
    expect(metrics.basisSufficient).toBe(true);
  });

  it('n’invente pas un taux de conversion sans aucune question posée', async () => {
    const metrics = await metricsWith(10, []).transmission(FAMILY);
    expect(metrics.passeurConversion).toBeNull();
  });

  it('mesure la conversion dès qu’une question existe', async () => {
    const metrics = await metricsWith(10, [], [
      { status: 'pending', count: 3 },
      { status: 'converted', count: 1 },
    ]).transmission(FAMILY);
    expect(metrics.passeurConversion).toBe(0.25);
  });
});

describe('Distorsion — l’absence de mesure n’est pas un bon résultat', () => {
  function serviceWith(stories: Array<{ id: string; authorId: string; narratorId: string | null }>, impressions: Array<{ storyId: string; count: number }>) {
    const prisma = {
      story: { findMany: async () => stories, count: async () => stories.length },
      visibilityLog: {
        groupBy: async () => impressions.map((i) => ({ storyId: i.storyId, _count: { storyId: i.count } })),
        count: async () => impressions.reduce((sum, i) => sum + i.count, 0),
      },
      storyMute: { count: async () => 0 },
    } as unknown as PrismaClient;
    return new ConservateurService(prisma, createMemoryStore());
  }

  it('ne rend pas 0 quand aucune lecture n’a été enregistrée', async () => {
    const service = serviceWith([{ id: 's1', authorId: 'a', narratorId: null }], []);
    expect(await service.calculateDistortion(FAMILY)).toBeNull();
  });

  it('ne rend pas 0 sur une famille sans récit', async () => {
    expect(await serviceWith([], []).calculateDistortion(FAMILY)).toBeNull();
  });

  it('rend un vrai 0 quand les lectures reflètent le corpus', async () => {
    const service = serviceWith(
      [
        { id: 's1', authorId: 'a', narratorId: null },
        { id: 's2', authorId: 'b', narratorId: null },
      ],
      [
        { storyId: 's1', count: 5 },
        { storyId: 's2', count: 5 },
      ],
    );
    expect(await service.calculateDistortion(FAMILY)).toBe(0);
  });

  it('le rapport distingue « non mesuré » de « rien à signaler »', async () => {
    const vide = await serviceWith([{ id: 's1', authorId: 'a', narratorId: null }], []).report(FAMILY);
    expect(vide.impressions).toBe(0);
    expect(vide.overexposedStories).toBeNull();
    expect(vide.distortionScore).toBeNull();

    const mesuré = await serviceWith(
      [
        { id: 's1', authorId: 'a', narratorId: null },
        { id: 's2', authorId: 'b', narratorId: null },
      ],
      [
        { storyId: 's1', count: 5 },
        { storyId: 's2', count: 5 },
      ],
    ).report(FAMILY);
    expect(mesuré.impressions).toBe(10);
    expect(mesuré.overexposedStories).toBe(0);
    expect(mesuré.distortionScore).toBe(0);
  });
});

describe('Récits oubliés — un récit d’hier n’est pas du patrimoine en péril', () => {
  function serviceCapturing() {
    let captured: Record<string, unknown> = {};
    const prisma = {
      story: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          captured = args.where;
          return [];
        },
      },
    } as unknown as PrismaClient;
    return { service: new ConservateurService(prisma, createMemoryStore()), where: () => captured };
  }

  it('exige qu’un récit jamais relu existe depuis au moins douze mois', async () => {
    // Sans cette condition, un récit écrit hier était déclaré « non relu
    // depuis douze mois » — factuellement faux — et remplissait la veillée
    // de nouveautés présentées comme du patrimoine à sauver.
    const { service, where } = serviceCapturing();
    await service.getForgottenStories(FAMILY, 3, new Date(2026, 6, 28));

    const clauses = where().OR as Array<Record<string, unknown>>;
    const jamaisRelu = clauses.find((clause) => clause.lastViewedAt === null);

    expect(jamaisRelu).toBeDefined();
    expect(jamaisRelu!.createdAt).toBeDefined();
  });
});
