import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { metricsService } from '@/services/metrics.service';
import { conservateur } from '@/services/conservateur.service';

export const dynamic = 'force-dynamic';

/** GET — transmission (§9.1) + rapport du Conservateur (§3.2). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const [transmission, conservateurReport] = await Promise.all([
    metricsService.transmission(params.id),
    conservateur.report(params.id),
  ]);

  return apiOk({ transmission, conservateur: conservateurReport });
}
