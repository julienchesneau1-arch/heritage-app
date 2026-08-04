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
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const archive = await prisma.archive.findFirst({
    where: { id: params.archiveId, familyId: params.id },
    select: { storageKey: true, mimeType: true, sizeBytes: true, title: true },
  });
  if (!archive) return apiError('NOT_FOUND');

  const data = await storage.get(archive.storageKey);
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
