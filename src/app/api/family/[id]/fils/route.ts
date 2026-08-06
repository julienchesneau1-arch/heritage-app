import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { openThreadSchema, parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { threadService } from '@/services/thread.service';

export const dynamic = 'force-dynamic';

/** GET — les fils de la famille, du plus récemment nourri au plus ancien. */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const take = Math.min(100, Number(request.nextUrl.searchParams.get('take') ?? 50) || 50);
  const entityId = request.nextUrl.searchParams.get('entite') ?? undefined;
  const storyId = request.nextUrl.searchParams.get('recit') ?? undefined;

  const threads = await prisma.thread.findMany({
    where: { familyId: params.id, ...(entityId ? { entityId } : {}), ...(storyId ? { storyId } : {}) },
    orderBy: { lastMessageAt: 'desc' },
    take,
    include: {
      entity: { select: { id: true, name: true, type: true } },
      story: { select: { id: true, title: true } },
      openedBy: { select: { id: true, name: true } },
    },
  });

  return apiOk({ threads });
}

/**
 * POST — parler. Ouvre un fil, ou en nourrit un existant.
 *
 * Aucun titre n'est requis, aucun type, aucune structure : le coût d'entrée
 * du produit tient dans ce contrat.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(openThreadSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const author = await prisma.member.findFirst({
    where: { id: data.authorId, familyId: params.id, isDeleted: false },
    select: { id: true },
  });
  if (!author) return apiError('NOT_FOUND');

  const post = {
    familyId: params.id,
    authorId: data.authorId,
    narratorId: data.narratorId ?? null,
    body: data.body,
    isQuestion: data.isQuestion ?? false,
  };

  if (data.threadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: data.threadId, familyId: params.id },
      select: { id: true },
    });
    if (!thread) return apiError('NOT_FOUND');
    const message = await threadService.reply(data.threadId, post);
    return apiOk({ threadId: data.threadId, messageId: message.id }, 201);
  }

  // Un ancrage venu du client doit appartenir à cette famille.
  if (data.entityId) {
    const entity = await prisma.entity.findFirst({
      where: { id: data.entityId, familyId: params.id },
      select: { id: true },
    });
    if (!entity) return apiError('NOT_FOUND');
  } else if (data.storyId) {
    const story = await prisma.story.findFirst({
      where: { id: data.storyId, familyId: params.id },
      select: { id: true },
    });
    if (!story) return apiError('NOT_FOUND');
  }

  const anchor = data.entityId
    ? ({ kind: 'entity', entityId: data.entityId } as const)
    : data.storyId
      ? ({ kind: 'story', storyId: data.storyId } as const)
      : ({ kind: 'none' } as const);

  const thread = await threadService.open(anchor, post, data.title);
  return apiOk({ threadId: thread.id }, 201);
}
