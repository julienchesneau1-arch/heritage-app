import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { normalizeName, daysBetween } from '@/lib/normalize';
import { DEFAULT_STRUCTURE_TYPE, lengthFromContent, type PassageTriggerType } from '@/lib/structure-types';
import { LLMOperatorService, llmOperator } from './llm-operator.service';
import type { CreateStoryInput } from '@/lib/validation';

/**
 * Création d'un récit — et, quand il y a lieu, du Passage qui l'attache
 * à celui qui l'a engendré. Le Passage est la primitive du produit :
 * sans lui, transmission_rate reste à zéro.
 */
export class StoryService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private llm: LLMOperatorService = llmOperator,
  ) {}

  async createStory(familyId: string, input: CreateStoryInput) {
    // La classification est une opération LLM vérifiée : si elle échoue ou
    // si aucune clé n'est configurée, on retombe sur le type par défaut.
    const structureType =
      input.structureType ??
      (this.llm.isAvailable ? await this.llm.classifyStructure(input.content) : DEFAULT_STRUCTURE_TYPE);

    const entities = await this.resolveEntities(familyId, input.entityNames ?? []);

    const story = await this.prisma.story.create({
      data: {
        familyId,
        authorId: input.authorId,
        title: input.title,
        content: input.content,
        structureType,
        tone: input.tone,
        length: lengthFromContent(input.content),
        eventDate: input.eventDate ?? null,
        linkedEntities: { connect: entities.map((entity) => ({ id: entity.id })) },
      },
    });

    if (input.parentStoryId) {
      await this.createPassage({
        familyId,
        parentStoryId: input.parentStoryId,
        childStoryId: story.id,
        triggerType: input.triggerType ?? 'manual',
      });
    }

    if (input.fromConversationId) {
      await this.prisma.conversation.updateMany({
        where: { id: input.fromConversationId, familyId },
        data: { status: 'converted', convertedToStoryId: story.id },
      });
    }

    return story;
  }

  /**
   * Un passage relie un récit parent à l'enfant qu'il a suscité.
   * La latence (en jours) est le temps qu'a mis l'histoire à en engendrer une autre.
   */
  async createPassage(params: {
    familyId: string;
    parentStoryId: string;
    childStoryId: string;
    triggerType: PassageTriggerType;
  }) {
    const [parent, child] = await Promise.all([
      this.prisma.story.findFirst({ where: { id: params.parentStoryId, familyId: params.familyId } }),
      this.prisma.story.findFirst({ where: { id: params.childStoryId, familyId: params.familyId } }),
    ]);
    // §2.1 règle 3 : jamais de lien cross-family.
    if (!parent || !child) return null;

    return this.prisma.passage.upsert({
      where: {
        parentStoryId_childStoryId: {
          parentStoryId: params.parentStoryId,
          childStoryId: params.childStoryId,
        },
      },
      update: {},
      create: {
        familyId: params.familyId,
        parentStoryId: params.parentStoryId,
        childStoryId: params.childStoryId,
        triggerType: params.triggerType,
        latencyDays: daysBetween(parent.createdAt, child.createdAt),
      },
    });
  }

  /** Entités : réutilisées si elles existent déjà (matching sur normalizedName). */
  private async resolveEntities(
    familyId: string,
    names: Array<{ name: string; type: string }>,
  ) {
    const resolved = [];
    for (const { name, type } of names) {
      const normalized = normalizeName(name);
      if (!normalized) continue;

      const member =
        type === 'PERSON'
          ? await this.prisma.member.findFirst({ where: { familyId, name, isDeleted: false } })
          : null;

      resolved.push(
        await this.prisma.entity.upsert({
          where: { familyId_normalizedName_type: { familyId, normalizedName: normalized, type } },
          update: member ? { memberId: member.id } : {},
          create: { familyId, type, name, normalizedName: normalized, memberId: member?.id ?? null },
        }),
      );
    }
    return resolved;
  }
}

export const storyService = new StoryService();
