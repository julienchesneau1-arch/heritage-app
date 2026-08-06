import Link from 'next/link';
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
  searchParams: { parent?: string; trigger?: string; fil?: string; erreur?: string };
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
      <h1 className="text-[2rem] leading-[1.12]">Raconter</h1>

      {/* L'autre porte, et pour beaucoup la seule praticable : les deux
          personnes qui détiennent le plus de mémoire dans une famille sont
          souvent celles qui écrivent le moins. Un lien en texte, jamais un
          bouton — il ne doit pas rivaliser avec le formulaire, seulement
          exister pour qui la page blanche arrête (§5.5). */}
      {parent ? null : (
        <p className="justification">
          Écrire n’est pas obligatoire.{' '}
          <Link href="/entretien" className="underline">
            Répondre à une question à voix haute
          </Link>{' '}
          — quelqu’un d’autre relira ce qui aura été compris.
        </p>
      )}

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

      <form action={createStory} className="carte space-y-5">
        {parent ? <input type="hidden" name="parentStoryId" value={parent.id} /> : null}
        {parent ? <input type="hidden" name="triggerType" value={searchParams.trigger ?? 'manual'} /> : null}
        {searchParams.fil ? (
          <input type="hidden" name="fromThreadId" value={searchParams.fil} />
        ) : null}

        {/* Dans une famille, celui qui raconte n'est presque jamais celui
            qui tape. Sans cette question, les plus âgés et les plus jeunes
            disparaissent de leur propre mémoire familiale. */}
        <div className="space-y-1">
          <label htmlFor="narratorId" className="etiquette">
            Qui raconte ?
          </label>
          <select
            id="narratorId"
            name="narratorId"
            defaultValue=""
            className="champ"
          >
            <option value="">{context.member.name} — je raconte moi-même</option>
            {context.members
              .filter((member) => member.id !== context.member!.id)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} — je note ce qu’il ou elle raconte
                </option>
              ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="title" className="etiquette">
            Titre
          </label>
          <input
            id="title"
            name="title"
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
            required
            rows={12}
            maxLength={MAX_CONTENT_LENGTH}
            className="champ py-3 leading-relaxed"
          />
          <p className="justification">{MAX_CONTENT_LENGTH} caractères maximum.</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="entities" className="etiquette">
            Personnes, lieux, objets (facultatif)
          </label>
          <input
            id="entities"
            name="entities"
            placeholder="Robert:PERSON, Montre Omega:OBJECT, Bordeaux:PLACE"
            className="champ"
          />
          <p className="justification">Séparés par des virgules. Le type par défaut est PERSON.</p>
        </div>

        <div className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <label htmlFor="structureType" className="etiquette">
              Type de récit
            </label>
            <select
              id="structureType"
              name="structureType"
              defaultValue=""
              className="champ w-auto"
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
            <label htmlFor="tone" className="etiquette">
              Ton
            </label>
            <select
              id="tone"
              name="tone"
              defaultValue="factuel"
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
              className="champ w-auto"
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
