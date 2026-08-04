import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr, normalizeName } from '@/lib/normalize';
import { STRUCTURE_TYPES } from '@/lib/structure-types';

export const dynamic = 'force-dynamic';

/**
 * « Récits ». Ordre chronologique, toujours (amendement 5 : le Conservateur
 * ne modifie jamais l'ordre d'affichage). Les filtres sont explicites et
 * choisis par la famille — jamais suggérés.
 *
 * Cette page est la seule vue exhaustive du corpus : c'est ici qu'on vient
 * quand le graphe ou la veillée ont borné ce qu'ils montrent. Elle doit donc
 * tenir deux promesses à la fois : ne jamais charger dix mille récits d'un
 * coup, et ne jamais laisser croire qu'il n'y en a que cinquante.
 */
const PAGE_SIZE = 50;

export default async function StoriesPage({
  searchParams,
}: {
  searchParams: { q?: string; type?: string; archivees?: string; page?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const search = searchParams.q?.trim();
  const type = searchParams.type && (STRUCTURE_TYPES as readonly string[]).includes(searchParams.type)
    ? searchParams.type
    : undefined;
  const includeArchived = searchParams.archivees === '1';
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);

  const filters = {
    familyId: context.family.id,
    ...(type ? { structureType: type } : {}),
    // Recherche sur le texte normalisé : « demenagement » trouve
    // « déménagement », et personne ne tape les accents sur un téléphone.
    ...(search ? { searchText: { contains: normalizeName(search) } } : {}),
  };

  const [stories, total, archivedMatching] = await Promise.all([
    prisma.story.findMany({
      where: { ...filters, ...(includeArchived ? {} : { archived: false }) },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        author: { select: { name: true, isDeleted: true } },
        _count: { select: { parentPassages: true, threads: true } },
      },
    }),
    prisma.story.count({ where: { ...filters, ...(includeArchived ? {} : { archived: false }) } }),
    // Ce que le filtre écarte silencieusement. Sans ce compte, « aucun récit
    // ne correspond » pouvait s'afficher alors que douze récits archivés
    // correspondaient parfaitement.
    includeArchived ? Promise.resolve(0) : prisma.story.count({ where: { ...filters, archived: true } }),
  ]);

  const shown = (page - 1) * PAGE_SIZE + stories.length;
  const hasNext = shown < total;

  /**
   * Tout lien de cette page conserve la recherche en cours : basculer les
   * archives ou tourner la page ne doit pas effacer ce que la famille
   * cherchait.
   */
  function linkTo({ page: target = 1, archived = includeArchived } = {}): string {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (type) params.set('type', type);
    if (archived) params.set('archivees', '1');
    if (target > 1) params.set('page', String(target));
    const query = params.toString();
    return query ? `/recits?${query}` : '/recits';
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl">Récits</h1>

      <form className="flex flex-wrap items-center gap-2" role="search">
        {/* Un formulaire GET n'envoie que ses propres champs : sans ceci,
            filtrer refermait silencieusement les archives qu'on venait
            d'ouvrir. La page, elle, doit bien repartir à 1. */}
        {includeArchived ? <input type="hidden" name="archivees" value="1" /> : null}
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
        <p className="justification">
          {/* Trois situations très différentes disaient la même phrase. */}
          {archivedMatching > 0
            ? `Aucun récit actif ne correspond. ${archivedMatching} récit${archivedMatching > 1 ? 's' : ''} archivé${archivedMatching > 1 ? 's' : ''} correspond${archivedMatching > 1 ? 'ent' : ''} — ils sont masqués par le filtre ci-dessous.`
            : search || type
              ? 'Aucun récit ne correspond à cette recherche.'
              : 'Aucun récit pour l’instant.'}
        </p>
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

      {/* Une liste paginée qui ne dit pas qu'elle l'est fait croire que le
          corpus s'arrête à sa dernière ligne. On dit donc toujours où on en
          est, et sur combien. */}
      {total > 0 ? (
        <p className="justification">
          {total <= PAGE_SIZE
            ? `${total} récit${total > 1 ? 's' : ''}.`
            : `Récits ${(page - 1) * PAGE_SIZE + 1} à ${shown} sur ${total}, du plus récent au plus ancien.`}
        </p>
      ) : null}

      {total > PAGE_SIZE ? (
        <nav className="flex items-center justify-between gap-4" aria-label="Pagination des récits">
          {page > 1 ? (
            <Link href={linkTo({ page: page - 1 })} className="btn">
              Récits plus récents
            </Link>
          ) : (
            <span />
          )}
          {hasNext ? (
            <Link href={linkTo({ page: page + 1 })} className="btn">
              Récits plus anciens
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <p className="justification">
        {includeArchived ? (
          <Link href={linkTo({ archived: false })} className="underline">
            Masquer les récits archivés
          </Link>
        ) : (
          <Link href={linkTo({ archived: true })} className="underline">
            Inclure les récits archivés
            {archivedMatching > 0
              ? ` (${archivedMatching} récit${archivedMatching > 1 ? 's' : ''} masqué${archivedMatching > 1 ? 's' : ''})`
              : ''}
          </Link>
        )}
      </p>
    </div>
  );
}
