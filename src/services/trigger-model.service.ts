import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { store, type KeyValueStore } from '@/lib/redis';
import { monthDayOf } from '@/lib/normalize';

/**
 * TRIGGER MODEL SERVICE — §3.1.
 *
 * Mission : détecter quand le présent active le passé.
 *
 * Entrées autorisées : dates déclarées dans l'app, actions explicites dans
 * l'app, données saisies par l'utilisateur.
 * Entrées interdites : GPS, appels, SMS, activité d'autres apps, toute donnée
 * externe non déclarée. Ce service ne lit que la base de la famille — c'est
 * la garantie technique de cette règle.
 */

export type TriggerType = 'TEMPORAL' | 'TRADITION' | 'ANNIVERSARY' | 'RECENT_ACTIVITY' | 'PASSIVE';

export interface TriggerSignal {
  type: TriggerType;
  priority: number; // 1-5, 5 = le plus fort
  payload: {
    storyId?: string;
    traditionId?: string;
    message: string;
    justification: string; // pourquoi maintenant ?
  };
}

const MUTE_DAYS = 30;
const MUTE_THRESHOLD = 3;

export class TriggerModelService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private store: KeyValueStore = defaultStore(),
  ) {}

  /**
   * Renvoie AU PLUS un signal. La parcimonie n'est pas une préférence
   * d'affichage : elle est appliquée ici, à la source.
   */
  async generateSignals(familyId: string, memberId: string, now = new Date()): Promise<TriggerSignal[]> {
    const signals: TriggerSignal[] = [];
    const monthDay = monthDayOf(now);

    // 1. Tradition du jour.
    const tradition = await this.prisma.tradition.findFirst({
      where: { familyId, monthDay, isAsleep: false },
    });
    if (tradition) {
      signals.push({
        type: 'TRADITION',
        priority: 5,
        payload: {
          traditionId: tradition.id,
          message: `Aujourd'hui : « ${tradition.name} »`,
          justification: `Cette tradition familiale est associée au ${monthDay}.`,
        },
      });
    }

    // 2. Anniversaires de naissance et de décès.
    const members = await this.prisma.member.findMany({ where: { familyId, isDeleted: false } });
    for (const member of members) {
      if (member.birthDate && monthDayOf(member.birthDate) === monthDay) {
        const age = now.getFullYear() - member.birthDate.getFullYear();
        signals.push({
          type: 'ANNIVERSARY',
          priority: 4,
          payload: {
            message: member.deathDate
              ? `Aujourd'hui, ${member.name} aurait eu ${age} ans.`
              : `Aujourd'hui, ${member.name} a ${age} ans.`,
            justification: `Date de naissance enregistrée : ${isoDay(member.birthDate)}.`,
          },
        });
      }
      if (member.deathDate && monthDayOf(member.deathDate) === monthDay) {
        const yearsSince = now.getFullYear() - member.deathDate.getFullYear();
        signals.push({
          type: 'ANNIVERSARY',
          priority: 5,
          payload: {
            message: `Il y a ${yearsSince} ${plural(yearsSince, 'an', 'ans')}, ${member.name} nous quittait.`,
            justification: `Date de décès enregistrée : ${isoDay(member.deathDate)}.`,
          },
        });
      }
    }

    // 3. « Il y a X ans » — un récit raconté ce jour-là, une année antérieure.
    //
    // Cette recherche chargeait TOUS les récits actifs de la famille pour n'en
    // retenir, en moyenne, aucun : un balayage complet du corpus sur l'écran
    // le plus ouvert du produit. Le tri par jour-mois se dit très bien en SQL.
    // On n'en garde que trois : la parcimonie n'en affichera qu'un.
    const anniversaires = await this.storiesOnThisDay(familyId, now);
    for (const story of anniversaires) {
      const years = now.getFullYear() - story.createdAt.getFullYear();
      signals.push({
        type: 'TEMPORAL',
        priority: 3,
        payload: {
          storyId: story.id,
          message: `Il y a ${years} ${plural(years, 'an', 'ans')}, « ${story.title} » a été raconté.`,
          justification: `Date de création de l'histoire : ${isoDay(story.createdAt)}.`,
        },
      });
    }

    // Un type de signal fermé 3 fois de suite est muet pendant 30 jours.
    // Le filtre passe AVANT le repli passif : un membre qui a fait taire tous
    // les signaux du jour doit retrouver l'écran neutre, pas un écran vide.
    const allowed: TriggerSignal[] = [];
    for (const signal of signals) {
      if (!(await this.isMuted(familyId, memberId, signal.type))) allowed.push(signal);
    }

    // 4. Signal passif — uniquement s'il ne reste rien à dire.
    if (allowed.length === 0) {
      const family = await this.prisma.family.findUnique({ where: { id: familyId } });
      allowed.push({
        type: 'PASSIVE',
        priority: 1,
        payload: {
          message: `La mémoire de la famille ${family?.name ?? ''}`.trim(),
          justification: `Aucun événement temporel aujourd'hui. Affichage par défaut.`,
        },
      });
    }

    // RÈGLE DE PARCIMONIE : 1 signal max sur l'écran d'accueil.
    return allowed.sort((a, b) => b.priority - a.priority).slice(0, 1);
  }

  async generateSignal(familyId: string, memberId: string, now = new Date()): Promise<TriggerSignal | null> {
    const [signal] = await this.generateSignals(familyId, memberId, now);
    return signal ?? null;
  }

  /**
   * Les récits créés un 15 octobre d'une année passée. Le filtre jour-mois
   * n'est pas exprimable dans le `where` de Prisma : il passe par du SQL,
   * borné et paramétré.
   */
  private async storiesOnThisDay(
    familyId: string,
    now: Date,
  ): Promise<Array<{ id: string; title: string; createdAt: Date }>> {
    return this.prisma.$queryRaw<Array<{ id: string; title: string; createdAt: Date }>>`
      SELECT id, title, created_at AS "createdAt"
      FROM stories
      WHERE family_id = ${familyId}
        AND archived = false
        AND quarantined = false
        AND EXTRACT(MONTH FROM created_at) = ${now.getMonth() + 1}
        AND EXTRACT(DAY   FROM created_at) = ${now.getDate()}
        AND EXTRACT(YEAR  FROM created_at) < ${now.getFullYear()}
      ORDER BY created_at ASC
      LIMIT 3
    `;
  }

  /** L'utilisateur ferme un signal. Trois fermetures = silence de 30 jours. */
  async dismissSignalType(familyId: string, memberId: string, type: TriggerType): Promise<void> {
    const key = counterKey(familyId, memberId, type);
    const count = await this.store.incr(key);
    await this.store.expire(key, MUTE_DAYS * 86_400);
    if (count >= MUTE_THRESHOLD) {
      await this.store.setex(muteKey(familyId, memberId, type), MUTE_DAYS * 86_400, 'true');
      await this.store.del(key);
    }
  }

  private async isMuted(familyId: string, memberId: string, type: TriggerType): Promise<boolean> {
    return (await this.store.get(muteKey(familyId, memberId, type))) === 'true';
  }
}

function defaultStore(): KeyValueStore {
  return store;
}

function counterKey(familyId: string, memberId: string, type: string) {
  return `trigger:dismiss:${familyId}:${memberId}:${type}`;
}

function muteKey(familyId: string, memberId: string, type: string) {
  return `trigger:muted:${familyId}:${memberId}:${type}`;
}

function isoDay(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

function plural(count: number, one: string, many: string): string {
  return count > 1 ? many : one;
}
