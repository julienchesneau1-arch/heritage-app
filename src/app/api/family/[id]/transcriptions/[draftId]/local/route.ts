import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { countSuspect, reviewSegments, draftTextFrom } from '@/lib/transcription-doubt';

export const dynamic = 'force-dynamic';

/**
 * Réception d'une transcription faite dans le navigateur.
 *
 * Le calcul a eu lieu sur l'appareil de la famille : coût nul, audio jamais
 * transmis. Il ne reste qu'à déposer le texte.
 *
 * Deux dépôts possibles :
 *  - `first`  : la transcription principale ;
 *  - `second` : un second avis, dont le désaccord avec la première désigne
 *               les passages à réécouter.
 *
 * Comme pour l'API, ce texte n'est qu'un brouillon : il ne devient un récit
 * qu'après relecture humaine.
 */
const bodySchema = z.object({
  role: z.enum(['first', 'second']).default('first'),
  model: z.string().min(1).max(120),
  text: z.string().max(200_000),
  chunks: z
    .array(
      z.object({
        start: z.number().finite(),
        end: z.number().finite(),
        text: z.string().max(5_000),
      }),
    )
    .max(5_000)
    .default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; draftId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(bodySchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const draft = await prisma.transcriptionDraft.findFirst({
    where: { id: params.draftId, familyId: params.id },
    select: { id: true, status: true },
  });
  if (!draft) return apiError('NOT_FOUND');
  if (draft.status === 'validated') {
    return apiError('CONSTITUTION_BLOCK', 'Ce brouillon a déjà été validé.');
  }

  if (data.role === 'second') {
    // Les artefacts sont retirés des DEUX versions, sinon une invention
    // présente dans les deux apparaîtrait comme une divergence : on
    // enverrait la famille écouter un passage dont on sait déjà qu'il n'a
    // jamais été prononcé.
    const secondReviewed = reviewSegments(
      data.chunks.length > 0
        ? data.chunks.map((chunk) => ({ start: chunk.start, end: chunk.end, text: chunk.text }))
        : [{ start: 0, end: 0, text: data.text }],
    );

    await prisma.transcriptionDraft.update({
      where: { id: draft.id },
      data: {
        secondText: draftTextFrom(secondReviewed) || data.text.trim(),
        secondSource: 'local',
        secondModel: data.model,
      },
    });
    return apiOk({ ok: true, role: 'second' });
  }

  // Les indicateurs de doute par segment n'existent pas côté navigateur :
  // seuls les horodatages sont disponibles. Les artefacts connus restent
  // détectés, et la relecture humaine demeure la vérification réelle.
  const reviewed = reviewSegments(
    data.chunks.map((chunk) => ({ start: chunk.start, end: chunk.end, text: chunk.text })),
  );

  await prisma.transcriptionDraft.update({
    where: { id: draft.id },
    data: {
      status: 'ready',
      source: 'local',
      model: data.model,
      rawText: reviewed.length > 0 ? draftTextFrom(reviewed) : data.text.trim(),
      segments: reviewed as unknown as object,
      suspectCount: countSuspect(reviewed),
      processedAt: new Date(),
      error: null,
    },
  });

  return apiOk({ ok: true, role: 'first' });
}
