import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Graphe familial — §5.3.
 * Pas de zoom, pas de physique de particules. Une disposition déterministe,
 * lisible en un coup d'œil : les entités sur l'anneau extérieur, les récits
 * sur l'anneau intérieur.
 */
const COLORS: Record<string, string> = {
  PERSON: '#3b5f8a', // bleu
  PLACE: '#6b4b2a', // marron
  OBJECT: '#c1762a', // orange
  DATE: '#5c6b5a',
  CONCEPT: '#5c6b5a',
  STORY: '#9b3021', // rouge
};

const WIDTH = 640;
const HEIGHT = 640;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };

export default async function GraphPage({ searchParams }: { searchParams: { entite?: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const [entities, stories] = await Promise.all([
    prisma.entity.findMany({ where: { familyId: context.family.id }, orderBy: { name: 'asc' } }),
    prisma.story.findMany({
      where: { familyId: context.family.id, archived: false },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, linkedEntities: { select: { id: true } } },
    }),
  ]);

  const positions = new Map<string, { x: number; y: number }>();
  entities.forEach((entity, index) => {
    positions.set(entity.id, pointOnRing(index, entities.length, 260));
  });
  stories.forEach((story, index) => {
    positions.set(story.id, pointOnRing(index, stories.length, 130));
  });

  const selected = searchParams.entite
    ? entities.find((entity) => entity.id === searchParams.entite)
    : undefined;

  const relatedStories = selected
    ? stories.filter((story) => story.linkedEntities.some((entity) => entity.id === selected.id))
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Graphe</h1>

      {entities.length === 0 && stories.length === 0 ? (
        <p className="justification">Rien à relier pour l’instant.</p>
      ) : (
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full max-w-full"
            role="img"
            aria-label={`Graphe familial : ${entities.length} entités, ${stories.length} récits.`}
          >
            {stories.flatMap((story) =>
              story.linkedEntities.map((entity) => {
                const from = positions.get(story.id);
                const to = positions.get(entity.id);
                if (!from || !to) return null;
                return (
                  <line
                    key={`${story.id}-${entity.id}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="#cfc8bc"
                    strokeWidth={1}
                  />
                );
              }),
            )}

            {stories.map((story) => {
              const position = positions.get(story.id)!;
              return (
                <Node
                  key={story.id}
                  href={`/recits/${story.id}`}
                  x={position.x}
                  y={position.y}
                  color={COLORS.STORY!}
                  label={story.title}
                  radius={7}
                />
              );
            })}

            {entities.map((entity) => {
              const position = positions.get(entity.id)!;
              return (
                <Node
                  key={entity.id}
                  href={`/graphe?entite=${entity.id}`}
                  x={position.x}
                  y={position.y}
                  color={COLORS[entity.type] ?? COLORS.CONCEPT!}
                  label={entity.name}
                  radius={9}
                  showLabel
                />
              );
            })}
          </svg>
        </div>
      )}

      <p className="justification">
        Bleu : personne · marron : lieu · orange : objet · rouge : récit. Les traits sont des liens déclarés
        par la famille, jamais déduits.
      </p>

      {selected ? (
        <section className="space-y-2 border-t border-rule pt-6">
          <h2 className="section-label">{selected.name}</h2>
          {relatedStories.length === 0 ? (
            <p className="justification">Aucun récit actif ne mentionne cette entité.</p>
          ) : (
            <ul className="space-y-1">
              {relatedStories.map((story) => (
                <li key={story.id}>
                  <Link href={`/recits/${story.id}`} className="underline">
                    {story.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/graphe" className="justification underline">
            Retirer le filtre
          </Link>
        </section>
      ) : null}
    </div>
  );
}

function Node({
  href,
  x,
  y,
  color,
  label,
  radius,
  showLabel = false,
}: {
  href: string;
  x: number;
  y: number;
  color: string;
  label: string;
  radius: number;
  showLabel?: boolean;
}) {
  return (
    <a href={href}>
      <circle cx={x} cy={y} r={radius} fill={color} />
      <title>{label}</title>
      {showLabel ? (
        <text
          x={x}
          y={y - radius - 6}
          textAnchor="middle"
          fontSize={12}
          fill="#4a4642"
          fontFamily="system-ui, sans-serif"
        >
          {label.length > 18 ? `${label.slice(0, 17)}…` : label}
        </text>
      ) : null}
    </a>
  );
}

function pointOnRing(index: number, total: number, radius: number) {
  if (total === 0) return CENTER;
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: CENTER.x + radius * Math.cos(angle), y: CENTER.y + radius * Math.sin(angle) };
}
