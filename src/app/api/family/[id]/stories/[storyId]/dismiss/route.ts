import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { dismissStorySchema, parseOrNull } from '@/lib/validation';
import { conservateur } from '@/services/conservateur.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * POST — « Ne plus me montrer ».
 * Trois fois par le même membre : le récit se tait POUR CE MEMBRE. Il reste
 * lisible, cherchable et exportable, et les autres continuent de le voir.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; storyId: string } },
) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(dismissStorySchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: params.id },
    select: { id: true },
  });
  if (!story) return apiError('NOT_FOUND');

  const result = await conservateur.processDismissal({
    familyId: params.id,
    storyId: params.storyId,
    memberId: data.memberId,
    context: data.context,
    reason: data.reason,
  });

  return apiOk(result);
}
