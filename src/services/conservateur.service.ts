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

/**
 * Le seuil de 15 % de la spec suppose un corpus fourni. Sur une famille de
 * cinq récits, la part moyenne de chacun est déjà de 20 % : tous seraient
 * déclarés sur-exposés dès les premières lectures, et le Passeur n'aurait
 * plus rien à proposer. Le seuil ne peut donc pas être absolu.
 *
 * On retient le double de la part uniforme, avec 15 % pour plancher :
 * un récit n'est sur-exposé que s'il capte deux fois ce qu'il capterait
 * si l'attention était également répartie.
 */
export function overexposureThreshold(storiesCount: number): number {
  if (storiesCount <= 0) return 100;
  return Math.max(OVEREXPOSURE_THRESHOLD_PERCENT, (200 / storiesCount));
}
export const FORGOTTEN_AFTER_MONTHS = 12;
export const DISMISSAL_QUARANTINE_THRESHOLD = 3;

const OVEREXPOSED_TTL_SECONDS = 30 * 86_400;
const DISMISSAL_TTL_SECONDS = 90 * 86_400;
const VIEW_DEDUPE_SECONDS = 30 * 60;

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

  /**
   * Une lecture effective : compteur + date de dernière vue.
   *
   * Dédupliquée par membre et par récit sur 30 minutes. Ce n'est pas une
   * optimisation : le budget de visibilité se calcule sur ces journaux, donc
   * sans déduplication, un membre qui rafraîchit sa page pousse le récit
   * au-delà des 15 % et le fait sortir des suggestions. L'algorithme
   * sanctionnerait une histoire pour un appui sur F5.
   */
  async registerView(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    context: VisibilityContext;
  }): Promise<boolean> {
    const key = viewKey(params.storyId, params.memberId);
    if (await this.store.get(key)) return false;
    await this.store.setex(key, VIEW_DEDUPE_SECONDS, 'true');

    await this.logVisibility(params);
    await this.prisma.story.update({
      where: { id: params.storyId },
      data: { views: { increment: 1 }, lastViewedAt: new Date() },
    });
    return true;
  }

  /**
   * Budget de visibilité : aucune histoire ne dépasse 15 % des impressions
   * sur 12 mois. Au-delà, elle sort des suggestions — elle reste lisible,
   * cherchable, exportable. Elle cesse seulement d'être poussée.
   */
  async checkOverexposure(familyId: string, now = new Date()): Promise<string[]> {
    const since = monthsAgo(now, FORGOTTEN_AFTER_MONTHS);

    const [logs, storiesCount] = await Promise.all([
      this.prisma.visibilityLog.groupBy({
        by: ['storyId'],
        where: { familyId, shownAt: { gte: since } },
        _count: { storyId: true },
      }),
      this.prisma.story.count({ where: { familyId, archived: false } }),
    ]);

    const totalImpressions = logs.reduce((sum, log) => sum + log._count.storyId, 0);
    if (totalImpressions === 0) return [];

    const threshold = overexposureThreshold(storiesCount);
    const overexposed: string[] = [];
    for (const log of logs) {
      const percentage = (log._count.storyId / totalImpressions) * 100;
      if (percentage > threshold) {
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
   * Quarantaine — 3 rejets explicites, POUR CE MEMBRE.
   *
   * La spec comptait par membre mais appliquait globalement : trois refus
   * d'Emma faisaient taire le récit pour Jeanne, qui n'avait rien demandé.
   * Un membre peut décider de ne plus voir un récit ; il ne peut pas
   * décider à la place des autres. La mise en sourdine est donc portée par
   * le couple (récit, membre), et reste réversible.
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
      const reason =
        params.reason ?? `${DISMISSAL_QUARANTINE_THRESHOLD} rejets explicites par ce membre`;
      await this.prisma.storyMute.upsert({
        where: { storyId_memberId: { storyId: params.storyId, memberId: params.memberId } },
        update: { reason },
        create: {
          familyId: params.familyId,
          storyId: params.storyId,
          memberId: params.memberId,
          reason,
        },
      });
      return { quarantined: true, dismissalCount: count };
    }

    return { quarantined: false, dismissalCount: count };
  }

  /** Les récits qu'un membre a fait taire pour lui-même. */
  async mutedStoryIds(familyId: string, memberId: string): Promise<string[]> {
    const mutes = await this.prisma.storyMute.findMany({
      where: { familyId, memberId },
      select: { storyId: true },
    });
    return mutes.map((mute) => mute.storyId);
  }

  /** Sortie de sourdine : décision du membre concerné, toujours possible. */
  async releaseFromQuarantine(storyId: string, memberId: string): Promise<void> {
    await this.prisma.storyMute.deleteMany({ where: { storyId, memberId } });
  }

  /**
   * Métrique de distorsion : écart entre la distribution des voix dans
   * le corpus et leur distribution dans les vues. 0 = fidèle, 100 = maximal.
   *
   * On compte le NARRATEUR quand il existe, l'auteur sinon. Compter celui
   * qui a tenu le clavier ferait disparaître de la mesure ceux qui ne
   * tapent pas — les plus âgés, les plus jeunes — c'est-à-dire précisément
   * ceux dont le silence serait le plus grave.
   *
   * Elle est mesurée et affichée. Elle n'est pas corrigée : corriger, ce
   * serait imposer.
   */
  async calculateDistortion(familyId: string, now = new Date()): Promise<number> {
    // Les impressions sont AGRÉGÉES en base et bornées à 12 mois, comme le
    // reste du Conservateur. La version précédente chargeait chaque ligne du
    // journal en mémoire : sur une famille active depuis dix ans, c'était
    // des centaines de milliers d'enregistrements à chaque ouverture de la
    // page Transmission. Le coût est désormais celui du nombre de récits.
    const since = monthsAgo(now, FORGOTTEN_AFTER_MONTHS);

    const [stories, impressions] = await Promise.all([
      this.prisma.story.findMany({
        where: { familyId },
        select: { id: true, authorId: true, narratorId: true },
      }),
      this.prisma.visibilityLog.groupBy({
        by: ['storyId'],
        where: { familyId, shownAt: { gte: since } },
        _count: { storyId: true },
      }),
    ]);

    const voiceByStory = new Map(stories.map((story) => [story.id, voiceOf(story)]));

    // Un récit supprimé laisse ses impressions au journal. Les compter au
    // dénominateur sans pouvoir les attribuer à une voix créerait une
    // distorsion qui n'existe pas : on les écarte des deux côtés.
    const viewDistribution = new Map<string, number>();
    let totalViews = 0;
    for (const row of impressions) {
      const voice = voiceByStory.get(row.storyId);
      if (!voice) continue;
      viewDistribution.set(voice, (viewDistribution.get(voice) ?? 0) + row._count.storyId);
      totalViews += row._count.storyId;
    }

    if (stories.length === 0 || totalViews === 0) return 0;
    const corpusDistribution = countBy(stories.map(voiceOf));

    let distortion = 0;
    const voices = new Set([...corpusDistribution.keys(), ...viewDistribution.keys()]);
    for (const voice of voices) {
      const corpusRatio = (corpusDistribution.get(voice) ?? 0) / stories.length;
      const viewRatio = (viewDistribution.get(voice) ?? 0) / totalViews;
      distortion += Math.abs(corpusRatio - viewRatio);
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
        this.prisma.storyMute.count({ where: { familyId } }),
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

/** La voix d'un récit : celui qui l'a raconté, ou à défaut celui qui l'a saisi. */
function voiceOf(story: { authorId: string; narratorId: string | null }): string {
  return story.narratorId ?? story.authorId;
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

function viewKey(storyId: string, memberId: string) {
  return `view:${storyId}:${memberId}`;
}

function dismissalKey(storyId: string, memberId: string) {
  return `dismissal:${storyId}:${memberId}`;
}

export const conservateur = new ConservateurService();
