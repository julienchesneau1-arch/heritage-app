import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MetricsService } from '@/services/metrics.service';
import { normalizeName, monthDayOf, daysBetween } from '@/lib/normalize';
import { lengthFromContent } from '@/lib/structure-types';

function metricsWith(
  storiesCount: number,
  passages: Array<{ parentStoryId: string; childStoryId: string; latencyDays: number }>,
) {
  const prisma = {
    story: { count: async () => storiesCount },
    passage: { findMany: async () => passages },
    conversation: { groupBy: async () => [] },
  } as unknown as PrismaClient;
  return new MetricsService(prisma);
}

describe('transmission_rate', () => {
  it('compte les récits PARENTS distincts, pas les passages', async () => {
    // s1 engendre s2 et s3 : un seul récit a transmis, sur 4.
    const service = metricsWith(4, [
      { parentStoryId: 's1', childStoryId: 's2', latencyDays: 10 },
      { parentStoryId: 's1', childStoryId: 's3', latencyDays: 40 },
    ]);
    const metrics = await service.transmission('fam_1');
    expect(metrics.transmissionRate).toBe(0.25);
    expect(metrics.rawPassageRatio).toBe(0.5);
  });

  it('vaut 0 sur une famille sans récit, sans division par zéro', async () => {
    const metrics = await metricsWith(0, []).transmission('fam_1');
    expect(metrics.transmissionRate).toBe(0);
    expect(metrics.medianLatencyDays).toBeNull();
    expect(metrics.maxChainDepth).toBe(0);
  });

  it('calcule la latence médiane', async () => {
    const service = metricsWith(5, [
      { parentStoryId: 's1', childStoryId: 's2', latencyDays: 5 },
      { parentStoryId: 's2', childStoryId: 's3', latencyDays: 100 },
      { parentStoryId: 's3', childStoryId: 's4', latencyDays: 30 },
    ]);
    expect((await service.transmission('fam_1')).medianLatencyDays).toBe(30);
  });

  it('mesure la plus longue chaîne de transmission', async () => {
    const service = metricsWith(5, [
      { parentStoryId: 's1', childStoryId: 's2', latencyDays: 1 },
      { parentStoryId: 's2', childStoryId: 's3', latencyDays: 1 },
      { parentStoryId: 's3', childStoryId: 's4', latencyDays: 1 },
    ]);
    expect((await service.transmission('fam_1')).maxChainDepth).toBe(4);
  });

  it('ne boucle pas à l’infini si deux récits se renvoient l’un à l’autre', async () => {
    const service = metricsWith(2, [
      { parentStoryId: 's1', childStoryId: 's2', latencyDays: 1 },
      { parentStoryId: 's2', childStoryId: 's1', latencyDays: 1 },
    ]);
    expect((await service.transmission('fam_1')).maxChainDepth).toBe(2);
  });
});

describe('normalisation', () => {
  it('retire accents, ponctuation et casse (§2.1 règle 4)', () => {
    expect(normalizeName('L’Atelier de Robert-Émile')).toBe('l atelier de robert emile');
    expect(normalizeName('BORDEAUX')).toBe('bordeaux');
    expect(normalizeName('Élodie')).toBe(normalizeName('elodie'));
  });

  it('formate le jour-mois en temps local', () => {
    expect(monthDayOf(new Date(2026, 9, 5))).toBe('10-05');
    expect(monthDayOf(new Date(2026, 0, 1))).toBe('01-01');
  });

  it('compte les jours entre deux dates', () => {
    expect(daysBetween(new Date(2026, 0, 1), new Date(2026, 0, 31))).toBe(30);
    expect(daysBetween(new Date(2026, 0, 31), new Date(2026, 0, 1))).toBe(0);
  });
});

describe('grammaire narrative', () => {
  it('déduit la longueur du texte, sans la demander à l’auteur', () => {
    expect(lengthFromContent('a'.repeat(100))).toBe('micro');
    expect(lengthFromContent('a'.repeat(800))).toBe('standard');
    expect(lengthFromContent('a'.repeat(3000))).toBe('long');
  });
});
