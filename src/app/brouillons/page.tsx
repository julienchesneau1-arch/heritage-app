import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { formatDateFr } from '@/lib/normalize';
import { retryTranscription } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * « À mettre au propre ».
 *
 * Les brouillons attendent ici. Rien ne les pousse, rien ne sonne, aucun
 * compteur n'apparaît ailleurs dans l'application (§6.1) : il faut venir les
 * chercher. Tant qu'un brouillon n'est pas validé, il n'est pas un récit.
 */
export default async function DraftsPage({ searchParams }: { searchParams: { erreur?: string } }) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const drafts = await prisma.transcriptionDraft.findMany({
    where: { familyId: context.family.id, status: { in: ['pending', 'ready', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    include: {
      archive: { select: { title: true, createdAt: true } },
      requestedBy: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl">À mettre au propre</h1>
      <p className="justification">
        Un enregistrement transcrit par la machine n’est pas un récit. Il attend ici que quelqu’un
        l’écoute et le relise. Rien n’entre dans la mémoire de la famille sans cette relecture.
      </p>

      {searchParams.erreur ? (
        <p className="justification text-accent">{decodeURIComponent(searchParams.erreur)}</p>
      ) : null}

      {drafts.length === 0 ? (
        <p className="justification">Aucun brouillon en attente.</p>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {drafts.map((draft) => (
            <li key={draft.id} className="space-y-2 py-4">
              <p className="text-lg">{draft.archive.title}</p>
              <p className="justification">
                Enregistré le {formatDateFr(draft.archive.createdAt)} · demandé par{' '}
                {draft.requestedBy.name}
              </p>

              {draft.status === 'pending' ? (
                <p className="justification">
                  En attente de transcription. Le texte apparaîtra ici — l’enregistrement, lui, est déjà
                  conservé.
                </p>
              ) : null}

              {draft.status === 'ready' ? (
                <>
                  <p className="justification">
                    {draft.suspectCount > 0
                      ? `${draft.suspectCount} passage${draft.suspectCount > 1 ? 's' : ''} à vérifier en priorité.`
                      : draft.source === 'local'
                        ? // Le moteur local ne rend aucun indicateur de confiance.
                          // Écrire « aucun passage signalé » laisserait croire à
                          // une assurance qui n'existe pas.
                          'Ce moteur ne dit rien de sa propre confiance : tout est à vérifier.'
                        : 'Aucun passage signalé par le modèle — la relecture reste nécessaire.'}
                  </p>
                  <Link href={`/brouillons/${draft.id}`} className="btn-primary">
                    Écouter et relire
                  </Link>
                </>
              ) : null}

              {draft.status === 'failed' ? (
                <form action={retryTranscription} className="space-y-1">
                  <input type="hidden" name="draftId" value={draft.id} />
                  <p className="justification">La transcription a échoué : {draft.error}</p>
                  <button type="submit" className="btn">
                    Réessayer
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
