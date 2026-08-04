import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { threadService } from '@/services/thread.service';
import { Fil } from '@/components/fil';

export const dynamic = 'force-dynamic';

/** Un fil seul — celui qu'aucun récit ne porte, ou qu'on ouvre depuis le Passeur. */
export default async function ThreadPage({ params }: { params: { threadId: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const thread = await threadService.byId(context.family.id, params.threadId);
  if (!thread) notFound();

  const ancre = thread.entityId
    ? { href: `/graphe?entite=${thread.entityId}`, label: 'Voir dans le graphe' }
    : thread.storyId
      ? { href: `/recits/${thread.storyId}`, label: 'Lire le récit' }
      : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl">{thread.title ?? 'Le fil'}</h1>
      {ancre ? (
        <p className="justification">
          <Link href={ancre.href} className="underline">
            {ancre.label}
          </Link>
        </p>
      ) : null}

      <ul className="divide-y divide-rule border-t border-rule">
        <Fil
          thread={thread}
          members={context.members}
          memberId={context.member?.id ?? null}
          retour={`/fils/${thread.id}`}
        />
      </ul>
    </div>
  );
}
