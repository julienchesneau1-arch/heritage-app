import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** GET — un récit, ses entités, ses conversations, ses passages. */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: params.id },
    include: {
      author: { select: { id: true, name: true, isDeleted: true } },
      linkedEntities: true,
      archives: true,
      conversations: {
        orderBy: { createdAt: 'asc' },
        include: {
          questioner: { select: { id: true, name: true } },
          responder: { select: { id: true, name: true } },
        },
      },
      parentPassages: { include: { childStory: { select: { id: true, title: true } } } },
      childPassages: { include: { parentStory: { select: { id: true, title: true } } } },
    },
  });

  if (!story) return apiError('NOT_FOUND');
  return apiOk(story);
}

/**
 * PATCH — archiver / désarchiver, ou sortir de quarantaine.
 * §6.3 : archiver est une décision familiale, jamais algorithmique.
 */
const patchSchema = z.object({
  archived: z.boolean().optional(),
  quarantined: z.literal(false).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(patchSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const result = await prisma.story.updateMany({
    where: { id: params.storyId, familyId: params.id },
    data: {
      ...(data.archived !== undefined ? { archived: data.archived } : {}),
      ...(data.quarantined === false ? { quarantined: false, quarantineReason: null } : {}),
    },
  });

  if (result.count === 0) return apiError('NOT_FOUND');
  return apiOk({ ok: true });
}

/**
 * DELETE — §2.1 règle 2 : suppression réservée à l'auteur.
 * Le droit à l'oubli est absolu (Constitution, §6) : on supprime réellement,
 * en emportant les liens qui pointaient vers ce récit.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const memberId = request.nextUrl.searchParams.get('memberId');
  if (!memberId) return apiError('INVALID_INPUT', 'memberId requis');

  const story = await prisma.story.findFirst({ where: { id: params.storyId, familyId: params.id } });
  if (!story) return apiError('NOT_FOUND');
  if (story.authorId !== memberId) return apiError('FORBIDDEN', 'Seul l’auteur peut supprimer ce récit.');

  await prisma.$transaction([
    prisma.passage.deleteMany({
      where: { OR: [{ parentStoryId: story.id }, { childStoryId: story.id }] },
    }),
    prisma.conversation.deleteMany({ where: { storyId: story.id } }),
    prisma.visibilityLog.deleteMany({ where: { storyId: story.id } }),
    prisma.archive.updateMany({ where: { storyId: story.id }, data: { storyId: null } }),
    prisma.story.delete({ where: { id: story.id } }),
  ]);

  return apiOk({ deleted: true });
}
