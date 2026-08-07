import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConservateurService } from '@/services/conservateur.service';
import { createMemoryStore } from '@/lib/redis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FAMILY = 'fam_1';

describe('Budget de visibilité — 15 % sur 12 mois', () => {
  function serviceWithImpressions(counts: Array<{ storyId: string; count: number }>) {
    const prisma = {
      visibilityLog: {
        groupBy: async () => counts.map((c) => ({ storyId: c.storyId, _count: { storyId: c.count } })),
      },
      // Corpus fourni : le seuil relatif retombe sur les 15 % de la spec.
      story: { count: async () => 20 },
    } as unknown as PrismaClient;
    return new ConservateurService(prisma, createMemoryStore());
  }

  it('signale une histoire au-delà de 15 % des impressions', async () => {
    const service = serviceWithImpressions([
      { storyId: 's1', count: 30 }, // 30 %
      { storyId: 's2', count: 40 }, // 40 %
      { storyId: 's3', count: 30 }, // 30 %
    ]);
    const overexposed = await service.checkOverexposure(FAMILY);
    expect(overexposed.sort()).toEqual(['s1', 's2', 's3']);
  });

  it('ne signale rien quand la distribution est plate', async () => {
    const service = serviceWithImpressions(
      Array.from({ length: 10 }, (_, i) => ({ storyId: `s${i}`, count: 10 })), // 10 % chacune
    );
    expect(await service.checkOverexposure(FAMILY)).toEqual([]);
  });

  it('ne divise pas par zéro quand rien n’a jamais été montré', async () => {
    const service = serviceWithImpressions([]);
    expect(await service.checkOverexposure(FAMILY)).toEqual([]);
  });

  it('marque la sur-exposition dans le store pour que le Passeur l’évite', async () => {
    const service = serviceWithImpressions([
      { storyId: 's1', count: 90 },
      { storyId: 's2', count: 10 },
    ]);
    await service.checkOverexposure(FAMILY);
    expect(await service.isOverexposed('s1')).toBe(true);
    expect(await service.isOverexposed('s2')).toBe(false);
  });
});

