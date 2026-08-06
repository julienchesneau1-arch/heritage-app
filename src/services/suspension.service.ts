import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * LA SUSPENSION — par accord de l'auteur, jamais par objection.
 *
 * ── La décision, et pourquoi elle est ainsi ──
 *
 * Claire écrit quelque chose de vrai et de blessant sur Jeanne. Jeanne
 * n'est ni l'auteur ni le narrateur : elle ne peut pas supprimer, ce sont
 * les mots de Claire. Trois politiques étaient possibles ; deux trahissent.
 *
 *  · « L'auteur garde toujours » : le produit peut servir à exposer.
 *  · « L'objection efface toujours » : le produit sert à faire taire — et
 *    dans une famille, celui qui peut exiger le silence est rarement celui
 *    qui souffre le plus.
 *  · La suspension AUTOMATIQUE dès l'objection, qui fut ma première
 *    recommandation, contredit la §2.6 — « un membre peut décider de ne
 *    plus voir un récit ; il ne peut pas décider à la place des autres ».
 *    Elle est un veto avec des étapes en plus.
 *
 * Retenu : la demande est portée, nommément ; **seul l'auteur suspend**.
 *
 * Ce que cela AJOUTE réellement — car ce n'est pas un lot de consolation.
 * Jusqu'ici, un auteur qui voulait accommoder quelqu'un n'avait qu'une
 * option : SUPPRIMER. C'est irréversible, et cela détruit les `Passage`,
 * donc la chaîne de transmission — la seule chose que le produit mesure.
 * Suspendre est un geste plus doux sur ses propres mots : réversible, et
 * qui ne détruit rien.
 *
 * ── Possession contre publication ──
 *
 * Un récit suspendu disparaît des pages, de la recherche, du Passeur, de
 * la veillée, du graphe et du LIVRE — tout ce qui circule. Il reste dans
 * l'EXPORT : la famille possède ses données (amendement 3), ce qui ne veut
 * pas dire que tout doit s'afficher. La frontière existait déjà pour les
 * récits archivés et mis en quarantaine ; on s'y range.
 */

/**
 * Le filtre à poser sur toute requête qui ALIMENTE UN AFFICHAGE.
 *
 * Exporté comme une constante plutôt que recopié : un filtre écrit à la
 * main dans quinze endroits est un filtre oublié dans le seizième.
 */
export const VISIBLE = { suspendedAt: null } as const;

export class SuspensionService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  /**
   * Demander la suspension. Ne suspend rien.
   *
   * Ni l'auteur ni le narrateur ne demandent : ils peuvent déjà agir sur
   * leurs propres mots — corriger, archiver, supprimer, et suspendre.
   */
  async demander(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    motif?: string;
  }): Promise<{ demande: boolean; raison?: 'introuvable' | 'auteur' | 'deja' }> {
    const story = await this.prisma.story.findFirst({
      where: { id: params.storyId, familyId: params.familyId },
      select: { id: true, authorId: true, narratorId: true },
    });
    if (!story) return { demande: false, raison: 'introuvable' };
    if (story.authorId === params.memberId || story.narratorId === params.memberId) {
      return { demande: false, raison: 'auteur' };
    }

    const deja = await this.prisma.suspensionRequest.findUnique({
      where: { storyId_memberId: { storyId: story.id, memberId: params.memberId } },
      select: { id: true },
    });
    if (deja) return { demande: false, raison: 'deja' };

    await this.prisma.suspensionRequest.create({
      data: {
        familyId: params.familyId,
        storyId: story.id,
        memberId: params.memberId,
        motif: params.motif?.trim() || null,
      },
    });
    return { demande: true };
  }

  /** Retirer sa demande. Par celui qui l'a posée, et lui seul. */
  async retirerLaDemande(familyId: string, storyId: string, memberId: string): Promise<boolean> {
    const result = await this.prisma.suspensionRequest.deleteMany({
      where: { familyId, storyId, memberId },
    });
    return result.count > 0;
  }

  /** Les demandes reçues sur un récit. L'auteur seul a besoin de les voir. */
  async demandes(familyId: string, storyId: string) {
    const demandes = await this.prisma.suspensionRequest.findMany({
      where: { familyId, storyId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        motif: true,
        memberId: true,
        member: { select: { name: true, isDeleted: true } },
      },
    });

    return demandes.map((d) => ({
      id: d.id,
      memberId: d.memberId,
      // §2.1 règle 1 : anonymisé partout, sans exception.
      parQui: d.member.isDeleted ? 'Membre anonymisé' : d.member.name,
      motif: d.motif,
    }));
  }

  /**
   * Suspendre. **Seul l'auteur ou le narrateur** — c'est-à-dire ceux à qui
   * ces mots appartiennent, exactement comme pour la suppression (§2.1
   * règle 2 amendée).
   */
  async suspendre(params: {
    familyId: string;
    storyId: string;
    memberId: string;
    pourQui: string;
  }): Promise<{ suspendu: boolean; raison?: 'introuvable' | 'autorite' }> {
    const story = await this.prisma.story.findFirst({
      where: { id: params.storyId, familyId: params.familyId },
      select: { id: true, authorId: true, narratorId: true },
    });
    if (!story) return { suspendu: false, raison: 'introuvable' };
    if (story.authorId !== params.memberId && story.narratorId !== params.memberId) {
      return { suspendu: false, raison: 'autorite' };
    }

    await this.prisma.story.update({
      where: { id: story.id },
      data: { suspendedAt: new Date(), suspendedForId: params.pourQui },
    });
    return { suspendu: true };
  }

  /** Remettre le récit. Réversible, c'est tout l'intérêt sur la suppression. */
  async remettre(familyId: string, storyId: string, memberId: string): Promise<boolean> {
    const story = await this.prisma.story.findFirst({
      where: { id: storyId, familyId },
      select: { id: true, authorId: true, narratorId: true },
    });
    if (!story || (story.authorId !== memberId && story.narratorId !== memberId)) return false;

    await this.prisma.story.update({
      where: { id: story.id },
      data: { suspendedAt: null, suspendedForId: null },
    });
    return true;
  }
}

export const suspensionService = new SuspensionService();
