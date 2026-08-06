import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { createArchiveSchema, parseOrNull } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { nommer, QUI } from '@/lib/deces';
import {
  ACCEPTED_TYPES,
  buildStorageKey,
  isAcceptedType,
  MAX_UPLOAD_BYTES,
  storage,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const archives = await prisma.archive.findMany({
    where: { familyId: params.id },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: QUI },
      story: { select: { id: true, title: true } },
    },
  });

  return apiOk({ archives: archives.map((a) => ({ ...a, uploader: nommer(a.uploader) })) });
}

/**
 * POST — dépose une archive.
 *
 * Deux formes acceptées :
 *  - `multipart/form-data` : le fichier lui-même, écrit sur le stockage.
 *  - `application/json` : les seules métadonnées, quand le binaire a déjà
 *    été déposé ailleurs (import, migration).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    return uploadFile(request, params.id);
  }

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

/**
 * Réception d'un fichier. Le type MIME déclaré ne fait pas foi seul :
 * il doit figurer dans la liste des types acceptés, et c'est lui qui
 * détermine le type d'archive — la famille n'a pas à le choisir.
 */
async function uploadFile(request: NextRequest, familyId: string) {
  const form = await request.formData().catch(() => null);
  if (!form) return apiError('INVALID_INPUT', 'Formulaire illisible.');

  const file = form.get('file');
  if (!(file instanceof File)) return apiError('INVALID_INPUT', 'Fichier manquant.');
  if (file.size === 0) return apiError('INVALID_INPUT', 'Fichier vide.');
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError('INVALID_INPUT', `Fichier trop lourd (max ${MAX_UPLOAD_BYTES / 1024 / 1024} Mo).`);
  }
  if (!isAcceptedType(file.type)) {
    return apiError('INVALID_INPUT', `Type de fichier non accepté : ${file.type || 'inconnu'}.`);
  }

  const uploaderId = String(form.get('uploaderId') ?? '');
  const storyId = String(form.get('storyId') ?? '') || null;
  const title = String(form.get('title') ?? '').trim() || file.name;

  const uploader = await prisma.member.findFirst({
    where: { id: uploaderId, familyId, isDeleted: false },
  });
  if (!uploader) return apiError('NOT_FOUND', 'Membre inconnu dans cette famille.');

  if (storyId) {
    const story = await prisma.story.findFirst({ where: { id: storyId, familyId } });
    if (!story) return apiError('NOT_FOUND', 'Récit inconnu dans cette famille.');
  }

  const data = Buffer.from(await file.arrayBuffer());
  const storageKey = buildStorageKey(familyId, file.type);
  await storage.put(storageKey, data);

  const archive = await prisma.archive.create({
    data: {
      familyId,
      uploaderId,
      storyId,
      type: ACCEPTED_TYPES[file.type]!.archiveType,
      title: title.slice(0, 200),
      storageKey,
      mimeType: file.type,
      sizeBytes: data.byteLength,
      extractedEntities: [],
    },
  });

  return apiOk({ id: archive.id }, 201);
}