describe('Quarantaine — trois rejets explicites du même membre', () => {
  function serviceWithUpdateSpy() {
    // La mise en sourdine est désormais portée par (récit, membre).
    const update = vi.fn(async () => ({}));
    const prisma = {
      visibilityLog: { create: async () => ({}) },
      storyMute: { upsert: update },
    } as unknown as PrismaClient;
    return { service: new ConservateurService(prisma, createMemoryStore()), update };
  }

  it('ne met pas en quarantaine avant le troisième rejet', async () => {
    const { service, update } = serviceWithUpdateSpy();
    const params = { familyId: FAMILY, storyId: 's1', memberId: 'm1', context: 'home' as const };

    expect((await service.processDismissal(params)).quarantined).toBe(false);
    expect((await service.processDismissal(params)).quarantined).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('met en quarantaine au troisième rejet', async () => {
    const { service, update } = serviceWithUpdateSpy();
    const params = { familyId: FAMILY, storyId: 's1', memberId: 'm1', context: 'home' as const };

    await service.processDismissal(params);
    await service.processDismissal(params);
    const third = await service.processDismissal(params);

    expect(third.quarantined).toBe(true);
    expect(update).toHaveBeenCalledOnce();
  });

  it('compte par membre : trois membres différents ne déclenchent rien', async () => {
    const { service, update } = serviceWithUpdateSpy();
    for (const memberId of ['m1', 'm2', 'm3']) {
      const result = await service.processDismissal({
        familyId: FAMILY,
        storyId: 's1',
        memberId,
        context: 'home',
      });
      expect(result.quarantined).toBe(false);
    }
    expect(update).not.toHaveBeenCalled();
  });
});

describe('Métrique de distorsion', () => {
  function serviceWith(stories: string[], viewAuthors: string[]) {
    // Un récit distinct par vue, pour que l'agrégation par storyId reflète
    // exactement la distribution demandée.
    const prisma = {
      story: {
        findMany: async () =>
          stories.map((authorId, index) => ({ id: `s${index}`, authorId, narratorId: null })),
      },
      visibilityLog: {
        groupBy: async () =>
          stories.map((authorId, index) => ({
            storyId: `s${index}`,
            _count: { storyId: viewAuthors.filter((a) => a === authorId).length / countOf(stories, authorId) },
          })),
      },
    } as unknown as PrismaClient;
    return new ConservateurService(prisma, createMemoryStore());
  }

  it('vaut 0 quand les vues reflètent exactement le corpus', async () => {
    const service = serviceWith(['a', 'a', 'b', 'b'], ['a', 'a', 'b', 'b']);
    expect(await service.calculateDistortion(FAMILY)).toBe(0);
  });

  it('monte à 50 quand un seul auteur est lu alors que deux écrivent à parts égales', async () => {
    const service = serviceWith(['a', 'b'], ['a', 'a', 'a', 'a']);
    expect(await service.calculateDistortion(FAMILY)).toBe(50);
  });

  it('ne se prononce pas sur une famille vide', async () => {
    // Anciennement 0 — ce qui se lisait « mémoire parfaitement fidèle »
    // alors qu'aucune mesure n'était possible.
    const service = serviceWith([], []);
    expect(await service.calculateDistortion(FAMILY)).toBeNull();
  });
});

describe('Distorsion — la voix compte, pas le clavier', () => {
  /**
   * Jeanne a 92 ans et ne tape pas : Claire note tout ce qu'elle raconte.
   * Si la métrique comptait le clavier, Jeanne n'existerait pas dans la
   * mesure — et c'est précisément son silence qu'il faudrait détecter.
   */
  function serviceWith(
    stories: Array<{ authorId: string; narratorId: string | null }>,
    views: Array<{ authorId: string; narratorId: string | null }>,
  ) {
    const withIds = stories.map((story, index) => ({ id: `s${index}`, ...story }));
    const prisma = {
      story: { findMany: async () => withIds },
      visibilityLog: {
        groupBy: async () =>
          withIds.map((story) => ({
            storyId: story.id,
            _count: {
              storyId: views.filter(
                (view) => (view.narratorId ?? view.authorId) === (story.narratorId ?? story.authorId),
              ).length,
            },
          })),
      },
    } as unknown as PrismaClient;
    return new ConservateurService(prisma, createMemoryStore());
  }

  it('attribue le récit au narrateur, pas au scribe', async () => {
    // Corpus : 1 récit raconté par Jeanne (noté par Claire), 1 par Claire.
    // Vues : uniquement le récit de Jeanne. La distorsion doit être visible.
    const service = serviceWith(
      [
        { authorId: 'claire', narratorId: 'jeanne' },
        { authorId: 'claire', narratorId: null },
      ],
      [
        { authorId: 'claire', narratorId: 'jeanne' },
        { authorId: 'claire', narratorId: 'jeanne' },
      ],
    );
    // Corpus 50/50 entre Jeanne et Claire, vues 100 % Jeanne → 50.
    expect(await service.calculateDistortion(FAMILY)).toBe(50);
  });

  it('ne verrait aucune distorsion si elle comptait le clavier', async () => {
    // Même jeu de données : au clavier, tout est de Claire, donc 0 —
    // l'ancienne mesure aurait déclaré la mémoire parfaitement fidèle.
    const service = serviceWith(
      [
        { authorId: 'claire', narratorId: null },
        { authorId: 'claire', narratorId: null },
      ],
      [
        { authorId: 'claire', narratorId: null },
        { authorId: 'claire', narratorId: null },
      ],
    );
    expect(await service.calculateDistortion(FAMILY)).toBe(0);
  });
});

function countOf(values: string[], value: string): number {
  return Math.max(1, values.filter((v) => v === value).length);
}

/**
 * LE BUDGET DOIT SE TENIR TOUT SEUL.
 *
 * `isOverexposed()` lit une clé dont `checkOverexposure()` est le seul
 * écrivain, et aucun chemin du produit n'appelait `checkOverexposure()` :
 * il n'était atteint que par `report()`, c'est-à-dire quand quelqu'un
 * ouvrait la page Transmission.
 *
 * `outils/conservateur.mts` l'a mesuré sur deux familles identiques, 60
 * jours, mêmes récits et mêmes lectures. Celle qui ouvrait Transmission :
 * récit vedette signalé 60 jours sur 60, jamais proposé. Celle qui ne
 * l'ouvrait pas : le même récit à 52 % des impressions pour un seuil de
 * 15 %, signalé aucun jour, et encore proposé par le Passeur.
 *
 * Le budget de la §3.2 n'était pas une garantie du produit — c'était un
 * effet de bord d'une visite de page.
 */
describe('assurerBudget — le calcul se conduit lui-même', () => {
  function service(counts: Array<{ storyId: string; count: number }>) {
    let appels = 0;
    const prisma = {
      visibilityLog: {
        groupBy: async () => {
          appels += 1;
          return counts.map((c) => ({ storyId: c.storyId, _count: { storyId: c.count } }));
        },
      },
      story: { count: async () => 20 },
    } as unknown as PrismaClient;
    const conservateur = new ConservateurService(prisma, createMemoryStore());
    return { conservateur, appelsDuJournal: () => appels };
  }

  const DESEQUILIBRE = [
    { storyId: 's1', count: 80 },
    { storyId: 's2', count: 10 },
    { storyId: 's3', count: 10 },
  ];

  it('signale une sur-exposition sans que personne n’ouvre la page Transmission', async () => {
    const { conservateur } = service(DESEQUILIBRE);
    expect(await conservateur.isOverexposed('s1')).toBe(false);

    await conservateur.assurerBudget(FAMILY);
    expect(await conservateur.isOverexposed('s1')).toBe(true);
  });

  it('ne refait pas le calcul à chaque appel — le journal est coûteux', async () => {
    const { conservateur, appelsDuJournal } = service(DESEQUILIBRE);

    expect(await conservateur.assurerBudget(FAMILY)).toBe(true);
    expect(await conservateur.assurerBudget(FAMILY)).toBe(false);
    expect(await conservateur.assurerBudget(FAMILY)).toBe(false);
    expect(appelsDuJournal()).toBe(1);
  });

  it('le repère se pose APRÈS le calcul : un échec se retente', async () => {
    // Un repère posé d'abord ferait taire le mécanisme six heures durant,
    // en silence — le défaut qu'on vient précisément de corriger.
    let premier = true;
    const prisma = {
      visibilityLog: {
        groupBy: async () => {
          if (premier) {
            premier = false;
            throw new Error('base indisponible');
          }
          return DESEQUILIBRE.map((c) => ({ storyId: c.storyId, _count: { storyId: c.count } }));
        },
      },
      story: { count: async () => 20 },
    } as unknown as PrismaClient;
    const conservateur = new ConservateurService(prisma, createMemoryStore());

    await expect(conservateur.assurerBudget(FAMILY)).rejects.toThrow('base indisponible');
    await conservateur.assurerBudget(FAMILY);
    expect(await conservateur.isOverexposed('s1')).toBe(true);
  });

  it('et le Passeur le réveille avant de choisir un récit à proposer', () => {
    // Sans cet appel, `isOverexposed` rend `false` pour tout le monde et
    // le filtre juste en dessous ne filtre rien.
    const source = readFileSync(join(process.cwd(), 'src/services/passeur.service.ts'), 'utf8');
    const reveil = source.indexOf('this.conservateur.assurerBudget(');
    const filtre = source.indexOf('this.conservateur.isOverexposed(');
    expect(reveil).toBeGreaterThan(-1);
    expect(reveil).toBeLessThan(filtre);
  });
});
