import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { threadService } from '@/services/thread.service';
import { Fil, ChampDeParole } from '@/components/fil';
import { reserveService } from '@/services/reserve.service';
import { divulguer } from '@/lib/honnetete';

export const dynamic = 'force-dynamic';

/**
 * Graphe familial — §5.3, révisé.
 *
 * La disposition en deux anneaux tenait avec six entités ; à cinquante, les
 * étiquettes se chevauchaient et le graphe ne disait plus rien. Le §5.3
 * interdit le zoom et la physique de particules, et il a raison : ce n'est
 * pas un outil d'exploration, c'est une image qu'on doit saisir d'un coup.
 *
 * On garde donc l'interdit et on change de forme : le graphe est CENTRÉ.
 * On entre par une personne, un lieu ou un objet, on voit ses voisins
 * immédiats, on se déplace de proche en proche. Le nombre de nœuds affichés
 * est borné par construction, quelle que soit la taille de la mémoire.
 *
 * ── Le graphe n'est plus une image, c'est une porte ──
 *
 * Il était décoratif : joli, et sans usage. Chaque entité porte désormais
 * SON FIL — on parle de la montre de Robert sur la page de la montre de
 * Robert, sans que personne ait eu à rédiger quoi que ce soit d'abord. Les
 * entités cessent d'être un ornement du modèle de données pour devenir la
 * navigation du produit.
 */

const COLORS: Record<string, string> = {
  PERSON: '#3b5f8a',
  PLACE: '#6b4b2a',
  OBJECT: '#c1762a',
  DATE: '#5c6b5a',
  CONCEPT: '#5c6b5a',
  STORY: '#9b3021',
};

const TYPE_LABELS: Record<string, string> = {
  PERSON: 'personne',
  PLACE: 'lieu',
  OBJECT: 'objet',
  DATE: 'date',
  CONCEPT: 'notion',
};

/**
 * Le dessin est mis à l'échelle de la colonne : sur un téléphone de 390 px,
 * 640 unités deviennent ~350 pixels, soit un facteur 0,55. Les libellés
 * étaient posés à 12 et 14 unités — c'est-à-dire rendus à 6,6 et 7,7 px à
 * l'écran. Le plancher de 16 px de la §6.4 était respecté partout SAUF
 * dans une image, là où mon test de taille ne sait pas regarder.
 *
 * Les tailles ci-dessous sont donc exprimées en unités de `viewBox` et
 * calculées pour retomber sur 16 px rendus à la largeur usuelle. Les
 * pastilles suivent : un libellé de 30 unités au-dessus d'un point de 8
 * ne serait plus un graphe mais une liste mal rangée.
 */
const WIDTH = 640;
const HEIGHT = 560;
/** 16 px rendus sur une colonne de ~350 px : 16 ÷ (350/640) ≈ 29. */
const CORPS_LIBELLE = 29;
const CORPS_CENTRE = 34;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const MAX_STORIES = 8;
const MAX_NEIGHBOURS = 12;

