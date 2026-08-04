import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { normalizeName, daysBetween } from '@/lib/normalize';
import {
  DEFAULT_STRUCTURE_TYPE,
  ENTITY_TYPES,
  lengthFromContent,
  type PassageTriggerType,
} from '@/lib/structure-types';
import { LLMOperatorService, llmOperator } from './llm-operator.service';
import type { CreateStoryInput, UpdateStoryInput } from '@/lib/validation';

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

    // Les entités saisies par la famille font foi. Le LLM ne complète que
    // le silence : il ne corrige ni ne complète une liste déjà donnée.
    const declared = input.entityNames ?? [];
    const extracted =
      declared.length === 0 && this.llm.isAvailable ? await this.llm.extractEntities(input.content) : [];

    const entities = await this.resolveEntities(familyId, declared.length > 0 ? declared : extracted);

    const story = await this.prisma.story.create({
      data: {
        familyId,
        authorId: input.authorId,
        narratorId: input.narratorId ?? null,
        title: input.title,
        content: input.content,
        structureType,
        tone: input.tone,
        length: lengthFromContent(input.content),
        eventDate: input.eventDate ?? null,
        searchText: searchTextOf(input.title, input.content),
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

    // Le fil dont ce récit s'est cristallisé ne disparaît pas : il devient
    // la provenance, et l'on peut toujours remonter à qui a dit quoi.
    if (input.fromThreadId) {
      await this.prisma.thread.updateMany({
        where: { id: input.fromThreadId, familyId },
        data: { crystallizedStoryId: story.id },
      });
    }

    return story;
  }

  /**
   * Correction d'un récit. Le texte change ; l'auteur, le narrateur, les
   * passages et les conversations ne bougent pas. C'est tout l'intérêt :
   * avant, corriger une virgule imposait de supprimer, donc d'effacer les
   * chaînes de transmission attachées.
   */
  async updateStory(familyId: string, storyId: string, input: UpdateStoryInput) {
    const structureType =
      input.structureType ??
      (this.llm.isAvailable ? await this.llm.classifyStructure(input.content) : DEFAULT_STRUCTURE_TYPE);

    const result = await this.prisma.story.updateMany({
      where: { id: storyId, familyId },
      data: {
        title: input.title,
        content: input.content,
        structureType,
        tone: input.tone,
        length: lengthFromContent(input.content),
        eventDate: input.eventDate ?? null,
        searchText: searchTextOf(input.title, input.content),
      },
    });
    return result.count > 0;
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
    const members = names.some((entry) => entry.type === 'PERSON')
      ? await this.prisma.member.findMany({ where: { familyId, isDeleted: false } })
      : [];

    const resolved = [];
    for (const { name, type } of names) {
      const normalized = normalizeName(name);
      // Un type hors grammaire ne crée pas de nœud : le LLM classe dans la
      // liste du système, il ne l'étend pas.
      if (!normalized || !(ENTITY_TYPES as readonly string[]).includes(type)) continue;

      const member = type === 'PERSON' ? matchMember(normalized, members) : null;

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

/**
 * Texte de recherche : titre et contenu normalisés, sans accent ni
 * ponctuation. Sans lui, chercher « demenagement » ne trouvait pas
 * « déménagement » — et personne ne tape les accents sur un téléphone.
 */
export function searchTextOf(title: string, content: string): string {
  return normalizeName(`${title} ${content}`);
}

/**
 * Dans un récit on écrit « Robert », pas « Robert Martin ». Une égalité
 * stricte ne rattacherait donc presque jamais l'entité au membre, et le
 * graphe familial resterait vide de ses personnes.
 *
 * On accepte l'inclusion sur mots entiers — « robert » ⊂ « robert martin » —
 * et on refuse dès que deux membres répondent : un prénom ambigu vaut mieux
 * non rattaché que rattaché au mauvais.
 */
function matchMember<T extends { id: string; name: string }>(normalized: string, members: T[]): T | null {
  const exact = members.filter((member) => normalizeName(member.name) === normalized);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;

  const words = new Set(normalized.split(' '));
  const partial = members.filter((member) => {
    const memberWords = normalizeName(member.name).split(' ');
    return [...words].every((word) => memberWords.includes(word));
  });

  return partial.length === 1 ? partial[0]! : null;
}

export const storyService = new StoryService();
