import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr } from '@/lib/normalize';
import { STRUCTURE_TYPES } from '@/lib/structure-types';

export const dynamic = 'force-dynamic';

/**
 * « Récits ». Ordre chronologique, toujours (amendement 5 : le Conservateur
 * ne modifie jamais l'ordre d'affichage). Les filtres sont explicites et
 * choisis par la famille — jamais suggérés.
 */
export default async function StoriesPage({
  searchParams,
}: {
  searchParams: { q?: string; type?: string; archivees?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const search = searchParams.q?.trim();
  const type = searchParams.type && (STRUCTURE_TYPES as readonly string[]).includes(searchParams.type)
    ? searchParams.type
    : undefined;
  const includeArchived = searchParams.archivees === '1';

  const stories = await prisma.story.findMany({
    where: {
      familyId: context.family.id,
      ...(includeArchived ? {} : { archived: false }),
      ...(type ? { structureType: type } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { content: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      author: { select: { name: true, isDeleted: true } },
      _count: { select: { parentPassages: true, conversations: true } },
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl">Récits</h1>

      <form className="flex flex-wrap items-center gap-2" role="search">
        <label htmlFor="q" className="sr-only">
          Chercher dans les récits
        </label>
        <input
          id="q"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Chercher"
          className="min-h-[44px] flex-1 rounded-sm border border-rule bg-transparent px-3 font-sans text-sm"
        />
        <label htmlFor="type" className="sr-only">
          Filtrer par type de récit
        </label>
        <select
          id="type"
          name="type"
          defaultValue={type ?? ''}
          className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
        >
          <option value="">Tous les types</option>
          {STRUCTURE_TYPES.map((structureType) => (
            <option key={structureType} value={structureType}>
              {structureType}
            </option>
          ))}
        </select>
        <button type="submit" className="btn">
          Filtrer
        </button>
      </form>

      {stories.length === 0 ? (
        <p className="justification">Aucun récit ne correspond.</p>
      ) : (
        <ul className="divide-y divide-rule border-t border-rule">
          {stories.map((story) => (
            <li key={story.id} className="py-4">
              <Link href={`/recits/${story.id}`} className="block space-y-1">
                <span className="text-lg leading-snug">{story.title}</span>
                <span className="justification block">
                  {story.author.isDeleted ? 'Auteur anonymisé' : story.author.name} ·{' '}
                  {formatDateFr(story.createdAt)} · {story.structureType}
                  {story._count.parentPassages > 0
                    ? ` · a engendré ${story._count.parentPassages} récit${story._count.parentPassages > 1 ? 's' : ''}`
                    : ''}
                  {story.archived ? ' · archivé' : ''}
                  {story.quarantined ? ' · en quarantaine' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="justification">
        {includeArchived ? (
          <Link href="/recits" className="underline">
            Masquer les récits archivés
          </Link>
        ) : (
          <Link href="/recits?archivees=1" className="underline">
            Inclure les récits archivés
          </Link>
        )}
      </p>
    </div>
  );
}
