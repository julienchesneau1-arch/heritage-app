import type { PrismaClient, Story } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { store as defaultStore, type KeyValueStore } from '@/lib/redis';
import type { VisibilityContext } from '@/lib/structure-types';

/**
 * CONSERVATEUR SERVICE — §3.2.
 *
 * Mission : garantir que rien ne devient inaccessible par effet d'algorithme.
 * Ne jamais imposer, toujours préserver la possibilité.
 *
 * Ce qu'il fait :   exclure une histoire sur-exposée des SUGGESTIONS, documenter.
 * Ce qu'il ne fait pas : modifier l'ordre d'affichage (chronologique), booster
 * une histoire oubliée, corriger un biais qu'il a mesuré (§8.1, amendement 5).
 */

export const OVEREXPOSURE_THRESHOLD_PERCENT = 15;
export const FORGOTTEN_AFTER_MONTHS = 12;
export const DISMISSAL_QUARANTINE_THRESHOLD = 3;

const OVEREXPOSED_TTL_SECONDS = 30 * 86_400;
const DISMISSAL_TTL_SECONDS = 90 * 86_400;

export interface ConservateurReport {
  totalStories: number;
  invisibleStories: number;
  overexposedStories: number;
  quarantinedStories: number;
  distortionScore: number;
}

