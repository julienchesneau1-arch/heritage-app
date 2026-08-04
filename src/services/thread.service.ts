import type { Message, PrismaClient, Thread } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * LE FIL — extension hors spec v1.0, assumée.
 *
 * Le modèle `Conversation` qu'il remplace tenait en deux verrous : une
 * conversation ne pouvait naître que d'un récit DÉJÀ ÉCRIT, et elle
 * n'admettait qu'une seule réponse. Conséquence : la page blanche gardait
 * l'entrée du produit — pour dire trois mots sur la montre de Robert, il
 * fallait d'abord que quelqu'un rédige un récit — et le troisième
 * intervenant n'avait nulle part où parler.
 *
 * La primitive de la spec est pourtant « une histoire doit engendrer une
 * autre histoire ». Ce fil la sert mieux que la page de rédaction : on parle
 * à plusieurs, à peu de frais, et le récit se CONDENSE ensuite. Le livre
 * devient la sortie, plus jamais l'entrée.
 *
 * ── Ce qu'on refuse, et qui n'est pas négociable ──
 *
 * La forme vient des salons de discussion ; le moteur de ces produits, non.
 * Sont interdits ici, et testés comme tels (§6.1, §12) :
 *  - le compteur de non-lus,
 *  - la présence (« en ligne », « est en train d'écrire »),
 *  - la notification, l'interpellation générale,
 *  - le décompte de réactions, qui est un score,
 *  - l'affichage de l'inactivité (« personne n'a parlé depuis trois
 *    semaines ») : un fil montre ce qu'il contient, jamais ce qui lui
 *    manque. Dix messages par mois, c'est une famille — pas un échec.
 */

export type ThreadAnchor =
  | { kind: 'entity'; entityId: string }
  | { kind: 'story'; storyId: string }
  | { kind: 'none' };

export interface PostInput {
  familyId: string;
  authorId: string;
  body: string;
  /** Qui a PARLÉ, quand ce n'est pas qui a tapé. */
  narratorId?: string | null;
  /** Vingt secondes de voix valent mieux qu'un paragraphe jamais écrit. */
  archiveId?: string | null;
  isQuestion?: boolean;
}

export type ThreadWithMessages = Thread & {
  messages: Array<
    Message & {
      author: { id: string; name: string; isDeleted: boolean };
      narrator: { id: string; name: string } | null;
      marks: Array<{ kind: string; member: { id: string; name: string } }>;
    }
  >;
};

/** Vocabulaire fermé des marques. Des faits, jamais des avis. */
export const MARK_KINDS = ['WITNESS', 'REMEMBER', 'LEARNED'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const MARK_LABELS: Record<MarkKind, string> = {
  WITNESS: 'J’y étais',
  REMEMBER: 'Je m’en souviens',
  LEARNED: 'Je ne savais pas',
};

const MESSAGE_PAGE = 200;

export class ThreadService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  /** Ouvrir un fil, c'est déjà y parler : un fil vide n'existe pas. */
  async open(anchor: ThreadAnchor, input: PostInput, title?: string): Promise<Thread> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: {
          familyId: input.familyId,
          entityId: anchor.kind === 'entity' ? anchor.entityId : null,
          storyId: anchor.kind === 'story' ? anchor.storyId : null,
          title: title ?? null,
          openedById: input.authorId,
          messageCount: 1,
          lastMessageAt: now,
        },
      });
      await tx.message.create({ data: messageData(thread.id, input, now) });
      return thread;
    });
  }

  async reply(threadId: string, input: PostInput): Promise<Message> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const thread = await tx.thread.findFirst({
        where: { id: threadId, familyId: input.familyId },
        select: { id: true },
      });
      if (!thread) throw new Error('Fil introuvable dans cette famille.');

      const message = await tx.message.create({ data: messageData(threadId, input, now) });
      // Le compteur et la date sont dénormalisés : ils bougent dans la même
      // transaction que le message, sinon ils mentent dès le premier incident.
      await tx.thread.update({
        where: { id: threadId },
        data: { messageCount: { increment: 1 }, lastMessageAt: now },
      });
      return message;
    });
  }

  /** Les fils d'une entité — c'est ce que le graphe ouvre. */
  async forEntity(familyId: string, entityId: string, take = 20): Promise<ThreadWithMessages[]> {
    return this.prisma.thread.findMany({
      where: { familyId, entityId },
      orderBy: { lastMessageAt: 'desc' },
      take,
      include: threadInclude(),
    }) as Promise<ThreadWithMessages[]>;
  }

  async forStory(familyId: string, storyId: string, take = 20): Promise<ThreadWithMessages[]> {
    return this.prisma.thread.findMany({
      where: { familyId, storyId },
      orderBy: { createdAt: 'asc' },
      take,
      include: threadInclude(),
    }) as Promise<ThreadWithMessages[]>;
  }

  async byId(familyId: string, threadId: string): Promise<ThreadWithMessages | null> {
    return this.prisma.thread.findFirst({
      where: { id: threadId, familyId },
      include: threadInclude(),
    }) as Promise<ThreadWithMessages | null>;
  }

  /**
   * Une marque se pose et se retire. Elle n'est jamais comptée : on rend
   * des noms, et l'appelant affiche « Jeanne y était », pas « 3 ».
   */
  async mark(messageId: string, memberId: string, kind: MarkKind): Promise<void> {
    await this.prisma.messageMark.upsert({
      where: { messageId_memberId_kind: { messageId, memberId, kind } },
      create: { messageId, memberId, kind },
      update: {},
    });
  }

  async unmark(messageId: string, memberId: string, kind: MarkKind): Promise<void> {
    await this.prisma.messageMark.deleteMany({ where: { messageId, memberId, kind } });
  }

  /**
   * Les fils ouverts par une question et restés seuls.
   *
   * C'est le vide informationnel le plus pur du produit : il n'a pas été
   * déduit d'un texte, quelqu'un l'a formulé. Le Passeur vient le chercher
   * ici. On exclut les fils du membre lui-même : on ne renvoie à personne
   * sa propre question.
   */
  async unanswered(familyId: string, exceptMemberId: string, take = 10) {
    return this.prisma.thread.findMany({
      where: {
        familyId,
        messageCount: 1,
        openedById: { not: exceptMemberId },
        messages: { some: { isQuestion: true } },
      },
      orderBy: { createdAt: 'asc' },
      take,
      include: {
        openedBy: { select: { id: true, name: true } },
        entity: { select: { id: true, name: true } },
        story: { select: { id: true, title: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
  }

  /**
   * Ce que la famille a dit dans un fil, prêt à être condensé en récit.
   *
   * Le service ne rédige rien : il rend la matière et la provenance. La
   * cristallisation est proposée à un humain, qui valide — même chaîne que
   * pour une transcription (§3.5), et pour la même raison : la machine
   * assemble, elle ne décide pas de ce que la famille a voulu dire.
   */
  async material(familyId: string, threadId: string) {
    const thread = await this.byId(familyId, threadId);
    if (!thread) return null;

    const speakers = new Map<string, string>();
    for (const message of thread.messages) {
      const speaker = message.narrator ?? message.author;
      speakers.set(speaker.id, speaker.name);
    }

    return {
      thread,
      /** Qui a parlé — narrateur d'abord, scribe seulement à défaut. */
      speakers: [...speakers.entries()].map(([id, name]) => ({ id, name })),
      transcript: thread.messages
        .map((message) => `${(message.narrator ?? message.author).name} : ${message.body}`)
        .join('\n'),
    };
  }

  /** Le récit né du fil. Le fil demeure : il est la provenance. */
  async attachCrystallized(threadId: string, storyId: string): Promise<void> {
    await this.prisma.thread.update({
      where: { id: threadId },
      data: { crystallizedStoryId: storyId },
    });
  }
}

function messageData(threadId: string, input: PostInput, now: Date) {
  return {
    threadId,
    familyId: input.familyId,
    authorId: input.authorId,
    narratorId: input.narratorId ?? null,
    body: input.body,
    archiveId: input.archiveId ?? null,
    isQuestion: input.isQuestion ?? false,
    createdAt: now,
  };
}

function threadInclude() {
  return {
    messages: {
      orderBy: { createdAt: 'asc' as const },
      take: MESSAGE_PAGE,
      include: {
        author: { select: { id: true, name: true, isDeleted: true } },
        narrator: { select: { id: true, name: true } },
        marks: { include: { member: { select: { id: true, name: true } } } },
      },
    },
  };
}

export const threadService = new ThreadService();
