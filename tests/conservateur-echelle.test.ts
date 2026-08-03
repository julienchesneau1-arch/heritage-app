import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConservateurService, overexposureThreshold } from '@/services/conservateur.service';
import { createMemoryStore } from '@/lib/redis';
import { searchTextOf } from '@/services/story.service';
import { normalizeName } from '@/lib/normalize';

const FAMILY = 'fam_1';

describe('Seuil de sur-exposition — relatif à la taille du corpus', () => {
  it('ne déclare pas tout le monde sur-exposé sur une petite famille', () => {
    // Avec 5 récits, la part moyenne est déjà de 20 % : un seuil fixe à
    // 15 % les condamnait tous dès les premières lectures.
    expect(overexposureThreshold(5)).toBe(40);
    expect(overexposureThreshold(4)).toBe(50);
  });

  it('retombe sur les 15 % de la spec dès que le corpus est fourni', () => {
    expect(overexposureThreshold(20)).toBe(15);
    expect(overexposureThreshold(200)).toBe(15);
  });

  it('ne peut jamais déclencher sur une famille sans récit', () => {
    expect(overexposureThreshold(0)).toBe(100);
  });

  it('épargne un récit à 30 % quand la famille n’en compte que cinq', async () => {
    const prisma = {
      visibilityLog: {
        groupBy: async () => [
          { storyId: 's1', _count: { storyId: 30 } },
          { storyId: 's2', _count: { storyId: 25 } },
          { storyId: 's3', _count: { storyId: 25 } },
          { storyId: 's4', _count: { storyId: 20 } },
        ],
      },
      story: { count: async () => 5 },
    } as unknown as PrismaClient;

    const service = new ConservateurService(prisma, createMemoryStore());
    expect(await service.checkOverexposure(FAMILY)).toEqual([]);
  });

  it('signale encore une vraie captation d’attention', async () => {
    const prisma = {
      visibilityLog: {
        groupBy: async () => [
          { storyId: 's1', _count: { storyId: 60 } },
          { storyId: 's2', _count: { storyId: 40 } },
        ],
      },
      story: { count: async () => 5 },
    } as unknown as PrismaClient;

    const service = new ConservateurService(prisma, createMemoryStore());
    expect(await service.checkOverexposure(FAMILY)).toEqual(['s1']);
  });
});

describe('Distorsion — agrégée, jamais chargée en mémoire', () => {
  function serviceWith(stories: Array<{ id: string; authorId: string; narratorId: string | null }>) {
    const findMany = vi.fn(async () => stories);
    const groupBy = vi.fn(async () => stories.map((s) => ({ storyId: s.id, _count: { storyId: 10 } })));
    const logFindMany = vi.fn(async () => []);

    const prisma = {
      story: { findMany },
      visibilityLog: { groupBy, findMany: logFindMany },
    } as unknown as PrismaClient;

    return { service: new ConservateurService(prisma, createMemoryStore()), groupBy, logFindMany };
  }

  it('agrège les impressions en base au lieu de les lire ligne à ligne', async () => {
    const { service, groupBy, logFindMany } = serviceWith([
      { id: 's1', authorId: 'a', narratorId: null },
      { id: 's2', authorId: 'b', narratorId: null },
    ]);

    await service.calculateDistortion(FAMILY);

    expect(groupBy).toHaveBeenCalledOnce();
    // L'ancienne version chargeait chaque ligne du journal : sur dix ans
    // d'usage, des centaines de milliers d'enregistrements par affichage.
    expect(logFindMany).not.toHaveBeenCalled();
  });

  it('écarte les impressions d’un récit supprimé des deux côtés du calcul', async () => {
    const prisma = {
      story: { findMany: async () => [{ id: 's1', authorId: 'a', narratorId: null }] },
      visibilityLog: {
        groupBy: async () => [
          { storyId: 's1', _count: { storyId: 5 } },
          { storyId: 's_disparu', _count: { storyId: 5 } },
        ],
      },
    } as unknown as PrismaClient;

    // Les compter au dénominateur seulement inventerait une distorsion :
    // ici la seule voix connue est lue exactement à hauteur du corpus.
    const service = new ConservateurService(prisma, createMemoryStore());
    await expect(service.calculateDistortion(FAMILY)).resolves.toBe(0);
  });
});

describe('Recherche insensible aux accents', () => {
  it('indexe le titre et le contenu sous forme normalisée', () => {
    const indexed = searchTextOf('Le déménagement de Bordeaux', 'On est partis en août 1971.');
    expect(indexed).toContain('demenagement');
    expect(indexed).toContain('aout');
  });

  it('fait correspondre une requête sans accent au texte indexé', () => {
    const indexed = searchTextOf('Le déménagement de Bordeaux', '');
    expect(indexed.includes(normalizeName('demenagement'))).toBe(true);
    expect(indexed.includes(normalizeName('DÉMÉNAGEMENT'))).toBe(true);
  });
});
