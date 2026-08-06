import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { searchTextOf } from './story.service';

/**
 * Restauration d'une sauvegarde.
 *
 * L'amendement 3 dit que la famille possède ses données. L'export seul ne
 * le tient qu'à moitié : elle pouvait les emporter, pas les remettre. Une
 * mémoire qu'on ne peut pas restaurer après une erreur, un changement
 * d'hébergeur ou une fin de service n'appartient pas vraiment à personne.
 *
 * L'import crée TOUJOURS une nouvelle famille. Il ne fusionne pas, il
 * n'écrase pas : deux mémoires qui se recouvrent partiellement ne se
 * réconcilient pas automatiquement, et se tromper ici coûterait des récits.
 * Les identifiants sont remappés, ce qui permet de restaurer dans la base
 * qui contient déjà l'original.
 */

export interface ImportResult {
  familyId: string;
  familyName: string;
  counts: Record<string, number>;
}

export class ImportService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  async importFamily(payload: unknown): Promise<ImportResult | { error: string }> {
    const data = payload as Record<string, unknown>;
    if (!data || typeof data !== 'object') return { error: 'Fichier illisible.' };
    if (typeof data.format !== 'string' || !data.format.startsWith('heritage-export/')) {
      return { error: 'Ce fichier n’est pas un export Héritage.' };
    }

    const family = data.family as { name?: string } | undefined;
    if (!family?.name) return { error: 'Export sans famille.' };

    const members = asArray(data.members);
    const stories = asArray(data.stories);
    if (members.length === 0) return { error: 'Export sans aucun membre.' };

    const created = await this.prisma.family.create({ data: { name: `${family.name} (restaurée)` } });

    // Remappage : les identifiants d'origine peuvent déjà exister en base.
    const memberIds = new Map<string, string>();
    for (const member of members) {
      const row = await this.prisma.member.create({
        data: {
          familyId: created.id,
          name: str(member.name) ?? 'Membre sans nom',
          generation: num(member.generation) ?? 1,
          birthDate: date(member.birthDate),
          deathDate: date(member.deathDate),
          role: str(member.role),
          isDeleted: member.isDeleted === true,
        },
      });
      memberIds.set(str(member.id) ?? row.id, row.id);
    }

    const entityIds = new Map<string, string>();
    for (const entity of asArray(data.entities)) {
      const normalizedName = str(entity.normalizedName);
      const type = str(entity.type);
      if (!normalizedName || !type) continue;
      const row = await this.prisma.entity.upsert({
        where: { familyId_normalizedName_type: { familyId: created.id, normalizedName, type } },
        update: {},
        create: {
          familyId: created.id,
          type,
          name: str(entity.name) ?? normalizedName,
          normalizedName,
          description: str(entity.description),
          memberId: mapped(memberIds, entity.memberId),
        },
      });
      entityIds.set(str(entity.id) ?? row.id, row.id);
    }

    const storyIds = new Map<string, string>();
    for (const story of stories) {
      const authorId = mapped(memberIds, story.authorId);
      if (!authorId) continue; // un récit sans auteur connu ne peut pas être rattaché
      const title = str(story.title) ?? 'Sans titre';
      const content = str(story.content) ?? '';

      const linked = asArray(story.linkedEntities)
        .map((entity) => mapped(entityIds, entity.id))
        .filter((id): id is string => Boolean(id));

      const row = await this.prisma.story.create({
        data: {
          familyId: created.id,
          authorId,
          narratorId: mapped(memberIds, story.narratorId),
          title,
          content,
          structureType: str(story.structureType) ?? 'evenement-marquant',
          searchText: searchTextOf(title, content),
          tone: str(story.tone) ?? 'factuel',
          length: str(story.length) ?? 'standard',
          views: num(story.views) ?? 0,
          lastViewedAt: date(story.lastViewedAt),
          archived: story.archived === true,
          // ── CE QU'UN RETRAIT NE DOIT PAS PERDRE ──
          //
          // `quarantined` et `suspendedAt` n'étaient pas repris. Une famille
          // qui restaurait sa mémoire — changement d'hébergeur, erreur,
          // reprise après incident — retrouvait donc PUBLIÉS les récits que
          // leur auteur avait suspendus à la demande de quelqu'un, et
          // remontés dans le Passeur ceux qu'un membre avait mis en
          // sourdine. Quelqu'un avait demandé qu'on n'en parle plus,
          // l'auteur avait accepté, et une opération technique défaisait
          // l'accord sans que personne l'ait décidé.
          //
          // Un retrait qui ne survit pas à une restauration n'est pas un
          // retrait : c'est un masquage provisoire.
          quarantined: story.quarantined === true,
          suspendedAt: date(story.suspendedAt),
          createdAt: date(story.createdAt) ?? new Date(),
          eventDate: date(story.eventDate),
          linkedEntities: { connect: linked.map((id) => ({ id })) },
        },
      });
      storyIds.set(str(story.id) ?? row.id, row.id);
    }

