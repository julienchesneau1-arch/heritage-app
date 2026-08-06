import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { dateDuRecit, formatDateFr } from '@/lib/normalize';
import { ONE_TAP_QUESTIONS } from '@/lib/questions';
import { conservateur } from '@/services/conservateur.service';
import { AudioRecorder } from '@/components/AudioRecorder';
import {
  archiveStory,
  deleteStory,
  postMessage,
  releaseQuarantine,
  requestTranscription,
  uploadArchive,
} from '@/app/actions';
import { Fil, ChampDeParole } from '@/components/fil';
import { threadService } from '@/services/thread.service';

export const dynamic = 'force-dynamic';

/** Lecture d'un récit — §5.2. */
const DEPOT_MESSAGES: Record<string, string> = {
  vide: 'Aucun fichier n’a été choisi.',
  lourd: 'Ce fichier dépasse 25 Mo.',
  type: 'Ce type de fichier n’est pas accepté.',
};

const SUPPR_MESSAGES: Record<string, string> = {
  identite:
    'La suppression demande une identité prouvée. Ouvrez votre lien personnel — celui qui vous a été transmis à vous seul — puis réessayez.',
  auteur: 'Seul celui qui a saisi ce récit peut le supprimer.',
};

export default async function StoryPage({
  params,
  searchParams,
}: {
  params: { storyId: string };
  searchParams: { depot?: string; suppr?: string; modif?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: context.family.id },
    include: {
      author: { select: { name: true, isDeleted: true } },
      narrator: { select: { name: true, isDeleted: true } },
      linkedEntities: true,
      archives: { orderBy: { createdAt: 'asc' } },
      transcriptionDraft: {
        select: { validatedAt: true, validatedBy: { select: { name: true } }, model: true },
      },
      parentPassages: { include: { childStory: { select: { id: true, title: true } } } },
      childPassages: { include: { parentStory: { select: { id: true, title: true } } } },
    },
  });

  if (!story) notFound();

  const fils = await threadService.forStory(context.family.id, story.id);

  const depot = searchParams.depot ? DEPOT_MESSAGES[searchParams.depot] : null;
  const suppression = searchParams.suppr ? SUPPR_MESSAGES[searchParams.suppr] : null;
  const peutCorriger =
    context.member !== null &&
    (story.authorId === context.member.id || story.narratorId === context.member.id);
  const muted = context.member
    ? await prisma.storyMute.findFirst({
        where: { storyId: story.id, memberId: context.member.id },
        select: { reason: true },
      })
    : null;

  // Lecture effective : elle est journalisée, et elle compte.
  if (context.member) {
    await conservateur.registerView({
      familyId: context.family.id,
      storyId: story.id,
      memberId: context.member.id,
      context: 'home',
    });
  }

  return (
    <article className="space-y-8">
      {/* Bandeau sauge : la lecture d'un récit n'est pas la même chose que
          le reste de l'application, et la couleur le dit avant le texte. */}
      <header className="aplat relative -mt-8 space-y-2 overflow-hidden bg-sauge-700 pb-8 pt-6">
        <span aria-hidden="true" className="rond -right-12 -top-12 h-44 w-44 bg-sauge-600" />
        <Link href="/recits" className="relative font-sans text-base text-sauge-200 underline">
          ← Récits
        </Link>
        <h1 className="relative text-[2.1rem] leading-[1.1] text-neutre-100">{story.title}</h1>
        {/* La voix d'abord, la plume ensuite. */}
        <p className="relative font-sans text-base leading-relaxed text-sauge-200">
          {story.narrator
            ? `Raconté par ${story.narrator.isDeleted ? 'Membre anonymisé' : story.narrator.name}, noté par ${story.author.isDeleted ? 'Auteur anonymisé' : story.author.name}`
            : `Par ${story.author.isDeleted ? 'Auteur anonymisé' : story.author.name}`}{' '}
          · {dateDuRecit(story)} · {story.structureType} · {story.tone}
        </p>
        {/* Provenance : la famille doit toujours savoir quel texte a été
            proposé par une machine, et par qui il a été vérifié. */}
        {story.transcriptionDraft?.validatedAt ? (
          <p className="relative font-sans text-base leading-relaxed text-sauge-200">
            Transcrit automatiquement ({story.transcriptionDraft.model}), vérifié par{' '}
            {story.transcriptionDraft.validatedBy?.name ?? 'un membre'} le{' '}
            {formatDateFr(story.transcriptionDraft.validatedAt)}.
          </p>
        ) : null}
      </header>

      <div className="lire whitespace-pre-wrap pt-2">{story.content}</div>

      {story.archives.length > 0 ? (
        <section className="space-y-4">
          {story.archives.map((archive) => (
            <figure key={archive.id} className="space-y-1">
              {archive.type === 'PHOTO' ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/family/${context.family.id}/archives/${archive.id}/file`}
                  alt={archive.title}
                  className="w-full rounded-sm border border-rule"
                  loading="lazy"
                />
              ) : archive.type === 'AUDIO' ? (
                <div className="space-y-2">
                  <audio controls preload="none" className="w-full">
                    <source
                      src={`/api/family/${context.family.id}/archives/${archive.id}/file`}
                      type={archive.mimeType}
                    />
                  </audio>
                  {context.member ? (
                    <form action={requestTranscription} className="space-y-1">
                      <input type="hidden" name="archiveId" value={archive.id} />
                      <button type="submit" className="justification underline">
                        Proposer une transcription
                      </button>
                      <p className="justification">
                        Une machine proposera un texte. Il faudra l’écouter et le relire avant qu’il
                        devienne un récit — elle se trompe, et il lui arrive d’inventer.
                      </p>
                    </form>
                  ) : null}
                </div>
              ) : (
                <a
                  href={`/api/family/${context.family.id}/archives/${archive.id}/file`}
                  className="btn"
                >
                  Ouvrir « {archive.title} »
                </a>
              )}
              <figcaption className="justification">{archive.title}</figcaption>
            </figure>
          ))}
        </section>
      ) : null}

      {context.member ? (
        <form action={uploadArchive} className="space-y-2">
          <input type="hidden" name="storyId" value={story.id} />
          <label htmlFor="file" className="section-label block">
            Ajouter une photo ou un enregistrement
          </label>
          <AudioRecorder inputId="file" />
          <input
            id="file"
            name="file"
            type="file"
            accept="image/*,audio/*,application/pdf,video/mp4"
            className="block w-full font-sans text-sm file:mr-3 file:min-h-[44px] file:rounded-sm file:border file:border-rule file:bg-transparent file:px-4 file:font-sans file:text-sm"
          />
          <button type="submit" className="btn">
            Déposer
          </button>
          {depot ? <p className="justification">{depot}</p> : null}
        </form>
      ) : null}

      {story.linkedEntities.length > 0 ? (
        <p className="flex flex-wrap gap-2">
          {story.linkedEntities.map((entity) => (
            <Link
              key={entity.id}
              href={`/graphe?entite=${entity.id}`}
              className="rounded-sm border border-rule px-2 py-1 font-sans text-xs text-muted"
            >
              {entity.name}
            </Link>
          ))}
        </p>
      ) : null}

      {story.childPassages.length > 0 || story.parentPassages.length > 0 ? (
        <section className="space-y-2 border-t border-rule pt-6">
          <h2 className="section-label">Transmission</h2>
          {story.childPassages.map((passage) => (
            <p key={passage.id} className="justification">
              Né de{' '}
              <Link href={`/recits/${passage.parentStory.id}`} className="underline">
                {passage.parentStory.title}
              </Link>{' '}
              · {passage.latencyDays} jours plus tard · déclencheur : {passage.triggerType}
            </p>
          ))}
          {story.parentPassages.map((passage) => (
            <p key={passage.id} className="justification">
              A engendré{' '}
              <Link href={`/recits/${passage.childStory.id}`} className="underline">
                {passage.childStory.title}
              </Link>
            </p>
          ))}
        </section>
      ) : null}

      <section id="conversations" className="space-y-4 border-t border-rule pt-6">
        <h2 className="section-label">Le fil</h2>

        {fils.length === 0 ? (
          <p className="justification">
            Personne n’a encore parlé de ce récit. Trois mots suffisent — ce n’est pas une rédaction.
          </p>
        ) : (
          <ul className="divide-y divide-rule">
            {fils.map((fil) => (
              <Fil
                key={fil.id}
                thread={fil}
                members={context.members}
                memberId={context.member?.id ?? null}
                retour={`/recits/${story.id}`}
              />
            ))}
          </ul>
        )}

        {context.member ? (
          <div className="border-t border-rule pt-4">
            <ChampDeParole
              storyId={story.id}
              members={context.members}
              memberId={context.member.id}
              retour={`/recits/${story.id}`}
              label="Ouvrir un fil sur ce récit"
            />
            {/* Une question en un geste : le plus jeune membre a sept ans et
                n'écrira pas dans un champ de texte. */}
            <div className="flex flex-wrap gap-2 pt-3">
              {ONE_TAP_QUESTIONS.map((question) => (
                <form action={postMessage} key={question}>
                  <input type="hidden" name="storyId" value={story.id} />
                  <input type="hidden" name="body" value={question} />
                  <input type="hidden" name="isQuestion" value="1" />
                  <input type="hidden" name="retour" value={`/recits/${story.id}`} />
                  <button type="submit" className="btn">
                    {question}
                  </button>
                </form>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="flex flex-wrap items-center gap-4 border-t border-rule pt-6">
        {/* §6.3 : « Archiver » est visible, jamais caché dans un menu. */}
        <form action={archiveStory}>
          <input type="hidden" name="storyId" value={story.id} />
          <input type="hidden" name="archived" value={story.archived ? 'false' : 'true'} />
          <button type="submit" className="btn">
            {story.archived ? 'Désarchiver' : 'Archiver'}
          </button>
        </form>

        <Link href={`/recits/nouveau?parent=${story.id}&trigger=manual`} className="btn">
          Raconter la suite
        </Link>

        {peutCorriger ? (
          <Link href={`/recits/${story.id}/modifier`} className="btn">
            Corriger
          </Link>
        ) : null}

        {muted ? (
          <form action={releaseQuarantine} className="space-y-1">
            <input type="hidden" name="storyId" value={story.id} />
            <button type="submit" className="justification underline">
              Me remontrer ce récit
            </button>
            <p className="justification">
              Vous ne le voyez plus dans les suggestions ({muted.reason}). Il reste lisible et exportable,
              et les autres membres continuent de le voir.
            </p>
          </form>
        ) : null}

        {peutCorriger && story.authorId === context.member?.id ? (
          <form action={deleteStory}>
            <input type="hidden" name="storyId" value={story.id} />
            <button type="submit" className="justification underline">
              Supprimer définitivement
            </button>
          </form>
        ) : null}
      </section>

      <section className="space-y-2">
        {suppression ? <p className="justification text-accent">{suppression}</p> : null}
        {searchParams.modif === 'interdit' ? (
          <p className="justification text-accent">
            Seuls celui qui a raconté et celui qui a noté peuvent corriger ce récit.
          </p>
        ) : null}
      </section>
    </article>
  );
}