export class ConservateurService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private store: KeyValueStore = defaultStore,
  ) {}

  /** Journalise une impression. Toute histoire montrée est traçable. */
  async logVisibility(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    context: VisibilityContext;
    dismissed?: boolean;
  }): Promise<void> {
    await this.prisma.visibilityLog.create({
      data: {
        familyId: params.familyId,
        storyId: params.storyId,
        memberId: params.memberId,
        context: params.context,
        dismissed: params.dismissed ?? false,
      },
    });
  }

  /** Une lecture effective : compteur + date de dernière vue. */
  async registerView(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    context: VisibilityContext;
  }): Promise<void> {
    await this.logVisibility(params);
    await this.prisma.story.update({
      where: { id: params.storyId },
      data: { views: { increment: 1 }, lastViewedAt: new Date() },
    });
  }

  /**
   * Budget de visibilité : aucune histoire ne dépasse 15 % des impressions
   * sur 12 mois. Au-delà, elle sort des suggestions — elle reste lisible,
   * cherchable, exportable. Elle cesse seulement d'être poussée.
   */
  async checkOverexposure(familyId: string, now = new Date()): Promise<string[]> {
    const since = monthsAgo(now, FORGOTTEN_AFTER_MONTHS);

    const logs = await this.prisma.visibilityLog.groupBy({
      by: ['storyId'],
      where: { familyId, shownAt: { gte: since } },
      _count: { storyId: true },
    });

    const totalImpressions = logs.reduce((sum, log) => sum + log._count.storyId, 0);
    if (totalImpressions === 0) return [];

    const overexposed: string[] = [];
    for (const log of logs) {
      const percentage = (log._count.storyId / totalImpressions) * 100;
      if (percentage > OVEREXPOSURE_THRESHOLD_PERCENT) {
        overexposed.push(log.storyId);
        await this.store.setex(overexposedKey(log.storyId), OVEREXPOSED_TTL_SECONDS, 'true');
      }
    }
    return overexposed;
  }

  async isOverexposed(storyId: string): Promise<boolean> {
    return (await this.store.get(overexposedKey(storyId))) === 'true';
  }

  /**
   * Rappel patrimonial : histoires non vues depuis 12 mois.
   * Résultat destiné au log et à la page Transmission — jamais injecté
   * d'office dans le flux (amendement 5).
   */
  async getForgottenStories(familyId: string, limit = 3, now = new Date()): Promise<Story[]> {
    const since = monthsAgo(now, FORGOTTEN_AFTER_MONTHS);
    return this.prisma.story.findMany({
      where: {
        familyId,
        archived: false,
        quarantined: false,
        OR: [{ lastViewedAt: { lt: since } }, { lastViewedAt: null }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Quarantaine — 3 rejets explicites.
   *
   * Le compteur est par membre : c'est ce membre qui a dit non trois fois.
   * La quarantaine retire l'histoire des suggestions, pas de la mémoire.
   */
  async processDismissal(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    context: VisibilityContext;
    reason?: string;
  }): Promise<{ quarantined: boolean; dismissalCount: number }> {
    await this.logVisibility({ ...params, dismissed: true });

    const key = dismissalKey(params.storyId, params.memberId);
    const count = await this.store.incr(key);
    await this.store.expire(key, DISMISSAL_TTL_SECONDS);

    if (count >= DISMISSAL_QUARANTINE_THRESHOLD) {
      await this.prisma.story.update({
        where: { id: params.storyId },
        data: {
          quarantined: true,
          quarantineReason:
            params.reason ?? `${DISMISSAL_QUARANTINE_THRESHOLD} rejets explicites par le même membre`,
        },
      });
      return { quarantined: true, dismissalCount: count };
    }

    return { quarantined: false, dismissalCount: count };
  }

  /** Sortie de quarantaine : décision familiale, toujours possible. */
  async releaseFromQuarantine(storyId: string): Promise<void> {
    await this.prisma.story.update({
      where: { id: storyId },
      data: { quarantined: false, quarantineReason: null },
    });
  }

  /**
   * Métrique de distorsion : écart entre la distribution des auteurs dans
   * le corpus et leur distribution dans les vues. 0 = fidèle, 100 = maximal.
   *
   * Elle est mesurée et affichée. Elle n'est pas corrigée : corriger, ce
   * serait imposer.
   */
  async calculateDistortion(familyId: string): Promise<number> {
    const [stories, views] = await Promise.all([
      this.prisma.story.findMany({ where: { familyId }, select: { authorId: true } }),
      this.prisma.visibilityLog.findMany({
        where: { familyId },
        select: { story: { select: { authorId: true } } },
      }),
    ]);

    if (stories.length === 0 || views.length === 0) return 0;

    const authorDistribution = countBy(stories.map((s) => s.authorId));
    const viewDistribution = countBy(views.map((v) => v.story.authorId));

    let distortion = 0;
    const authors = new Set([...authorDistribution.keys(), ...viewDistribution.keys()]);
    for (const author of authors) {
      const storyRatio = (authorDistribution.get(author) ?? 0) / stories.length;
      const viewRatio = (viewDistribution.get(author) ?? 0) / views.length;
      distortion += Math.abs(storyRatio - viewRatio);
    }

    return Math.round((distortion / 2) * 100);
  }

  async report(familyId: string, now = new Date()): Promise<ConservateurReport> {
    const since = monthsAgo(now, FORGOTTEN_AFTER_MONTHS);
    const [totalStories, invisibleStories, quarantinedStories, overexposed, distortionScore] =
      await Promise.all([
        this.prisma.story.count({ where: { familyId } }),
        this.prisma.story.count({
          where: {
            familyId,
            archived: false,
            OR: [{ lastViewedAt: { lt: since } }, { lastViewedAt: null }],
          },
        }),
        this.prisma.story.count({ where: { familyId, quarantined: true } }),
        this.checkOverexposure(familyId, now),
        this.calculateDistortion(familyId),
      ]);

    return {
      totalStories,
      invisibleStories,
      overexposedStories: overexposed.length,
      quarantinedStories,
      distortionScore,
    };
  }
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function monthsAgo(from: Date, months: number): Date {
  const date = new Date(from);
  date.setMonth(date.getMonth() - months);
  return date;
}

function overexposedKey(storyId: string) {
  return `conservateur:overexposed:${storyId}`;
}

function dismissalKey(storyId: string, memberId: string) {
  return `dismissal:${storyId}:${memberId}`;
}

export const conservateur = new ConservateurService();
