import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { entretienService, ENTRETIEN, avertissement } from '@/services/entretien.service';
import { reserveService } from '@/services/reserve.service';
import { prisma } from '@/lib/prisma';
import { poserReserve, leverReserve } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * L'ENTRETIEN — l'écran d'avant.
 *
 * Deux choses se règlent ici, et elles se règlent AVANT le premier
 * enregistrement, jamais après :
 *
 *  1. QUI RELIRA. Quelqu'un qui parle seul dans une pièce doit savoir qui
 *     l'écoutera avant d'ouvrir la bouche. Sans relecteur nommé, l'entretien
 *     ne commence pas — ce n'est pas une validation de formulaire, c'est une
 *     promesse qu'on ne peut pas faire à moitié.
 *
 *  2. CE DONT ON NE VEUT PAS QU'ON PARLE. Posé une fois, jamais répété.
 *     Silencieux par défaut : une réserve visible apprendrait à toute la
 *     famille que le sujet existe et qu'il fait mal.
 */
export default async function EntretienPage({
  searchParams,
}: {
  searchParams: { erreur?: string; reserve?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const [relecteurs, miennes, entites] = await Promise.all([
    entretienService.relecteursPossibles(context.family.id, context.member.id),
    reserveService.siennes(context.family.id, context.member.id),
    prisma.entity.findMany({
      where: { familyId: context.family.id },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
      take: 60,
    }),
  ]);

  return (
    <div className="space-y-8">
      {/* L'écran d'avant porte la teinte de l'écran d'après : on entre dans
          l'entretien en le voyant venir, on n'y est pas jeté. */}
      <header className="aplat relative -mt-8 space-y-3 overflow-hidden bg-accent-700 pb-8 pt-7 text-accent-100">
        <span aria-hidden="true" className="rond -right-16 -top-20 h-52 w-52 bg-accent-800" />
        <h1 className="relative text-[2.1rem] leading-[1.12]">{ENTRETIEN.titre}</h1>
        <p className="relative max-w-[36ch] text-lg leading-relaxed">{ENTRETIEN.quoi}</p>
      </header>

      {relecteurs.length === 0 ? (
        <section className="carte space-y-4">
          <p className="leading-relaxed">
            Il faut être au moins deux : quelqu’un parle, quelqu’un d’autre relit ce que la machine
            a compris. Rien n’entre dans la mémoire sans cette relecture.
          </p>
          <Link href="/famille" className="btn-primary">
            Ajouter quelqu’un
          </Link>
        </section>
      ) : (
        <section className="carte space-y-4">
          <h2 className="section-label">Qui relira</h2>
          {/* Le relecteur est désigné à CHAQUE entretien. Un relecteur
              permanent deviendrait le dépositaire de tous les secrets de la
              maison sans que personne l'ait décidé. */}
          <form action="/entretien/parler" method="get" className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="relecteur" className="etiquette">
                Cette personne écoutera l’enregistrement
              </label>
              <select
                id="relecteur"
                name="relecteur"
                required
                className="champ"
              >
                {relecteurs.map((membre) => (
                  <option key={membre.id} value={membre.id}>
                    {membre.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="justification">
              {avertissement('cette personne')} Elle corrigera ce que la transcription aura mal
              entendu. C’est le seul moyen qu’aucune phrase inventée par une machine n’entre dans
              la mémoire de votre famille.
            </p>
            <button type="submit" className="btn-primary">
              Commencer
            </button>
          </form>
          {searchParams.erreur === 'relecteur' ? (
            <p className="justification text-accent">
              Il faut choisir quelqu’un d’autre que vous. Rien n’a été enregistré.
            </p>
          ) : null}
        </section>
      )}

      <section className="carte space-y-4">
        <h2 className="text-xl leading-snug">{ENTRETIEN.reserve}</h2>
        <p className="leading-relaxed">
          Vous pouvez demander qu’on ne vous interroge jamais sur quelque chose. Cela ne se voit
          nulle part, et personne dans la famille n’en est informé.
        </p>

        {miennes.length > 0 ? (
          <ul className="divide-y divide-rule border-y border-rule">
            {miennes.map((reserve) => (
              <li key={reserve.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                <span>
                  {reserve.entity?.name ?? reserve.sujet}
                  <span className="justification block">
                    {reserve.portee === 'portee'
                      ? 'Votre demande est montrée à qui écrit sur ce sujet.'
                      : 'Personne d’autre ne le sait.'}
                  </span>
                </span>
                <form action={leverReserve}>
                  <input type="hidden" name="reserveId" value={reserve.id} />
                  <button type="submit" className="justification underline">
                    Lever
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}

        <form action={poserReserve} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="entityId" className="etiquette">
              Une personne, un lieu, un objet
            </label>
            <select
              id="entityId"
              name="entityId"
              className="champ"
            >
              <option value="">—</option>
              {entites.map((entite) => (
                <option key={entite.id} value={entite.id}>
                  {entite.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="sujet" className="etiquette">
              Ou en vos mots
            </label>
            <input
              id="sujet"
              name="sujet"
              className="champ"
            />
          </div>

          {/* Porter la demande est un SECOND geste, explicite. Le défaut est
              le silence : une réserve visible apprendrait à toute la famille
              que le sujet existe et qu'il fait mal. */}
          <div className="space-y-3 border-t border-rule pt-4">
            <label htmlFor="porter" className="justification flex items-start gap-2">
              <input id="porter" type="checkbox" name="porter" className="mt-1 h-5 w-5" />
              <span>
                Demander aussi à la famille de ne pas en parler. Votre demande sera montrée à qui
                écrit sur ce sujet, avec votre nom. Elle n’empêche personne d’écrire.
              </span>
            </label>
            <div className="space-y-1">
              <label htmlFor="demande" className="etiquette">
                Ce que vous voulez leur dire
              </label>
              {/* §6.4 : 16 px plancher. Ces mots seront lus par la famille
                  tels quels — les saisir ne se fait pas en petit. */}
              <textarea id="demande" name="demande" rows={2} className="champ py-3" />
              <p className="justification">
                Vos mots seront affichés tels quels. L’application ne les reformule pas.
              </p>
            </div>
          </div>

          <button type="submit" className="btn">
            Enregistrer cette réserve
          </button>
        </form>

        {searchParams.reserve === 'posee' ? (
          <p className="justification">C’est noté. On ne vous en parlera plus.</p>
        ) : null}
        {searchParams.reserve === 'levee' ? (
          <p className="justification">La réserve est levée.</p>
        ) : null}
        {searchParams.erreur === 'reserve' ? (
          <p className="justification text-accent">
            Il faut désigner quelque chose : une entité, ou quelques mots.
          </p>
        ) : null}
      </section>
    </div>
  );
}
