import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily } from '@/lib/session';
import { limiteParIp } from '@/lib/rate-limit';
import { createStorySchema, listStoriesSchema, parseOrNull } from '@/lib/validation';
import { storyService } from '@/services/story.service';
import { prisma } from '@/lib/prisma';
import { nomAffiche } from '@/lib/deces';

export const dynamic = 'force-dynamic';

/** GET /api/family/:id/stories — ordre chronologique, toujours (amendement 5). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  const familyId = params.id;
  if (!(await authorizeFamily(request, familyId))) return apiError('FORBIDDEN');


  const { data, errors } = parseOrNull(
    listStoriesSchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!data) return apiError('INVALID_INPUT', errors);

  const where: Prisma.StoryWhereInput = {
    familyId,
    /*
     * ── UNE SUSPENSION N'EST PAS UN ARCHIVAGE ──
     *
     * Les deux filtres étaient dans la même parenthèse, et
     * `includeArchived=1` les levait tous les deux. « Voir les récits
     * archivés » et « voir ce que l'auteur a retiré » sont deux demandes
     * différentes, et la seconde n'est offerte à personne : la §2.1
     * règle 2 amendée donne à l'auteur — et au narrateur — le droit de
     * retirer ses mots, sans paramètre pour le défaire.
     *
     * La page `/recits` séparait déjà les deux (`visible` y est constant).
     * L'API, non : un membre qui ajoutait `?includeArchived=1` recevait
     * en JSON le récit que quelqu'un venait de retirer.
     */
    suspendedAt: null,
    ...(data.includeArchived ? {} : { archived: false }),
    ...(data.structureType ? { structureType: data.structureType } : {}),
    ...(data.authorId ? { authorId: data.authorId } : {}),
    ...(data.entityId ? { linkedEntities: { some: { id: data.entityId } } } : {}),
    ...(data.search
      ? {
          OR: [
            { title: { contains: data.search, mode: 'insensitive' } },
            { content: { contains: data.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [stories, total] = await Promise.all([
    prisma.story.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: data.take,
      skip: data.skip,
      include: {
        author: { select: { id: true, name: true, isDeleted: true } },
        linkedEntities: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.story.count({ where }),
  ]);

  /*
   * ── « ANONYMISÉ » NE S'ARRÊTE PAS AUX PAGES ──
   *
   * La §2.1 règle 1 le précise elle-même : « la règle ne dit pas anonymisé
   * dans les récits, elle dit anonymisé ». Les pages passent toutes par
   * `voixDe()` ou par `nomAffiche()` ; cette route servait `author.name`
   * brut, avec `isDeleted: true` à côté — le nom de quelqu'un qu'on venait
   * de retirer de la famille, en clair, à qui détient le lien familial.
   *
   * L'anonymisation se fait ici, à la sortie, et non dans la requête : le
   * champ `isDeleted` reste servi, parce qu'un client a besoin de savoir
   * que ce nom EST un anonymat, et non le prénom de quelqu'un.
   */
  const rendus = stories.map((story) => ({
    ...story,
    author: { ...story.author, name: nomAffiche(story.author) },
  }));

  return apiOk({ stories: rendus, total });
}

/** POST /api/family/:id/stories — créer un récit (et son passage, s'il en a un). */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  const familyId = params.id;
  if (!(await authorizeFamily(request, familyId))) return apiError('FORBIDDEN');


  const { data, errors } = parseOrNull(createStorySchema, await request.json().catch(() => null));
  if (!data) return apiError('INVALID_INPUT', errors);

  const author = await prisma.member.findFirst({
    where: { id: data.authorId, familyId, isDeleted: false },
  });
  if (!author) return apiError('NOT_FOUND', 'Auteur inconnu dans cette famille.');

  const story = await storyService.createStory(familyId, data);
  return apiOk({ id: story.id }, 201);
}
