import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { clientIp, LIMITS, rateLimit } from '@/lib/rate-limit';
import { createStorySchema, listStoriesSchema, parseOrNull } from '@/lib/validation';
import { storyService } from '@/services/story.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** GET /api/family/:id/stories — ordre chronologique, toujours (amendement 5). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const familyId = params.id;
  if (!authorizeFamily(request, familyId)) return apiError('FORBIDDEN');

  const limit = await rateLimit(`ip:${clientIp(request)}`, LIMITS.perIp.limit, LIMITS.perIp.window);
  if (!limit.allowed) return apiError('RATE_LIMITED');

  const { data, errors } = parseOrNull(
    listStoriesSchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!data) return apiError('INVALID_INPUT', errors);

  const where: Prisma.StoryWhereInput = {
    familyId,
    ...(data.includeArchived ? {} : { archived: false }),
    ...(data.structureType ? { structureType: data.structureType } : {}),
    ...(data.authorId ? { authorId: data.authorId } : {}),
    ...(data.entityId ? { linkedEntities: { some: { id: data.entityId } } } : {}),
    ...(data.search
      ? {
          OR: [
            { title: { contains: data.search, mode: 'insensitive' } },
            { content: { contains: data.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [stories, total] = await Promise.all([
    prisma.story.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: data.take,
      skip: data.skip,
      include: {
        author: { select: { id: true, name: true, isDeleted: true } },
        linkedEntities: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.story.count({ where }),
  ]);

  return apiOk({ stories, total });
}

/** POST /api/family/:id/stories — créer un récit (et son passage, s'il en a un). */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const familyId = params.id;
  if (!authorizeFamily(request, familyId)) return apiError('FORBIDDEN');

  const limit = await rateLimit(`ip:${clientIp(request)}`, LIMITS.perIp.limit, LIMITS.perIp.window);
  if (!limit.allowed) return apiError('RATE_LIMITED');

  const { data, errors } = parseOrNull(createStorySchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const author = await prisma.member.findFirst({
    where: { id: data.authorId, familyId, isDeleted: false },
  });
  if (!author) return apiError('NOT_FOUND', 'Auteur inconnu dans cette famille.');

  const story = await storyService.createStory(familyId, data);
  return apiOk({ id: story.id }, 201);
}
