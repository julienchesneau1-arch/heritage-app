import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { apiError } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { storage } from '@/lib/storage';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET — sert le fichier d'une archive.
 *
 * Aucun fichier familial n'est accessible sans passer par ici : la famille
 * est vérifiée avant qu'un seul octet ne sorte, et l'en-tête interdit toute
 * mise en cache partagée.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; archiveId: string } },
) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const archive = await prisma.archive.findFirst({
    where: { id: params.archiveId, familyId: params.id },
    select: { storageKey: true, mimeType: true, sizeBytes: true, title: true },
  });
  if (!archive) return apiError('NOT_FOUND');

  // Une panne du stockage n'est pas une disparition. Répondre `NOT_FOUND`
  // sur une photo intacte, c'est apprendre à une famille qu'elle a perdu
  // quelque chose qu'elle n'a pas perdu — et c'est irrattrapable une fois
  // dit. `null` ne signifie plus que « l'objet n'existe pas » ; le reste
  // remonte, et remonte en 503.
  let data: Buffer | null;
  try {
    data = await storage.get(archive.storageKey);
  } catch (error) {
    console.error('[archives] stockage injoignable', error);
    return new Response(
      JSON.stringify({
        error: 'STORAGE_UNAVAILABLE',
        message:
          'Ce fichier n’a pas pu être récupéré maintenant. Il n’est pas perdu : réessayez dans un moment.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
    );
  }
  if (!data) return apiError('NOT_FOUND');

  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': archive.mimeType,
      'Content-Length': String(archive.sizeBytes),
      'Content-Disposition': `inline; filename="${encodeURIComponent(archive.title)}"`,
      // Privé : jamais dans un cache partagé, jamais chez un intermédiaire.
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
