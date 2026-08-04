import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { parseOrNull, viewStorySchema } from '@/lib/validation';
import { conservateur } from '@/services/conservateur.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** POST — journalise une lecture. Toute impression est auditable (§3.2). */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(viewStorySchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: params.id },
    select: { id: true },
  });
  if (!story) return apiError('NOT_FOUND');

  await conservateur.registerView({
    familyId: params.id,
    storyId: params.storyId,
    memberId: data.memberId,
    context: data.context,
  });

  return apiOk({ ok: true });
}
