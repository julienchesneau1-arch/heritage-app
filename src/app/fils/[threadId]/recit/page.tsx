import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { threadService } from '@/services/thread.service';
import { llmOperator } from '@/services/llm-operator.service';
import { crystallizeThread } from '@/app/actions';
import { STRUCTURE_TYPES } from '@/lib/structure-types';

export const dynamic = 'force-dynamic';

/**
 * LA CRISTALLISATION — le fil devient un récit.
 *
 * C'est la pièce qui répond à « casser les codes du livre de mémoire » :
 * le livre devient la SORTIE, plus jamais l'entrée. Personne ne s'assoit
 * pour rédiger ; on parle, et quand un fil a de la matière, il se condense.
 *
 * Trois garanties, reprises telles quelles de la chaîne de transcription
 * (§3.5), et pour la même raison — la machine assemble, elle ne décide pas
 * de ce que la famille a voulu dire :
 *
 *  1. Le texte proposé est un BROUILLON modifiable, jamais un fait accompli.
 *  2. Ce que la famille a dit est affiché À CÔTÉ, intégralement : on relit
 *     la source, pas seulement la synthèse.
 *  3. Le fil survit à la cristallisation. Il devient la provenance : on
 *     pourra toujours remonter à qui a dit quoi, et vérifier.
 */
export default async function CrystallizePage({ params }: { params: { threadId: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const material = await threadService.material(context.family.id, params.threadId);
  if (!material) notFound();

  const { thread, speakers, transcript } = material;

  if (thread.crystallizedStoryId) redirect(`/recits/${thread.crystallizedStoryId}`);

  // Sans clé API, le repli est le fil lui-même : moins fluide, tout aussi
  // vrai. Aucune fonctionnalité ne dépend du modèle.
  const propose = await llmOperator.assembleThread(transcript, transcript);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <Link href={`/fils/${thread.id}`} className="justification underline">
          ← Le fil
        </Link>
        <h1 className="text-2xl">En faire un récit</h1>
      </div>

      <p className="leading-relaxed">
        Voici ce que la machine a assemblé à partir de ce que vous vous êtes dit. Rien n’y est
        ajouté. Relisez, corrigez, complétez — c’est votre texte qui sera gardé, pas le sien.
      </p>

      <form action={crystallizeThread} className="space-y-4">
        <input type="hidden" name="threadId" value={thread.id} />

        <div className="space-y-1">
          <label htmlFor="title" className="etiquette">
            Titre
          </label>
          <input
            id="title"
            name="title"
            required
            defaultValue={thread.title ?? ''}
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
            rows={14}
            required
            defaultValue={propose}
            className="champ py-3 leading-relaxed"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <label htmlFor="structureType" className="etiquette">
              Type
            </label>
            <select
              id="structureType"
              name="structureType"
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
            {/* La voix, pas le clavier : le récit revient à qui a raconté. */}
            <label htmlFor="narratorId" className="etiquette">
              Raconté par
            </label>
            <select
              id="narratorId"
              name="narratorId"
              className="champ w-auto"
            >
              <option value="">Plusieurs voix</option>
              {speakers.map((speaker) => (
                <option key={speaker.id} value={speaker.id}>
                  {speaker.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button type="submit" className="btn-primary">
          Garder ce récit
        </button>
      </form>

      {/* La source, entière, à côté du brouillon. On relit ce qui a été dit,
          pas seulement ce que la machine en a fait. */}
      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Ce qui a été dit, mot pour mot</h2>
        <ul className="space-y-2">
          {thread.messages.map((message) => (
            <li key={message.id}>
              <p className="leading-relaxed">{message.body}</p>
              <p className="justification">— {(message.narrator ?? message.author).name}</p>
            </li>
          ))}
        </ul>
        <p className="justification">
          Ce fil ne disparaîtra pas : il restera attaché au récit comme sa provenance.
        </p>
      </section>
    </div>
  );
}
