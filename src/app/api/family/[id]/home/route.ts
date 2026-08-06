import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { LIMITS, rateLimit, limiteParIp } from '@/lib/rate-limit';
import { TriggerModelService } from '@/services/trigger-model.service';
import { PasseurService } from '@/services/passeur.service';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const triggerModel = new TriggerModelService();
const passeur = new PasseurService();

/** GET /api/family/:id/home → { signal, passeur } — au plus un de chaque (§5.1). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  const familyId = params.id;
  if (!(await authorizeFamily(request, familyId))) return apiError('FORBIDDEN');


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
