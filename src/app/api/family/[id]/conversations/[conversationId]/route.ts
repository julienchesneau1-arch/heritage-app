import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { answerConversationSchema, parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** PATCH — répondre à une question. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; conversationId: string } },
) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(answerConversationSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const [conversation, responder] = await Promise.all([
    prisma.conversation.findFirst({ where: { id: params.conversationId, familyId: params.id } }),
    prisma.member.findFirst({ where: { id: data.responderId, familyId: params.id, isDeleted: false } }),
  ]);
  if (!conversation || !responder) return apiError('NOT_FOUND');

  const updated = await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      responderId: data.responderId,
      responseText: data.responseText,
      status: conversation.status === 'converted' ? 'converted' : 'answered',
      answeredAt: new Date(),
    },
  });

  return apiOk(updated);
}
