import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * Amendement 3 — la famille possède ses données.
 *
 * L'export renvoie TOUT, en JSON structuré, sans traitement, sans filtre :
 * archivées, en quarantaine, journaux de visibilité compris. Rien n'est
 * retenu, y compris ce que l'app a décidé de moins montrer.
 */
export class ExportService {
  constructor(private prisma: PrismaClient = defaultPrisma) {}

  async exportFamily(familyId: string) {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: {
        members: true,
        stories: {
          include: {
            linkedEntities: { select: { id: true, name: true, type: true } },
            conversations: true,
            archives: true,
          },
        },
        entities: true,
        archives: true,
        traditions: true,
        conversations: true,
        passages: true,
        visibilityLogs: true,
      },
    });

    if (!family) return null;

    return {
      format: 'heritage-export/v1',
      exportedAt: new Date().toISOString(),
      family: {
        id: family.id,
        name: family.name,
        createdAt: family.createdAt,
      },
      members: family.members,
      stories: family.stories,
      entities: family.entities,
      archives: family.archives,
      traditions: family.traditions,
      conversations: family.conversations,
      passages: family.passages,
      visibilityLogs: family.visibilityLogs,
      counts: {
        members: family.members.length,
        stories: family.stories.length,
        entities: family.entities.length,
        archives: family.archives.length,
        traditions: family.traditions.length,
        conversations: family.conversations.length,
        passages: family.passages.length,
        visibilityLogs: family.visibilityLogs.length,
      },
    };
  }
}

export const exportService = new ExportService();
