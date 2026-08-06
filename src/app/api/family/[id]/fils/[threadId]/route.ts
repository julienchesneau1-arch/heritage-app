import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { threadService } from '@/services/thread.service';

export const dynamic = 'force-dynamic';

/** GET — un fil et tout ce qui s'y est dit, avec les marques. */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; threadId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const thread = await threadService.byId(params.id, params.threadId);
  if (!thread) return apiError('NOT_FOUND');

  return apiOk({ thread });
}
