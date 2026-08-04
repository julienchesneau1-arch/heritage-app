import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { metricsService } from '@/services/metrics.service';
import { conservateur } from '@/services/conservateur.service';

export const dynamic = 'force-dynamic';

/** GET — transmission (§9.1) + rapport du Conservateur (§3.2). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const [transmission, conservateurReport] = await Promise.all([
    metricsService.transmission(params.id),
    conservateur.report(params.id),
  ]);

  return apiOk({ transmission, conservateur: conservateurReport });
}
