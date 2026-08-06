import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET — nœuds et liens du graphe familial.
 * Deux natures de liens : récit ↔ entité (déclaré), et récit → récit (passage).
 * Aucun lien inféré : le graphe ne montre que ce que la famille a dit.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const [entities, stories, passages] = await Promise.all([
    prisma.entity.findMany({ where: { familyId: params.id } }),
    prisma.story.findMany({
      where: { familyId: params.id, archived: false, suspendedAt: null },
      select: { id: true, title: true, linkedEntities: { select: { id: true } } },
    }),
    prisma.passage.findMany({
      where: { familyId: params.id },
      select: { parentStoryId: true, childStoryId: true, triggerType: true },
    }),
  ]);

  const nodes = [
    ...entities.map((entity) => ({
      id: entity.id,
      kind: 'entity' as const,
      type: entity.type,
      label: entity.name,
    })),
    ...stories.map((story) => ({
      id: story.id,
      kind: 'story' as const,
      type: 'STORY',
      label: story.title,
    })),
  ];

  const links = [
    ...stories.flatMap((story) =>
      story.linkedEntities.map((entity) => ({
        source: story.id,
        target: entity.id,
        kind: 'mention' as const,
      })),
    ),
    ...passages.map((passage) => ({
      source: passage.parentStoryId,
      target: passage.childStoryId,
      kind: 'passage' as const,
      triggerType: passage.triggerType,
    })),
  ];

  return apiOk({ nodes, links });
}
