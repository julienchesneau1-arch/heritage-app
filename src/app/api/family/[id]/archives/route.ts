import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { createArchiveSchema, parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const archives = await prisma.archive.findMany({
    where: { familyId: params.id },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { id: true, name: true } },
      story: { select: { id: true, title: true } },
    },
  });

  return apiOk({ archives });
}

/**
 * POST — enregistre les MÉTADONNÉES d'une archive déjà déposée sur le
 * stockage objet (S3/R2) via une URL signée. Le binaire ne transite pas
 * par l'API : la route reste dans les limites d'une fonction serverless.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!authorizeFamily(request, params.id)) return apiError('FORBIDDEN');

  const { data, errors } = parseOrNull(createArchiveSchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const uploader = await prisma.member.findFirst({
    where: { id: data.uploaderId, familyId: params.id, isDeleted: false },
  });
  if (!uploader) return apiError('NOT_FOUND', 'Membre inconnu dans cette famille.');

  if (data.storyId) {
    const story = await prisma.story.findFirst({ where: { id: data.storyId, familyId: params.id } });
    if (!story) return apiError('NOT_FOUND', 'Récit inconnu dans cette famille.');
  }

  const archive = await prisma.archive.create({
    data: {
      familyId: params.id,
      uploaderId: data.uploaderId,
      storyId: data.storyId ?? null,
      type: data.type,
      title: data.title,
      storageKey: data.storageKey,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      extractedText: data.extractedText ?? null,
      extractedEntities: [],
    },
  });

  return apiOk({ id: archive.id }, 201);
}
