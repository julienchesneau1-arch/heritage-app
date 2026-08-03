import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { clientIp, LIMITS, rateLimit } from '@/lib/rate-limit';
import { TriggerModelService } from '@/services/trigger-model.service';
import { PasseurService } from '@/services/passeur.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const triggerModel = new TriggerModelService();
const passeur = new PasseurService();

/** GET /api/family/:id/home → { signal, passeur } — au plus un de chaque (§5.1). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const familyId = params.id;
  if (!authorizeFamily(request, familyId)) return apiError('FORBIDDEN');

  const ipLimit = await rateLimit(`ip:${clientIp(request)}`, LIMITS.perIp.limit, LIMITS.perIp.window);
  if (!ipLimit.allowed) return apiError('RATE_LIMITED');

  const memberId = request.nextUrl.searchParams.get('memberId');
  if (!memberId) return apiError('INVALID_INPUT', 'memberId requis');

  const member = await prisma.member.findFirst({ where: { id: memberId, familyId } });
  if (!member) return apiError('NOT_FOUND');

  const passeurLimit = await rateLimit(
    `passeur:${familyId}`,
    LIMITS.passeurPerFamily.limit,
    LIMITS.passeurPerFamily.window,
  );

  const [signal, question] = await Promise.all([
    triggerModel.generateSignal(familyId, memberId),
    passeurLimit.allowed ? passeur.generateQuestion(familyId, memberId) : Promise.resolve(null),
  ]);

  return apiOk({ signal, passeur: question });
}
