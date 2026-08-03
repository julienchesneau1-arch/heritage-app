import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { createConversationSchema, parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** GET — les questions posées autour des récits de la famille. */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const status = request.nextUrl.searchParams.get('status') ?? undefined;

  const conversations = await prisma.conversation.findMany({
    where: { familyId: params.id, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    include: {
      story: { select: { id: true, title: true } },
      questioner: { select: { id: true, name: true } },
      responder: { select: { id: true, name: true } },
    },
  });

  return apiOk({ conversations });
}

/** POST — poser une question sur un récit. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(createConversationSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const [story, questioner] = await Promise.all([
    prisma.story.findFirst({ where: { id: data.storyId, familyId: params.id } }),
    prisma.member.findFirst({ where: { id: data.questionerId, familyId: params.id, isDeleted: false } }),
  ]);
  if (!story || !questioner) return apiError('NOT_FOUND');

  const conversation = await prisma.conversation.create({
    data: {
      familyId: params.id,
      storyId: data.storyId,
      questionerId: data.questionerId,
      questionText: data.questionText,
    },
  });

  return apiOk({ id: conversation.id }, 201);
}