export default async function GraphPage({ searchParams }: { searchParams: { entite?: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const selected = searchParams.entite
    ? await prisma.entity.findFirst({
        where: { id: searchParams.entite, familyId: context.family.id },
      })
    : null;

  // ── Sans point d'entrée : l'index des entités les plus reliées ──
  if (!selected) {
    const [entities, entitiesTotal] = await Promise.all([
      prisma.entity.findMany({
        where: { familyId: context.family.id },
        include: { _count: { select: { stories: true } } },
        orderBy: [{ stories: { _count: 'desc' } }, { name: 'asc' }],
        take: 40,
      }),
      prisma.entity.count({ where: { familyId: context.family.id } }),
    ]);

    return (
      <div className="space-y-6">
        <h1 className="text-[2rem] leading-[1.12]">Graphe</h1>
        {entities.length === 0 ? (
          <p className="justification">Rien à relier pour l’instant.</p>
        ) : (
          <>
            <p className="leading-relaxed">Par où voulez-vous entrer ?</p>
            <p className="justification">
              Le graphe se lit de proche en proche : on part de quelqu’un, ou de quelque chose, et on
              suit les récits qui y mènent.
              {' '}
              {divulguer({
                affiches: entities.length,
                total: entitiesTotal,
                unite: 'éléments',
                ordre: 'les plus reliés d’abord',
              })}
            </p>
            <ul className="space-y-2">
              {entities.map((entity) => (
                <li key={entity.id}>
                  <Link
                    href={`/graphe?entite=${entity.id}`}
                    className="carte tap w-full justify-between gap-3 text-left"
                  >
                    <span className="flex items-center gap-2 text-lg">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: COLORS[entity.type] ?? COLORS.CONCEPT }}
                      />
                      {entity.name}
                    </span>
                    <span className="justification">
                      {TYPE_LABELS[entity.type] ?? entity.type} · {entity._count.stories} récit
                      {entity._count.stories > 1 ? 's' : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  // ── Voisinage immédiat : les récits liés, et ce qu'ils touchent d'autre ──
  const linkedToSelected = {
    familyId: context.family.id,
    archived: false,
      suspendedAt: null,
    linkedEntities: { some: { id: selected.id } },
  };

  // Un graphe borné qui ne dit pas ce qu'il cache affirme une complétude
  // qu'il n'a pas : huit points feraient croire que Robert n'apparaît que
  // dans huit récits. On compte donc ce qui existe, pas seulement ce qu'on
  // montre.
  const [stories, storiesTotal] = await Promise.all([
    prisma.story.findMany({
      where: linkedToSelected,
      orderBy: { createdAt: 'desc' },
      take: MAX_STORIES,
      select: {
        id: true,
        title: true,
        linkedEntities: { select: { id: true, name: true, type: true } },
      },
    }),
    prisma.story.count({ where: linkedToSelected }),
  ]);

  const fils = await threadService.forEntity(context.family.id, selected.id);
  const demandesPortees = await reserveService.demandesPortees(context.family.id, selected.id);

  const allNeighbours = new Map<string, { id: string; name: string; type: string }>();
  for (const story of stories) {
    for (const entity of story.linkedEntities) {
      if (entity.id !== selected.id) allNeighbours.set(entity.id, entity);
    }
  }
  const neighbourList = [...allNeighbours.values()].slice(0, MAX_NEIGHBOURS);
  const neighboursHidden = allNeighbours.size - neighbourList.length;

  const storyPositions = new Map(
    stories.map((story, index) => [story.id, pointOnRing(index, stories.length, 130)]),
  );
  const neighbourPositions = new Map(
    neighbourList.map((entity, index) => [entity.id, pointOnRing(index, neighbourList.length, 235)]),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[2rem] leading-[1.12]">{selected.name}</h1>
        <Link href="/graphe" className="justification underline">
          Changer de point d’entrée
        </Link>
      </div>
      {selected.description ? <p className="leading-relaxed">{selected.description}</p> : null}

      {stories.length === 0 ? (
        <p className="justification">Aucun récit actif ne mentionne cette entité.</p>
      ) : (
        <div className="overflow-x-auto">
          {/* `role="img"` déclarait l'image ATOMIQUE alors qu'elle contient
              des liens : un lecteur d'écran annonçait « image », puis
              trouvait des contrôles à l'intérieur — axe-core le nomme
              `nested-interactive`, et c'est un vrai piège de navigation.
              On retire le rôle : les liens redeviennent ce qu'ils sont, et
              le résumé passe dans un texte visible juste dessous, lisible
              par tout le monde plutôt que par les seuls lecteurs d'écran. */}
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full max-w-full"
            aria-labelledby="resume-graphe"
          >
            {stories.map((story) => {
              const position = storyPositions.get(story.id)!;
              return (
                <g key={`l-${story.id}`}>
                  <line
                    x1={CENTER.x}
                    y1={CENTER.y}
                    x2={position.x}
                    y2={position.y}
                    stroke="#cfc8bc"
                    strokeWidth={1.5}
                  />
                  {story.linkedEntities
                    .filter((entity) => neighbourPositions.has(entity.id))
                    .map((entity) => {
                      const to = neighbourPositions.get(entity.id)!;
                      return (
                        <line
                          key={`${story.id}-${entity.id}`}
                          x1={position.x}
                          y1={position.y}
                          x2={to.x}
                          y2={to.y}
                          stroke="#e3ded5"
                          strokeWidth={1}
                        />
                      );
                    })}
                </g>
              );
            })}

            {stories.map((story) => {
              const position = storyPositions.get(story.id)!;
              return (
                <a key={story.id} href={`/recits/${story.id}`}>
                  <circle cx={position.x} cy={position.y} r={12} fill={COLORS.STORY} />
                  <title>{story.title}</title>
                </a>
              );
            })}

            {neighbourList.map((entity) => {
              const position = neighbourPositions.get(entity.id)!;
              return (
                <a key={entity.id} href={`/graphe?entite=${entity.id}`}>
                  <circle
                    cx={position.x}
                    cy={position.y}
                    r={14}
                    fill={COLORS[entity.type] ?? COLORS.CONCEPT}
                  />
                  <title>{entity.name}</title>
                  <text
                    x={position.x}
                    y={position.y - 24}
                    textAnchor="middle"
                    fontSize={CORPS_LIBELLE}
                    fill="#4a4642"
                    fontFamily="system-ui, sans-serif"
                  >
                    {entity.name.length > 16 ? `${entity.name.slice(0, 15)}…` : entity.name}
                  </text>
                </a>
              );
            })}

            <circle
              cx={CENTER.x}
              cy={CENTER.y}
              r={22}
              fill={COLORS[selected.type] ?? COLORS.CONCEPT}
            />
            <text
              x={CENTER.x}
              y={CENTER.y + 48}
              textAnchor="middle"
              fontSize={CORPS_CENTRE}
              fill="#1c1917"
              fontFamily="system-ui, sans-serif"
            >
              {selected.name}
            </text>
          </svg>
        </div>
      )}

      {/* Le résumé que portait `aria-label` sur le SVG. Visible pour tout le
          monde : ce qu'on jugeait utile de dire à un lecteur d'écran l'est
          tout autant pour qui regarde une image de vingt points. */}
      <p id="resume-graphe" className="justification">
        {selected.name} : {stories.length} récit{stories.length > 1 ? 's' : ''} affiché
        {stories.length > 1 ? 's' : ''} sur {storiesTotal}, {neighbourList.length} élément
        {neighbourList.length > 1 ? 's' : ''} lié{neighbourList.length > 1 ? 's' : ''}.
      </p>

      <p className="justification">
        Bleu : personne · marron : lieu · orange : objet · rouge : récit. Les traits sont des liens
        déclarés par la famille, jamais déduits.
      </p>

      {/* Ce que l'image ne montre pas doit être dit : sans cela, huit points
          laisseraient croire qu'il n'existe que huit récits. */}
      {storiesTotal > stories.length || neighboursHidden > 0 ? (
        <p className="justification">
          Cette vue est volontairement bornée pour rester lisible d’un coup d’œil.
          {' '}
          {divulguer({
            affiches: stories.length,
            total: storiesTotal,
            unite: 'récits',
            ordre: 'les plus récents',
          })}
          {neighboursHidden > 0
            ? ` ${neighboursHidden} élément${neighboursHidden > 1 ? 's' : ''} lié${neighboursHidden > 1 ? 's' : ''} n’${neighboursHidden > 1 ? 'apparaissent' : 'apparaît'} pas ici.`
            : ''}{' '}
          La liste complète des récits reste accessible depuis « Récits ».
        </p>
      ) : null}

      <section className="carte space-y-4">
        <h2 className="text-xl leading-snug">Le fil de {selected.name}</h2>

        {fils.length === 0 ? (
          <p className="justification">
            Rien n’a encore été dit ici. Une phrase suffit — il n’y a pas de rédaction à faire.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {fils.map((fil) => (
              <Fil
                key={fil.id}
                thread={fil}
                members={context.members}
                memberId={context.member?.id ?? null}
                retour={`/graphe?entite=${selected.id}`}
              />
            ))}
          </ul>
        )}

        {/* ── UNE DEMANDE PORTÉE ──
            Quelqu'un a demandé qu'on ne parle pas de ce sujet, et a choisi
            de le dire à la famille. On l'affiche ICI, au moment d'écrire,
            dans SES mots — et l'application laisse écrire. Elle porte la
            demande, elle ne l'applique jamais : le jour où une machine
            impose le respect d'un souhait familial, ce n'est plus un acte
            de respect mais une règle qu'on contourne.

            Les réserves silencieuses ne sortent jamais d'ici : c'est la
            garantie sur laquelle tout le reste repose. */}
        {demandesPortees.length > 0 ? (
          <div className="space-y-3 rounded-lg bg-sauge-200 p-5">
            {demandesPortees.map((demande) => (
              <p key={demande.id} className="font-sans text-base leading-relaxed text-sauge-900">
                <strong>{demande.parQui}</strong> a demandé qu’on ne parle pas de cela.
                <span className="mt-1 block">« {demande.demande} »</span>
              </p>
            ))}
            <p className="font-sans text-base text-sauge-800">
              Vous pouvez écrire quand même. Cette demande vous est transmise, elle ne vous
              interdit rien.
            </p>
          </div>
        ) : null}

        {context.member ? (
          <div className="border-t border-rule pt-4">
            <ChampDeParole
              entityId={selected.id}
              members={context.members}
              memberId={context.member.id}
              retour={`/graphe?entite=${selected.id}`}
              label={`Dire quelque chose sur ${selected.name}`}
            />
          </div>
        ) : null}
      </section>

      {/* ── Les voisins, atteignables autrement qu'au doigt sur un point ──
          Le graphe est présenté comme un chemin : « on part de quelqu'un, et
          on suit les récits qui y mènent ». Suivre était pourtant réservé à
          qui parvient à toucher une pastille de neuf pixels dans une image
          mise à l'échelle. Les mêmes éléments sont donc ici, en liens de
          pleine taille — le dessin montre la forme, la liste donne le
          chemin, et la §6.4 vaut aussi pour une cible tactile. */}
      {neighbourList.length > 0 ? (
        <section className="carte space-y-3">
          <h2 className="text-xl leading-snug">Ce que ces récits touchent aussi</h2>
          <ul className="flex flex-wrap gap-2">
            {neighbourList.map((entity) => (
              <li key={entity.id}>
                <Link
                  href={`/graphe?entite=${entity.id}`}
                  className="tap rounded-lg bg-neutre-200 px-4 font-sans text-base text-ink"
                >
                  <span
                    aria-hidden
                    className="mr-2 inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: COLORS[entity.type] ?? COLORS.CONCEPT }}
                  />
                  {entity.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {stories.length > 0 ? (
        <section className="carte space-y-2">
          <h2 className="text-xl leading-snug">
            Les récits qui en parlent
            {storiesTotal > stories.length ? ` · ${stories.length} sur ${storiesTotal}` : ''}
          </h2>
          <ul className="space-y-1">
            {stories.map((story) => (
              <li key={story.id}>
                <Link href={`/recits/${story.id}`} className="underline">
                  {story.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function pointOnRing(index: number, total: number, radius: number) {
  if (total === 0) return CENTER;
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: CENTER.x + radius * Math.cos(angle), y: CENTER.y + radius * Math.sin(angle) };
}
