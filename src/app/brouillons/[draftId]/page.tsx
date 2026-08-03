import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { prisma } from '@/lib/prisma';
import { discardTranscription, validateTranscription } from '@/app/actions';
import {
  DOUBT_LABELS,
  formatTimecode,
  type DoubtReason,
  type ReviewedSegment,
} from '@/lib/transcription-doubt';
import { compareTranscriptions, consensusSummary } from '@/lib/transcription-consensus';
import { LocalTranscription } from '@/components/LocalTranscription';

export const dynamic = 'force-dynamic';

/**
 * Écran de vérification.
 *
 * On ne relit pas un texte : on le CONFRONTE à l'enregistrement. L'audio est
 * en haut, les segments horodatés en dessous, et les passages où le modèle a
 * douté sont signalés avec la raison. Le texte reste entièrement modifiable —
 * c'est la famille qui écrit, la machine n'a fait qu'une proposition.
 */
export default async function DraftPage({
  params,
  searchParams,
}: {
  params: { draftId: string };
  searchParams: { erreur?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const draft = await prisma.transcriptionDraft.findFirst({
    where: { id: params.draftId, familyId: context.family.id },
    include: { archive: true, requestedBy: { select: { name: true } } },
  });
  if (!draft) notFound();

  if (draft.status !== 'ready') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl">{draft.archive.title}</h1>
        <audio controls preload="none" className="w-full">
          <source
            src={`/api/family/${context.family.id}/archives/${draft.archive.id}/file`}
            type={draft.archive.mimeType}
          />
        </audio>
        <p className="leading-relaxed">
          {draft.status === 'pending'
            ? 'La transcription n’a pas encore été faite. L’enregistrement, lui, est conservé.'
            : draft.status === 'failed'
              ? `La transcription a échoué : ${draft.error}`
              : 'Ce brouillon a déjà été traité.'}
        </p>

        {draft.status !== 'validated' ? (
          <section className="space-y-2 border-t border-rule pt-6">
            <h2 className="section-label">Transcrire sans rien envoyer, sans rien payer</h2>
            <LocalTranscription
              familyId={context.family.id}
              draftId={draft.id}
              audioUrl={`/api/family/${context.family.id}/archives/${draft.archive.id}/file`}
              role="first"
            />
          </section>
        ) : null}

        <Link href="/brouillons" className="btn">
          Retour
        </Link>
      </div>
    );
  }

  const segments = (draft.segments ?? []) as unknown as ReviewedSegment[];
  const suspects = segments.filter((segment) => segment.suspect);
  const removed = segments.filter((segment) => segment.artifact);

  // Deux modèles indépendants n'inventent pratiquement jamais la même chose :
  // le désaccord désigne les passages à réécouter, bien mieux que n'importe
  // quel indicateur de confiance.
  const consensus =
    draft.secondText && draft.rawText
      ? compareTranscriptions(draft.rawText, draft.secondText)
      : null;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link href="/brouillons" className="justification underline">
          ← À mettre au propre
        </Link>
        <h1 className="text-2xl">Écouter et relire</h1>
        <p className="justification">
          La transcription est faite par une machine qui prédit du texte. Elle se trompe, et il lui
          arrive d’inventer des phrases entières — surtout sur les silences et les hésitations.
          L’enregistrement ci-dessous fait foi ; le texte n’en est qu’une proposition.
        </p>
      </div>

      <audio controls preload="metadata" className="w-full">
        <source
          src={`/api/family/${context.family.id}/archives/${draft.archive.id}/file`}
          type={draft.archive.mimeType}
        />
        Votre navigateur ne peut pas lire cet enregistrement.
      </audio>

      {removed.length > 0 ? (
        <section className="space-y-2 border-l-2 border-accent pl-3">
          <h2 className="section-label">Retiré automatiquement</h2>
          <p className="justification">
            {removed.length} passage{removed.length > 1 ? 's' : ''} correspond
            {removed.length > 1 ? 'ent' : ''} à des phrases que ce modèle produit sur les silences, et
            qui n’ont jamais été prononcées :
          </p>
          <ul className="space-y-1">
            {removed.map((segment, index) => (
              <li key={index} className="justification">
                {formatTimecode(segment.start)} — « {segment.text} »
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {consensus ? (
        <section className="space-y-3 border-t border-rule pt-6">
          <h2 className="section-label">Deux transcriptions comparées</h2>
          <p className="leading-relaxed">{consensusSummary(consensus)}</p>
          <p className="leading-relaxed">
            {consensus.tokens.map((token, index) =>
              token.kind === 'agreed' ? (
                <span key={index}>{token.a} </span>
              ) : (
                <mark
                  key={index}
                  className="bg-transparent underline decoration-accent decoration-2 underline-offset-4"
                  title={`Autre version : ${token.b ?? '(rien)'}`}
                >
                  {token.a ?? `[${token.b} ?]`}{' '}
                </mark>
              ),
            )}
          </p>
          <p className="justification">
            Souligné : les deux transcriptions ne disent pas la même chose. Ce sont ces passages-là
            qu’il faut réécouter — le reste est confirmé par deux modèles indépendants.
          </p>
        </section>
      ) : (
        <section className="space-y-2 border-t border-rule pt-6">
          <h2 className="section-label">Second avis</h2>
          <p className="justification">
            Une deuxième transcription, faite par un autre modèle sur cet appareil, désigne les
            passages où les deux ne s’accordent pas. C’est le meilleur repère dont on dispose — et il
            ne coûte rien.
          </p>
          <LocalTranscription
            familyId={context.family.id}
            draftId={draft.id}
            audioUrl={`/api/family/${context.family.id}/archives/${draft.archive.id}/file`}
            role="second"
          />
        </section>
      )}

      <section className="space-y-3">
        <h2 className="section-label">
          Ce que la machine a entendu {suspects.length > 0 ? `· ${suspects.length} à vérifier` : ''}
        </h2>
        {segments.length === 0 ? (
          <p className="justification">
            Le modèle n’a pas renvoyé de découpage : tout le texte est à vérifier.
          </p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {segments
              .filter((segment) => !segment.artifact)
              .map((segment, index) => (
                <li
                  key={index}
                  className={`space-y-1 py-3 ${segment.suspect ? 'border-l-2 border-accent pl-3' : ''}`}
                >
                  <p className="leading-relaxed">
                    <span className="justification mr-2 tabular-nums">
                      {formatTimecode(segment.start)}
                    </span>
                    {segment.text}
                  </p>
                  {segment.reasons.map((reason: DoubtReason) => (
                    <p key={reason} className="justification">
                      ⚠ {DOUBT_LABELS[reason]}
                    </p>
                  ))}
                </li>
              ))}
          </ul>
        )}
      </section>

      {searchParams.erreur ? (
        <p className="justification text-accent">Un titre et un texte sont nécessaires.</p>
      ) : null}

      <form action={validateTranscription} className="space-y-5 border-t border-rule pt-6">
        <input type="hidden" name="draftId" value={draft.id} />

        <div className="space-y-1">
          <label htmlFor="narratorId" className="section-label block">
            Qui parle sur cet enregistrement ?
          </label>
          <select
            id="narratorId"
            name="narratorId"
            defaultValue=""
            className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
          >
            <option value="">{context.member.name} — c’est moi</option>
            {context.members
              .filter((member) => member.id !== context.member!.id)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="title" className="section-label block">
            Titre
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={160}
            defaultValue={draft.archive.title}
            className="min-h-[44px] w-full rounded-sm border border-rule bg-transparent px-3 font-sans"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="content" className="section-label block">
            Le récit, tel qu’il doit rester
          </label>
          <textarea
            id="content"
            name="content"
            required
            rows={16}
            maxLength={5000}
            defaultValue={draft.rawText ?? ''}
            className="w-full rounded-sm border border-rule bg-transparent p-3 font-sans leading-relaxed"
          />
          <p className="justification">
            Corrigez librement. Ce que vous enregistrez ici fait foi ; la proposition brute de la
            machine est conservée à part, sans jamais être affichée comme un récit.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className="btn-primary">
            C’est juste — enregistrer le récit
          </button>
        </div>
      </form>

      <form action={discardTranscription} className="border-t border-rule pt-6">
        <input type="hidden" name="draftId" value={draft.id} />
        <button type="submit" className="justification underline">
          Écarter cette transcription
        </button>
        <p className="justification">L’enregistrement est conservé : c’est lui, l’original.</p>
      </form>
    </div>
  );
}