    // `suspendedForId` désigne un MEMBRE : il ne peut être posé qu'une fois
    // la table des membres remappée, donc en second passage.
    let suspensions = 0;
    for (const story of stories) {
      const id = mapped(storyIds, story.id);
      const pourQui = mapped(memberIds, story.suspendedForId);
      if (!id || !pourQui) continue;
      await this.prisma.story.update({ where: { id }, data: { suspendedForId: pourQui } });
      suspensions += 1;
    }

    // ── Les mises en sourdine ──
    //
    // « Un membre peut décider de ne plus voir un récit » (§2.6). Sans
    // elles, la restauration remet devant les yeux de quelqu'un ce qu'il
    // avait choisi d'écarter, et il doit refaire trois fois le même geste.
    let sourdines = 0;
    for (const mute of asArray(data.storyMutes)) {
      const storyId = mapped(storyIds, mute.storyId);
      const memberId = mapped(memberIds, mute.memberId);
      if (!storyId || !memberId) continue;
      await this.prisma.storyMute.create({
        data: {
          familyId: created.id,
          storyId,
          memberId,
          reason: str(mute.reason) ?? 'restaurée',
          createdAt: date(mute.createdAt) ?? new Date(),
        },
      });
      sourdines += 1;
    }

    // ── Les demandes de suspension ──
    //
    // Elles portent un nom et des mots. Les perdre laisserait l'auteur
    // devant un récit suspendu sans savoir qui l'avait demandé, ni pourquoi.
    let demandes = 0;
    for (const demande of asArray(data.suspensionRequests)) {
      const storyId = mapped(storyIds, demande.storyId);
      const memberId = mapped(memberIds, demande.memberId);
      if (!storyId || !memberId) continue;
      await this.prisma.suspensionRequest.create({
        data: {
          familyId: created.id,
          storyId,
          memberId,
          motif: str(demande.motif),
          createdAt: date(demande.createdAt) ?? new Date(),
        },
      });
      demandes += 1;
    }

    // Les passages en dernier : ils supposent les deux récits présents.
    let passages = 0;
    for (const passage of asArray(data.passages)) {
      const parentStoryId = mapped(storyIds, passage.parentStoryId);
      const childStoryId = mapped(storyIds, passage.childStoryId);
      if (!parentStoryId || !childStoryId) continue;
      await this.prisma.passage.create({
        data: {
          familyId: created.id,
          parentStoryId,
          childStoryId,
          triggerType: str(passage.triggerType) ?? 'manual',
          latencyDays: num(passage.latencyDays) ?? 0,
          createdAt: date(passage.createdAt) ?? new Date(),
        },
      });
      passages += 1;
    }

    // ── Les fils ──
    //
    // Deux formats coexistent : `threads` + `messages` (v2), et l'ancien
    // `conversations` (v1). Un export fait avant le changement doit encore
    // se restaurer : la famille possède ses données, y compris celles
    // qu'elle a emportées il y a six mois (amendement 3).
    const threadIds = new Map<string, string>();
    let threads = 0;
    let messages = 0;

