import type { PrismaClient, Tradition } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { monthDayOf } from '@/lib/normalize';

/**
 * Traditions — activation cyclique (§4.2, sprint 6).
 *
 * Une tradition ne notifie rien. Elle devient simplement active un jour donné ;
 * si personne ne la relève, elle s'endort. Le sommeil n'est pas un échec :
 * c'est le droit à l'oubli appliqué aux rituels (Constitution, §6).
 */

const SLEEP_AFTER_MISSED_YEARS = 3;

export class TraditionService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  /** Traditions actives aujourd'hui, selon leur périodicité. */
  async getActiveToday(familyId: string, now = new Date()): Promise<Tradition[]> {
    const traditions = await this.prisma.tradition.findMany({
      where: { familyId, isAsleep: false },
      orderBy: { name: 'asc' },
    });
    const monthDay = monthDayOf(now);

    return traditions.filter((tradition) => {
      switch (tradition.periodicity) {
        case 'annual':
          return tradition.monthDay === monthDay;
        case 'monthly':
          return tradition.monthDay?.split('-')[1] === monthDay.split('-')[1];
        case 'weekly':
          return tradition.weekDay === now.getDay();
        default:
          return false;
      }
    });
  }

  async activate(familyId: string, traditionId: string, now = new Date()): Promise<Tradition | null> {
    const tradition = await this.prisma.tradition.findFirst({ where: { id: traditionId, familyId } });
    if (!tradition) return null;

    return this.prisma.tradition.update({
      where: { id: traditionId },
      data: {
        lastActivatedAt: now,
        activationCount: { increment: 1 },
        isAsleep: false,
        sleepReason: null,
      },
    });
  }

  /** Endormissement explicite, ou par silence prolongé. */
  async sleep(familyId: string, traditionId: string, reason: string): Promise<void> {
    await this.prisma.tradition.updateMany({
      where: { id: traditionId, familyId },
      data: { isAsleep: true, sleepReason: reason },
    });
  }

  async wake(familyId: string, traditionId: string): Promise<void> {
    await this.prisma.tradition.updateMany({
      where: { id: traditionId, familyId },
      data: { isAsleep: false, sleepReason: null },
    });
  }

  /**
   * Passe en sommeil les traditions annuelles non relevées depuis 3 ans.
   * Réveillables à tout moment : la famille décide, pas l'algorithme.
   */
  async sleepDormantTraditions(familyId: string, now = new Date()): Promise<number> {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - SLEEP_AFTER_MISSED_YEARS);

    const result = await this.prisma.tradition.updateMany({
      where: {
        familyId,
        isAsleep: false,
        periodicity: 'annual',
        OR: [{ lastActivatedAt: { lt: cutoff } }, { lastActivatedAt: null, createdAt: { lt: cutoff } }],
      },
      data: {
        isAsleep: true,
        sleepReason: `Non relevée depuis ${SLEEP_AFTER_MISSED_YEARS} ans.`,
      },
    });
    return result.count;
  }
}

export const traditionService = new TraditionService();
