import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily, requestIdentity } from '@/lib/session';
import { parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { lengthFromContent } from '@/lib/structure-types';
import { searchTextOf } from '@/services/story.service';

export const dynamic = 'force-dynamic';

/** GET — un récit, ses entités, ses conversations, ses passages. */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: params.id },
    include: {
      author: { select: { id: true, name: true, isDeleted: true } },
      linkedEntities: true,
      archives: true,
      threads: {
        orderBy: { createdAt: 'asc' },
        include: {
          openedBy: { select: { id: true, name: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: { select: { id: true, name: true } },
              narrator: { select: { id: true, name: true } },
            },
          },
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
 * PATCH — archiver / désarchiver, ou corriger le texte.
 * §6.3 : archiver est une décision familiale, jamais algorithmique.
 * Corriger ne touche ni l'auteur, ni les passages, ni les conversations.
 */
const patchSchema = z.object({
  archived: z.boolean().optional(),
  title: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(5000).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(patchSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const existing = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: params.id },
    select: { title: true, content: true },
  });
  if (!existing) return apiError('NOT_FOUND');

  const title = data.title ?? existing.title;
  const content = data.content ?? existing.content;

  const result = await prisma.story.updateMany({
    where: { id: params.storyId, familyId: params.id },
    data: {
      ...(data.archived !== undefined ? { archived: data.archived } : {}),
      ...(data.title !== undefined || data.content !== undefined
        ? { title, content, length: lengthFromContent(content), searchText: searchTextOf(title, content) }
        : {}),
    },
  });

  if (result.count === 0) return apiError('NOT_FOUND');
  return apiOk({ ok: true });
}

/**
 * DELETE — §2.1 règle 2 : suppression réservée à l'auteur.
 *
 * L'identité vient du COOKIE SIGNÉ, et doit être vérifiée (lien personnel).
 * Auparavant elle venait d'un `?memberId=` fourni par l'appelant : la garde
 * consistait à demander à quelqu'un s'il avait le droit, et à le croire.
 *
 * Le droit à l'oubli reste absolu (Constitution, §6) : on supprime
 * réellement, en emportant les liens qui pointaient vers ce récit.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const identity = requestIdentity(request);
  if (!identity) return apiError('FORBIDDEN', 'Identité requise.');
  if (identity.level !== 'verified') {
    return apiError('FORBIDDEN', 'La suppression exige une identité vérifiée (lien personnel).');
  }

  const member = await prisma.member.findFirst({
    where: { id: identity.memberId, familyId: params.id, isDeleted: false },
    select: { id: true },
  });
  if (!member) return apiError('FORBIDDEN');

  const story = await prisma.story.findFirst({ where: { id: params.storyId, familyId: params.id } });
  if (!story) return apiError('NOT_FOUND');
  if (story.authorId !== member.id) {
    return apiError('FORBIDDEN', 'Seul l’auteur peut supprimer ce récit.');
  }

  await prisma.$transaction([
    prisma.passage.deleteMany({
      where: { OR: [{ parentStoryId: story.id }, { childStoryId: story.id }] },
    }),
    // Les fils accrochés au récit partent en cascade ; ceux qui s'y sont
    // cristallisés se détachent — la parole survit au récit.
    prisma.thread.updateMany({
      where: { crystallizedStoryId: story.id },
      data: { crystallizedStoryId: null },
    }),
    prisma.visibilityLog.deleteMany({ where: { storyId: story.id } }),
    prisma.archive.updateMany({ where: { storyId: story.id }, data: { storyId: null } }),
    prisma.story.delete({ where: { id: story.id } }),
  ]);

  return apiOk({ deleted: true });
}
