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
  demanderSuspension,
  retirerDemandeSuspension,
  suspendreRecit,
  remettreRecit,
} from '@/app/actions';
import { suspensionService } from '@/services/suspension.service';
import { Fil, ChampDeParole } from '@/components/fil';
import { threadService } from '@/services/thread.service';
import { AVERTISSEMENT_TRANSCRIPTION, cheminDeTranscription } from '@/lib/sortie';

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
  searchParams: { depot?: string; suppr?: string; modif?: string; suspension?: string };
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
  const demandes = await suspensionService.demandes(context.family.id, story.id);
  const maDemande = context.member ? demandes.find((d) => d.memberId === context.member!.id) : undefined;

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
          {/* ── DEUX MOTS RETIRÉS, ET C'EST LA PARCIMONIE ──
              Cette ligne imprimait `maison-demenagement · factuel` sous le
              titre de chaque récit. Ce sont des étiquettes de CLASSEMENT :
              elles servent au filtre de la liste et au Passeur, pas à
              quelqu'un qui vient lire l'histoire de sa grand-mère.
              Annexe A point 2 : « montrer le minimum nécessaire, jamais le
              maximum possible. » Rien n'est perdu — le type reste dans le
              filtre de « Récits », dans l'API et dans l'export. Il cesse
              seulement d'être imprimé là où il n'aide personne. */}
          · {dateDuRecit(story)}
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

      {/* ══ LA PRIMITIVE, ENFIN À SA PLACE ══
          Annexe A, point 1 : « une histoire doit pouvoir engendrer une autre
          histoire. » C'est LA primitive du produit, et elle vivait en bas de
          page, dans une rangée d'outils, entre « Archiver » et « Corriger ».
          Elle avait exactement le poids visuel d'une opération de rangement.

          Elle remonte ici, contre le texte, à l'endroit où l'on vient de
          finir de lire — c'est-à-dire au seul moment où quelqu'un se dit
          « ça me rappelle que… ». La filiation déjà nouée se lit dans le
          même bloc : d'où vient ce récit, et ce qu'il a fait naître.

          Ce qui n'y est PAS : aucun compte, aucun taux, aucune incitation.
          La §12 interdit le score, et l'ancien « a engendré 2 récits » a été
          retiré de la liste pour cette raison. On montre les liens qu'on
          peut suivre, pas leur nombre. */}
      <section className="carte space-y-4">
        {story.childPassages.length > 0 ? (
          <p className="justification">
            Né de{' '}
            {story.childPassages.map((passage, index) => (
              <span key={passage.id}>
                {index > 0 ? ', ' : ''}
                <Link href={`/recits/${passage.parentStory.id}`} className="underline">
                  {passage.parentStory.title}
                </Link>
              </span>
            ))}
            .
          </p>
        ) : null}

        <Link
          href={`/recits/nouveau?parent=${story.id}&trigger=manual`}
          className="btn-primary w-full text-base"
        >
          Raconter la suite
        </Link>
        <p className="justification">
          {story.parentPassages.length > 0
            ? 'Un récit en a déjà fait naître un autre. C’est ce lien-là que la mémoire d’une famille transmet — pas le nombre de récits.'
            : 'Ce récit vous en rappelle un autre ? Écrivez-le ici : les deux resteront liés, et c’est ce lien qui fait la transmission.'}
        </p>

        {story.parentPassages.length > 0 ? (
          <ul className="space-y-1">
            {story.parentPassages.map((passage) => (
              <li key={passage.id} className="justification">
                A fait naître{' '}
                <Link href={`/recits/${passage.childStory.id}`} className="underline">
                  {passage.childStory.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

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
                      {/* Ce qui SORT, dit avant le geste et non après.
                          Le texte dépend de la configuration réelle du
                          serveur : sur une installation sans clé, annoncer
                          un départ serait faux. */}
                      <p className="justification">
                        {AVERTISSEMENT_TRANSCRIPTION[cheminDeTranscription()]}
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
          <label htmlFor="file" className="etiquette">
            Ajouter une photo ou un enregistrement
          </label>
          <AudioRecorder inputId="file" />
          <input
            id="file"
            name="file"
            type="file"
            accept="image/*,audio/*,application/pdf,video/mp4"
            className="block w-full font-sans text-base file:mr-3 file:min-h-[44px] file:rounded-md file:border file:border-divider file:bg-neutre-100 file:px-4 file:font-sans file:text-base"
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
              // Ces pastilles étaient en 12 px, hautes de 26 : deux règles de
              // la §6.4 manquées d'un coup, sur des liens qu'on suit au doigt.
              className="tap rounded-lg bg-neutre-200 px-4 font-sans text-base text-ink"
            >
              {entity.name}
            </Link>
          ))}
        </p>
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


      {/* ── LA SUSPENSION ──
          Celui qui s'estime concerné DEMANDE ; seul l'auteur suspend. Une
          suspension déclenchée par la seule objection contredirait la §2.6
          — « un membre ne peut pas décider à la place des autres » — et
          serait un veto avec des étapes en plus. */}
      <section className="space-y-4 border-t border-rule pt-6">
        {story.suspendedAt ? (
          <>
            <h2 className="section-label">Ce récit est suspendu</h2>
            <p className="leading-relaxed">
              Il n’apparaît plus dans les pages, la recherche, la veillée ni le livre. Il n’est pas
              détruit : il reste dans l’export, et les liens de transmission sont intacts.
            </p>
            {peutCorriger ? (
              <form action={remettreRecit}>
                <input type="hidden" name="storyId" value={story.id} />
                <button type="submit" className="btn">
                  Le remettre
                </button>
              </form>
            ) : null}
          </>
        ) : peutCorriger ? (
          demandes.length > 0 ? (
            <>
              <h2 className="section-label">Une demande vous a été adressée</h2>
              <ul className="space-y-3">
                {demandes.map((demande) => (
                  <li key={demande.id} className="space-y-2 rounded-lg bg-sauge-200 p-4">
                    <p className="font-sans text-base text-sauge-900">
                      <strong>{demande.parQui}</strong> demande que ce récit ne soit plus affiché.
                    </p>
                    {/* Ses mots, jamais reformulés. */}
                    {demande.motif ? (
                      <p className="font-sans text-base leading-relaxed text-sauge-800">
                        « {demande.motif} »
                      </p>
                    ) : null}
                    <form action={suspendreRecit}>
                      <input type="hidden" name="storyId" value={story.id} />
                      <input type="hidden" name="pourQui" value={demande.memberId} />
                      <button type="submit" className="btn">
                        Suspendre à sa demande
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
              <p className="justification">
                Vous décidez seul : ce sont vos mots. Suspendre n’est pas supprimer — le récit
                reste dans l’export, les liens de transmission demeurent, et vous pouvez le
                remettre à tout moment. Ne rien faire est une réponse.
              </p>
            </>
          ) : null
        ) : context.member ? (
          <>
            <h2 className="section-label">Ce récit vous concerne ?</h2>
            {maDemande ? (
              <>
                <p className="justification">
                  Votre demande a été transmise à l’auteur, avec votre nom. Lui seul peut
                  suspendre : ce sont ses mots, et personne ne décide à la place des autres.
                </p>
                <form action={retirerDemandeSuspension}>
                  <input type="hidden" name="storyId" value={story.id} />
                  <button type="submit" className="justification underline">
                    Retirer ma demande
                  </button>
                </form>
              </>
            ) : (
              <form action={demanderSuspension} className="space-y-3">
                <input type="hidden" name="storyId" value={story.id} />
                <label htmlFor="motif" className="justification block">
                  Vous pouvez demander à l’auteur de ne plus l’afficher. Votre nom lui sera dit —
                  on ne s’oppose pas anonymement. Il décide, et il peut refuser.
                </label>
                <textarea
                  id="motif"
                  name="motif"
                  rows={2}
                  placeholder="En quelques mots, si vous le souhaitez."
                  className="w-full rounded-md border border-divider bg-neutre-100 p-4 font-sans text-base"
                />
                <button type="submit" className="btn">
                  Demander la suspension
                </button>
              </form>
            )}
          </>
        ) : null}

        {searchParams.suspension === 'demandee' ? (
          <p className="justification">La demande est transmise à l’auteur.</p>
        ) : null}
        {searchParams.suspension === 'auteur' ? (
          <p className="justification">
            Ce récit est de vous : vous pouvez déjà le corriger, l’archiver ou le suspendre.
          </p>
        ) : null}
        {searchParams.suspension === 'identite' ? (
          <p className="justification text-accent">
            Suspendre demande une identité prouvée. Ouvrez votre lien personnel, puis réessayez.
          </p>
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