    for (const thread of asArray(data.threads)) {
      const openedById = mapped(memberIds, thread.openedById);
      if (!openedById) continue;
      const row = await this.prisma.thread.create({
        data: {
          familyId: created.id,
          entityId: mapped(entityIds, thread.entityId),
          storyId: mapped(storyIds, thread.storyId),
          title: str(thread.title),
          openedById,
          crystallizedStoryId: mapped(storyIds, thread.crystallizedStoryId),
          messageCount: num(thread.messageCount) ?? 0,
          createdAt: date(thread.createdAt) ?? new Date(),
          lastMessageAt: date(thread.lastMessageAt) ?? date(thread.createdAt) ?? new Date(),
        },
      });
      threadIds.set(str(thread.id) ?? row.id, row.id);
      threads += 1;
    }

    for (const message of asArray(data.messages)) {
      const threadId = mapped(threadIds, message.threadId);
      const authorId = mapped(memberIds, message.authorId);
      if (!threadId || !authorId) continue;
      await this.prisma.message.create({
        data: {
          threadId,
          familyId: created.id,
          authorId,
          narratorId: mapped(memberIds, message.narratorId),
          body: str(message.body) ?? '',
          isQuestion: message.isQuestion === true,
          createdAt: date(message.createdAt) ?? new Date(),
        },
      });
      messages += 1;
    }

    // Format v1 : chaque conversation redevient un fil de un ou deux messages,
    // exactement comme l'a fait la migration de la base.
    for (const conversation of asArray(data.conversations)) {
      const storyId = mapped(storyIds, conversation.storyId);
      const questionerId = mapped(memberIds, conversation.questionerId);
      if (!storyId || !questionerId) continue;

      const questionAt = date(conversation.createdAt) ?? new Date();
      const responseText = str(conversation.responseText);
      const answeredAt = date(conversation.answeredAt) ?? questionAt;

      const thread = await this.prisma.thread.create({
        data: {
          familyId: created.id,
          storyId,
          openedById: questionerId,
          crystallizedStoryId: mapped(storyIds, conversation.convertedToStoryId),
          messageCount: responseText ? 2 : 1,
          createdAt: questionAt,
          lastMessageAt: responseText ? answeredAt : questionAt,
        },
      });
      threads += 1;

      await this.prisma.message.create({
        data: {
          threadId: thread.id,
          familyId: created.id,
          authorId: questionerId,
          body: str(conversation.questionText) ?? '',
          isQuestion: true,
          createdAt: questionAt,
        },
      });
      messages += 1;

      if (responseText) {
        await this.prisma.message.create({
          data: {
            threadId: thread.id,
            familyId: created.id,
            authorId: mapped(memberIds, conversation.responderId) ?? questionerId,
            body: responseText,
            createdAt: answeredAt,
          },
        });
        messages += 1;
      }
    }

    let traditions = 0;
    for (const tradition of asArray(data.traditions)) {
      await this.prisma.tradition.create({
        data: {
          familyId: created.id,
          name: str(tradition.name) ?? 'Tradition',
          description: str(tradition.description) ?? '',
          periodicity: str(tradition.periodicity) ?? 'annual',
          monthDay: str(tradition.monthDay),
          weekDay: num(tradition.weekDay),
          activationCount: num(tradition.activationCount) ?? 0,
          lastActivatedAt: date(tradition.lastActivatedAt),
          isAsleep: tradition.isAsleep === true,
          sleepReason: str(tradition.sleepReason),
        },
      });
      traditions += 1;
    }

    /*
     * Les ARCHIVES ne sont volontairement pas restaurées : l'export ne
     * contient que leurs métadonnées, pas les octets. Recréer des lignes
     * dont les storageKey ne pointent sur rien donnerait à la famille
     * l'illusion d'avoir récupéré ses photos.
     */

    return {
      familyId: created.id,
      familyName: created.name,
      counts: {
        membres: memberIds.size,
        recits: storyIds.size,
        entites: entityIds.size,
        passages,
        fils: threads,
        messages,
        traditions,
        // Nommés même à zéro : un compte absent se lit « il n'y en avait
        // pas », un zéro se lit « il n'y en a plus ».
        'récits suspendus': suspensions,
        'mises en sourdine': sourdines,
        'demandes de suspension': demandes,
      },
    };
  }
}

type Row = Record<string, unknown>;

function asArray(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Row[]) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mapped(map: Map<string, string>, value: unknown): string | null {
  const key = str(value);
  return key ? (map.get(key) ?? null) : null;
}

export const importService = new ImportService();
