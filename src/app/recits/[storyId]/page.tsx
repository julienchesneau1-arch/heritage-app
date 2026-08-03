import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr } from '@/lib/normalize';
import { ONE_TAP_QUESTIONS } from '@/lib/questions';
import { conservateur } from '@/services/conservateur.service';
import {
  answerQuestion,
  archiveStory,
  askQuestion,
  releaseQuarantine,
  uploadArchive,
} from '@/app/actions';

export const dynamic = 'force-dynamic';

/** Lecture d'un récit — §5.2. */
const DEPOT_MESSAGES: Record<string, string> = {
  vide: 'Aucun fichier n’a été choisi.',
  lourd: 'Ce fichier dépasse 25 Mo.',
  type: 'Ce type de fichier n’est pas accepté.',
};

export default async function StoryPage({
  params,
  searchParams,
}: {
  params: { storyId: string };
  searchParams: { depot?: string };
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
      conversations: {
        orderBy: { createdAt: 'asc' },
        include: {
          questioner: { select: { name: true } },
          responder: { select: { name: true } },
        },
      },
      parentPassages: { include: { childStory: { select: { id: true, title: true } } } },
      childPassages: { include: { parentStory: { select: { id: true, title: true } } } },
    },
  });

  if (!story) notFound();

  const depot = searchParams.depot ? DEPOT_MESSAGES[searchParams.depot] : null;

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
      <header className="space-y-1">
        <Link href="/recits" className="justification underline">
          ← Récits
        </Link>
        <h1 className="text-2xl leading-tight">{story.title}</h1>
        {/* La voix d'abord, la plume ensuite. */}
        <p className="justification">
          {story.narrator
            ? `Raconté par ${story.narrator.isDeleted ? 'Membre anonymisé' : story.narrator.name}, noté par ${story.author.isDeleted ? 'Auteur anonymisé' : story.author.name}`
            : `Par ${story.author.isDeleted ? 'Auteur anonymisé' : story.author.name}`}{' '}
          · {formatDateFr(story.eventDate ?? story.createdAt)} · {story.structureType} · {story.tone}
        </p>
      </header>

      <div className="whitespace-pre-wrap text-lg leading-relaxed">{story.content}</div>

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
                <audio controls preload="none" className="w-full">
                  <source
                    src={`/api/family/${context.family.id}/archives/${archive.id}/file`}
                    type={archive.mimeType}
                  />
                </audio>
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
        <h2 className="section-label">Conversations</h2>

        {story.conversations.length === 0 ? (
          <p className="justification">Aucune question n’a encore été posée sur ce récit.</p>
        ) : (
          <ul className="space-y-5">
            {story.conversations.map((conversation) => (
              <li key={conversation.id} className="space-y-2">
                <p className="leading-relaxed">« {conversation.questionText} »</p>
                <p className="justification">— {conversation.questioner.name} demande</p>

                {conversation.responseText ? (
                  <div className="border-l-2 border-rule pl-3">
                    <p className="leading-relaxed">« {conversation.responseText} »</p>
                    <p className="justification">— {conversation.responder?.name ?? 'Réponse'} répond</p>
                    {conversation.status !== 'converted' ? (
                      <Link
                        href={`/recits/nouveau?parent=${story.id}&trigger=question&conversation=${conversation.id}`}
                        className="justification underline"
                      >
                        En faire un récit
                      </Link>
                    ) : null}
                  </div>
                ) : context.member ? (
                  <form action={answerQuestion} className="space-y-2">
                    <input type="hidden" name="conversationId" value={conversation.id} />
                    <label htmlFor={`r-${conversation.id}`} className="sr-only">
                      Répondre
                    </label>
                    <textarea
                      id={`r-${conversation.id}`}
                      name="responseText"
                      rows={3}
                      className="w-full rounded-sm border border-rule bg-transparent p-2 font-sans text-sm"
                    />
                    <button type="submit" className="btn">
                      Répondre
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {context.member ? (
          <div className="space-y-4 pt-2">
            <form action={askQuestion} className="space-y-2">
              <input type="hidden" name="storyId" value={story.id} />
              <label htmlFor="question" className="section-label block">
                Poser une question
              </label>
              <textarea
                id="question"
                name="questionText"
                rows={2}
                className="w-full rounded-sm border border-rule bg-transparent p-2 font-sans text-sm"
              />
              <button type="submit" className="btn">
                Poser
              </button>
            </form>

            {/* Même action, sans clavier — pour les enfants, et pour tous
                ceux que la page blanche arrête. */}
            <form action={askQuestion} className="space-y-2">
              <input type="hidden" name="storyId" value={story.id} />
              <p className="justification">Ou, en un geste :</p>
              <div className="flex flex-wrap gap-2">
                {ONE_TAP_QUESTIONS.map((question) => (
                  <button key={question} type="submit" name="questionText" value={question} className="btn">
                    {question}
                  </button>
                ))}
              </div>
            </form>
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

        {story.quarantined ? (
          <form action={releaseQuarantine} className="space-y-1">
            <input type="hidden" name="storyId" value={story.id} />
            <button type="submit" className="justification underline">
              Sortir de quarantaine
            </button>
            <p className="justification">
              En quarantaine : {story.quarantineReason}. Ce récit reste lisible et exportable ; il n’est
              simplement plus suggéré.
            </p>
          </form>
        ) : null}
      </section>
    </article>
  );
}
