import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { nomAffiche, QUI } from '@/lib/deces';
import { updateStory } from '@/app/actions';
import { MAX_CONTENT_LENGTH, STRUCTURE_TYPES, TONES } from '@/lib/structure-types';

export const dynamic = 'force-dynamic';

/**
 * Corriger un récit.
 *
 * Ce n'est pas du confort : sans cette page, la seule façon de rattraper
 * une faute dans un récit dicté était de supprimer et retaper — et la
 * suppression efface les Passages, c'est-à-dire les chaînes de transmission
 * que le produit mesure. Corriger une virgule coûtait le North Star.
 */
export default async function EditStoryPage({
  params,
  searchParams,
}: {
  params: { storyId: string };
  searchParams: { erreur?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: context.family.id },
    include: { author: { select: QUI }, narrator: { select: QUI } },
  });
  if (!story) notFound();

  // Celui qui a saisi, ou celui qui a raconté. Personne d'autre n'a
  // autorité sur ces mots.
  const allowed = story.authorId === context.member.id || story.narratorId === context.member.id;

  if (!allowed) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl">Corriger</h1>
        <p className="leading-relaxed">
          Ce récit a été {story.narrator ? `raconté par ${nomAffiche(story.narrator)} et ` : ''}noté par{' '}
          {nomAffiche(story.author)}. Seuls eux peuvent le corriger.
        </p>
        <p className="justification">
          Si quelque chose est inexact, la voie ouverte est de poser une question sur le récit.
        </p>
        <Link href={`/recits/${story.id}`} className="btn">
          Revenir au récit
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href={`/recits/${story.id}`} className="justification underline">
        ← {story.title}
      </Link>
      <h1 className="text-2xl">Corriger</h1>
      <p className="justification">
        Les questions, les réponses et les liens de transmission de ce récit ne bougent pas.
      </p>

      {searchParams.erreur ? (
        <p className="justification text-accent">Un titre et un texte sont nécessaires.</p>
      ) : null}

      <form action={updateStory} className="space-y-5">
        <input type="hidden" name="storyId" value={story.id} />

        <div className="space-y-1">
          <label htmlFor="title" className="etiquette">
            Titre
          </label>
          <input
            id="title"
            name="title"
            defaultValue={story.title}
            required
            maxLength={160}
            className="champ"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="content" className="etiquette">
            Le récit
          </label>
          <textarea
            id="content"
            name="content"
            defaultValue={story.content}
            required
            rows={14}
            maxLength={MAX_CONTENT_LENGTH}
            className="champ py-3 leading-relaxed"
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <label htmlFor="structureType" className="etiquette">
              Type de récit
            </label>
            <select
              id="structureType"
              name="structureType"
              defaultValue={story.structureType}
              className="champ w-auto"
            >
              {STRUCTURE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="tone" className="etiquette">
              Ton
            </label>
            <select
              id="tone"
              name="tone"
              defaultValue={story.tone}
              className="champ w-auto"
            >
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="eventDate" className="etiquette">
              Date de l’événement
            </label>
            <input
              id="eventDate"
              name="eventDate"
              type="date"
              defaultValue={story.eventDate?.toISOString().split('T')[0] ?? ''}
              className="champ w-auto"
            />
          </div>
        </div>

        <button type="submit" className="btn-primary">
          Enregistrer les corrections
        </button>
      </form>
    </div>
  );
}
