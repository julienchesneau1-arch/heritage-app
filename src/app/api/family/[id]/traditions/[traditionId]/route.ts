import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { parseOrNull } from '@/lib/validation';
import { traditionService } from '@/services/tradition.service';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  action: z.enum(['activate', 'sleep', 'wake']),
  reason: z.string().max(280).optional(),
});

/** PATCH — relever une tradition, l'endormir, ou la réveiller. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string; traditionId: string } },
) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(patchSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  if (data.action === 'activate') {
    const tradition = await traditionService.activate(params.id, params.traditionId);
    return tradition ? apiOk(tradition) : apiError('NOT_FOUND');
  }

  // `ok` ne se dit qu'après avoir modifié quelque chose. Sans cela, une
  // tradition inexistante — ou celle d'une autre famille — recevait la
  // même confirmation qu'une tradition réellement endormie.
  if (data.action === 'sleep') {
    const fait = await traditionService.sleep(
      params.id,
      params.traditionId,
      data.reason ?? 'Endormie par la famille.',
    );
    return fait ? apiOk({ ok: true }) : apiError('NOT_FOUND');
  }

  const fait = await traditionService.wake(params.id, params.traditionId);
  return fait ? apiOk({ ok: true }) : apiError('NOT_FOUND');
}
