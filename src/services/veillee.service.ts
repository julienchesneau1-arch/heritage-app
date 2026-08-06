import type { PrismaClient, Story } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { store as defaultStore, type KeyValueStore } from '@/lib/redis';
import { ConservateurService, conservateur as defaultConservateur } from './conservateur.service';
import { estVraimentPremier } from '@/lib/honnetete';

/**
 * LA VEILLÉE — extension hors spec v1.0, assumée (§5.4).
 *
 * Trois récits, lus à voix haute, quand la famille est réunie. Puis une
 * question : « quelqu'un veut ajouter quelque chose ? »
 *
 * Pourquoi ce n'est pas de la gamification :
 *  - Rien ne la déclenche. Elle se demande. Aucune notification, aucun
 *    rappel, aucune série à ne pas rompre.
 *  - Elle a une fin. Trois récits, puis l'écran dit de poser le téléphone.
 *    Un flux infini optimiserait l'attention ; celui-ci la rend.
 *  - Aucun score, aucun classement, aucun badge. On ne gagne pas une
 *    veillée.
 *
 * Pourquoi elle a le droit de montrer les récits oubliés, alors que
 * l'amendement 5 l'interdit au Conservateur : cet amendement interdit
 * d'INJECTER un récit oublié dans le flux passif. Ici la famille demande
 * explicitement qu'on lui montre quelque chose. Ce n'est plus une
 * imposition algorithmique, c'est une réponse à une question posée.
 *
 * La veillée du jour est FIXÉE pour toute la famille : le premier qui
 * l'ouvre la détermine, les autres voient exactement la même chose. Deux
 * téléphones dans la même pièce doivent montrer les mêmes récits, sans
 * quoi il n'y a pas de veillée, seulement deux personnes qui lisent.
 */

export interface VeilleeEntry {
  storyId: string;
  justification: string;
}

export type VeilleeStory = Story & { author: { name: string; isDeleted: boolean } };

export interface Veillee {
  date: string;
  entries: Array<{ story: VeilleeStory; justification: string }>;
}

const VEILLEE_LENGTH = 3;

export class VeilleeService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private store: KeyValueStore = defaultStore,
    private conservateur: ConservateurService = defaultConservateur,
  ) {}

  async compose(familyId: string, now = new Date()): Promise<Veillee> {
    const date = dayKey(now);
    const key = `veillee:${familyId}:${date}`;

    let plan: VeilleeEntry[];
    const cached = await this.store.get(key);
    if (cached) {
      plan = JSON.parse(cached) as VeilleeEntry[];
    } else {
      plan = await this.select(familyId, now);
      await this.store.setex(key, secondsUntilMorning(now), JSON.stringify(plan));
    }

    const stories = await this.prisma.story.findMany({
      where: { id: { in: plan.map((entry) => entry.storyId) }, familyId },
      include: { author: { select: { name: true, isDeleted: true } } },
    });

    // L'ordre du plan fait foi : c'est celui que la famille suit à voix haute.
    const byId = new Map(stories.map((story) => [story.id, story as VeilleeStory]));
    return {
      date,
      entries: plan
        .map((entry) => ({ story: byId.get(entry.storyId), justification: entry.justification }))
        .filter((entry): entry is { story: VeilleeStory; justification: string } => Boolean(entry.story)),
    };
  }

  /**
   * Trois places, trois raisons différentes d'être là. Chacune est dite à
   * la famille : une exclusion doit être défendable (Constitution, §3).
   *
   * Si le corpus ne fournit pas trois récits, la veillée en compte moins.
   * On ne complète jamais avec du remplissage.
   */
  private async select(familyId: string, now: Date): Promise<VeilleeEntry[]> {
    const entries: VeilleeEntry[] = [];
    const taken = new Set<string>();
    const base = { familyId, archived: false, quarantined: false, suspendedAt: null };

    // 1. Celui que personne n'a relu. La veillée est sa seule chance d'être dit.
    const forgotten = await this.conservateur.getForgottenStories(familyId, 1, now);
    const oublie = forgotten[0];
    if (oublie) {
      entries.push({
        storyId: oublie.id,
        justification: oublie.lastViewedAt
          ? `Personne ne l'a relu depuis le ${oublie.lastViewedAt.toISOString().split('T')[0]}.`
          : `Ce récit n'a jamais été relu depuis qu'il a été écrit.`,
      });
      taken.add(oublie.id);
    }

    // 2. Celui qui relie le plus de monde et de choses.
    //
    // On en demande DEUX pour savoir si le premier est vraiment le premier.
    // Quand plusieurs récits relient autant d'éléments, en désigner un « le
    // plus relié » est une affirmation fausse : le classement n'a pas
    // départagé, il a simplement rendu le premier venu. On dit alors le
    // fait — combien d'éléments il relie — sans le superlatif.
    const candidats = await this.prisma.story.findMany({
      where: { ...base, id: { notIn: [...taken] } },
      orderBy: [{ linkedEntities: { _count: 'desc' } }, { createdAt: 'asc' }],
      include: { _count: { select: { linkedEntities: true } } },
      take: 2,
    });

    const rassemble = candidats[0];
    if (rassemble && rassemble._count.linkedEntities > 0) {
      const liens = rassemble._count.linkedEntities;
      // Amendement 6, clause 3 : on a demandé DEUX candidats pour pouvoir
      // vérifier le superlatif avant de l'énoncer.
      const exAequo = !estVraimentPremier(candidats.map((c) => c._count.linkedEntities));

      entries.push({
        storyId: rassemble.id,
        justification: exAequo
          ? `Il relie ${liens} personnes, lieux ou objets de la famille — comme d'autres récits ; celui-ci a été retenu.`
          : `C'est le récit qui relie le plus de personnes, de lieux et d'objets de la famille (${liens}).`,
      });
      taken.add(rassemble.id);
    }

    // 3. Le dernier arrivé. Une veillée n'est pas qu'un exercice de nostalgie.
    const [dernier] = await this.prisma.story.findMany({
      where: { ...base, id: { notIn: [...taken] } },
      // Clé secondaire : deux récits créés à la même seconde doivent donner
      // le même choix d'un appareil à l'autre, sinon la veillée cesse d'être
      // la même pour toute la famille.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 1,
    });
    if (dernier) {
      entries.push({
        storyId: dernier.id,
        justification: `C'est le récit le plus récemment ajouté à la mémoire de la famille.`,
      });
      taken.add(dernier.id);
    }

    return entries.slice(0, VEILLEE_LENGTH);
  }
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * La veillée tient jusqu'au lendemain matin, pas jusqu'à minuit : une
 * soirée qui déborde sur une heure du matin est la même soirée.
 */
function secondsUntilMorning(now: Date): number {
  const morning = new Date(now);
  morning.setHours(5, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return Math.max(3600, Math.round((morning.getTime() - now.getTime()) / 1000));
}

export const veilleeService = new VeilleeService();
