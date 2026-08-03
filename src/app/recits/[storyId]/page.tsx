import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr } from '@/lib/normalize';
import { conservateur } from '@/services/conservateur.service';
import { answerQuestion, archiveStory, askQuestion, releaseQuarantine } from '@/app/actions';

export const dynamic = 'force-dynamic';

/** Lecture d'un récit — §5.2. */
export default async function StoryPage({ params }: { params: { storyId: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const story = await prisma.story.findFirst({
    where: { id: params.storyId, familyId: context.family.id },
    include: {
      author: { select: { name: true, isDeleted: true } },
      linkedEntities: true,
      archives: true,
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
        <p className="justification">
          Par {story.author.isDeleted ? 'Auteur anonymisé' : story.author.name} ·{' '}
          {formatDateFr(story.eventDate ?? story.createdAt)} · {story.structureType} · {story.tone}
        </p>
      </header>

      <div className="whitespace-pre-wrap text-lg leading-relaxed">{story.content}</div>

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
          <form action={askQuestion} className="space-y-2 pt-2">
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
