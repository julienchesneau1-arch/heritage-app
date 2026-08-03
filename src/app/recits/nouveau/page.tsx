import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { createStory } from '@/app/actions';
import { MAX_CONTENT_LENGTH, STRUCTURE_TYPES, TONES } from '@/lib/structure-types';

export const dynamic = 'force-dynamic';

/**
 * Formulaire de création. Le type narratif peut être laissé vide : le
 * LLMOperator le classera, ou retombera sur `evenement-marquant`. Le
 * système n'écrit jamais le récit — seulement son étiquette.
 */
export default async function NewStoryPage({
  searchParams,
}: {
  searchParams: { parent?: string; trigger?: string; conversation?: string; erreur?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const parent = searchParams.parent
    ? await prisma.story.findFirst({
        where: { id: searchParams.parent, familyId: context.family.id },
        select: { id: true, title: true },
      })
    : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Raconter</h1>

      {parent ? (
        <p className="justification">
          Ce récit sera relié à « {parent.title} ». C’est ce lien qui fait la transmission.
        </p>
      ) : null}

      {searchParams.erreur ? (
        <p className="justification text-accent">
          Le récit n’a pas pu être enregistré : un titre et un texte sont nécessaires.
        </p>
      ) : null}

      <form action={createStory} className="space-y-5">
        {parent ? <input type="hidden" name="parentStoryId" value={parent.id} /> : null}
        {parent ? <input type="hidden" name="triggerType" value={searchParams.trigger ?? 'manual'} /> : null}
        {searchParams.conversation ? (
          <input type="hidden" name="fromConversationId" value={searchParams.conversation} />
        ) : null}

        <div className="space-y-1">
          <label htmlFor="title" className="section-label block">
            Titre
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={160}
            className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="content" className="section-label block">
            Le récit
          </label>
          <textarea
            id="content"
            name="content"
            required
            rows={12}
            maxLength={MAX_CONTENT_LENGTH}
            className="w-full rounded-sm border border-rule bg-transparent p-3 font-sans leading-relaxed"
          />
          <p className="justification">{MAX_CONTENT_LENGTH} caractères maximum.</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="entities" className="section-label block">
            Personnes, lieux, objets (facultatif)
          </label>
          <input
            id="entities"
            name="entities"
            placeholder="Robert:PERSON, Montre Omega:OBJECT, Bordeaux:PLACE"
            className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans text-sm"
          />
          <p className="justification">Séparés par des virgules. Le type par défaut est PERSON.</p>
        </div>

        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <label htmlFor="structureType" className="section-label block">
              Type de récit
            </label>
            <select
              id="structureType"
              name="structureType"
              defaultValue=""
              className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
            >
              <option value="">Laisser le système classer</option>
              {STRUCTURE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="tone" className="section-label block">
              Ton
            </label>
            <select
              id="tone"
              name="tone"
              defaultValue="factuel"
              className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
            >
              {TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="eventDate" className="section-label block">
              Date de l’événement
            </label>
            <input
              id="eventDate"
              name="eventDate"
              type="date"
              className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
            />
          </div>
        </div>

        <button type="submit" className="btn-primary">
          Enregistrer le récit
        </button>
      </form>
    </div>
  );
}
