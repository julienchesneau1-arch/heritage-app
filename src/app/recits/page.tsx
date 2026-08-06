import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { dateDuRecit, normalizeName } from '@/lib/normalize';
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

  // Un récit suspendu par son auteur ne s'affiche plus, et ne se compte
  // pas non plus : « 63 récits » dont un invisible serait un compte faux.
  const visible = { suspendedAt: null } as const;

  const [stories, total, archivedMatching] = await Promise.all([
    prisma.story.findMany({
      where: { ...filters, ...visible, ...(includeArchived ? {} : { archived: false }) },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      // `_count` chargeait les passages et les fils de chaque récit pour une
      // colonne de classement qui n'existe plus. Deux sous-requêtes par
      // ligne, cinquante lignes par page, pour rien.
      include: { author: { select: { name: true, isDeleted: true } } },
    }),
    prisma.story.count({ where: { ...filters, ...visible, ...(includeArchived ? {} : { archived: false }) } }),
    // Ce que le filtre écarte silencieusement. Sans ce compte, « aucun récit
    // ne correspond » pouvait s'afficher alors que douze récits archivés
    // correspondaient parfaitement.
    includeArchived ? Promise.resolve(0) : prisma.story.count({ where: { ...filters, ...visible, archived: true } }),
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
      <h1 className="text-[2rem] leading-[1.12]">Récits</h1>

      <form className="flex flex-wrap items-center gap-3" role="search">
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
          className="champ flex-1 basis-48"
        />
        <label htmlFor="type" className="sr-only">
          Filtrer par type de récit
        </label>
        <select
          id="type"
          name="type"
          defaultValue={type ?? ''}
          className="champ w-auto"
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
        // Une carte par récit. La liste à filets faisait un tableau ; ici,
        // chaque récit est un objet qu'on prend, ce que la §5.2 décrit.
        <ul className="space-y-3">
          {stories.map((story) => (
            <li key={story.id}>
              <Link
                href={`/recits/${story.id}`}
                className="carte block space-y-1 transition-shadow hover:shadow-sm"
              >
                <span className="block text-lg leading-snug">{story.title}</span>
                <span className="justification block">
                  {/* Le type de structure ne s'imprime plus sur chaque
                      carte : c'est une étiquette de classement, utile au
                      filtre ci-dessus et au Passeur, muette pour qui
                      cherche un souvenir. Annexe A point 2. */}
                  {story.author.isDeleted ? 'Auteur anonymisé' : story.author.name} ·{' '}
                  {dateDuRecit(story)}
                  {/* « a engendré 2 récits » a quitté cette liste. La §5.2
                      demande la chaîne de transmission SUR LE RÉCIT — « né de
                      X, a engendré Y », des liens qu'on suit. Réduite à un
                      nombre dans un index trié, la même information devient
                      une colonne de classement : un récit qui en vaudrait
                      deux. La §12 interdit le score, et la primitive du
                      produit est la moins bien placée pour y déroger. */}
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
