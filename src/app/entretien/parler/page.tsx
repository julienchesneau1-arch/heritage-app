import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { entretienService, ENTRETIEN, avertissement } from '@/services/entretien.service';
import { prisma } from '@/lib/prisma';
import { deposerEntretien, effacerEntretien } from '@/app/actions';
import { AudioRecorder } from '@/components/AudioRecorder';

export const dynamic = 'force-dynamic';

/**
 * L'ENTRETIEN — l'écran où l'on parle.
 *
 * Un écran. Une question. Un bouton.
 *
 * Ce qu'il n'y a PAS, et chaque absence est un choix :
 *
 *  · Aucun compteur, aucune progression, aucune durée cible. Ce n'est pas
 *    une séance : on s'arrête quand on veut.
 *  · Aucun encouragement. L'application pose une question et se tait — elle
 *    ne dit pas « intéressant, continuez ».
 *  · « Passer » est là, de la même taille que le reste, et ne demande
 *    jamais pourquoi. Passer une question ne s'explique pas.
 *  · Deux passages sur le même sujet et l'on cesse de le proposer,
 *    silencieusement : un signal comportemental ne peut que retirer.
 */
export default async function ParlerPage({
  searchParams,
}: {
  searchParams: { relecteur?: string; passees?: string; garde?: string; efface?: string; erreur?: string };
}) {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const relecteurId = searchParams.relecteur ?? '';
  const relecteur = relecteurId
    ? await prisma.member.findFirst({
        where: { id: relecteurId, familyId: context.family.id, isDeleted: false },
        select: { id: true, name: true },
      })
    : null;

  // Sans relecteur nommé, on ne commence pas : la promesse « ce que vous
  // direz sera relu par X » ne peut pas se faire à moitié.
  if (!relecteur || relecteur.id === context.member.id) redirect('/entretien?erreur=relecteur');

  const passees = (searchParams.passees ?? '').split(',').filter(Boolean).slice(0, 20);
  const question = await entretienService.prochaineQuestion(
    context.family.id,
    context.member.id,
    passees,
  );

  // Ce qui vient d'être déposé, et qui appartient encore à celui qui a parlé.
  const dernier = searchParams.garde
    ? await prisma.transcriptionDraft.findFirst({
        where: { familyId: context.family.id, spokenById: context.member.id, storyId: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, promptText: true },
      })
    : null;

  const suivantes = [...passees, question.entityId].filter(Boolean).join(',');

  return (
    <div className="space-y-10">
      <p className="justification">{avertissement(relecteur.name)}</p>

      {dernier ? (
        <section className="space-y-4 border border-rule p-5">
          <h2 className="section-label">C’est enregistré</h2>
          <p className="leading-relaxed">{ENTRETIEN.reecoute}</p>
          <p className="justification">
            {relecteur.name} le relira. Tant que rien n’en est né, ces mots sont à vous : les
            effacer ne laisse rien, et {relecteur.name} verra seulement qu’il n’y a rien à relire.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link href={`/entretien/parler?relecteur=${relecteur.id}&passees=${encodeURIComponent(suivantes)}`} className="btn-primary">
              Question suivante
            </Link>
            {/* Le brouillon appartient à celui qui a PARLÉ, pas au relecteur. */}
            <form action={effacerEntretien}>
              <input type="hidden" name="draftId" value={dernier.id} />
              <button type="submit" className="justification underline">
                {ENTRETIEN.effacer}
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {searchParams.efface ? (
        <p className="justification">C’est effacé. Il n’en reste rien.</p>
      ) : null}
      {searchParams.erreur === 'vide' ? (
        <p className="justification text-accent">Aucun son n’a été capté. Rien n’a été gardé.</p>
      ) : null}
      {searchParams.erreur === 'lourd' ? (
        <p className="justification text-accent">
          L’enregistrement est trop long pour être déposé d’un coup. Reprenez en plusieurs fois.
        </p>
      ) : null}

      <section className="space-y-4">
        {/* La question, en grand. C'est le seul texte à lire de cet écran. */}
        <h1 className="text-3xl leading-tight">{question.texte}</h1>
        {/* §6.2 : toute suggestion porte sa justification, y compris posée
            à voix haute. */}
        <p className="justification">{question.justification}</p>
      </section>

      <form action={deposerEntretien} className="space-y-5 border-t border-rule pt-6">
        <input type="hidden" name="relecteurId" value={relecteur.id} />
        <input type="hidden" name="question" value={question.texte} />
        <input type="hidden" name="passees" value={passees.join(',')} />
        {/* Invisible à l'œil, bien réel pour un lecteur d'écran : un champ sans
            nom s'annonce « champ de fichier », et rien d'autre. `sr-only` cache
            à la vue, pas à l'assistance. */}
        <label htmlFor="audio" className="sr-only">
          Enregistrement de votre réponse
        </label>
        <input id="audio" type="file" name="audio" accept="audio/*" className="sr-only" />

        <AudioRecorder inputId="audio" />

        <button type="submit" className="btn-primary w-full text-base">
          {ENTRETIEN.garder}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-6 border-t border-rule pt-6">
        {/* « Passer » ne demande jamais pourquoi, et n'est pas plus discret
            que « Garder ». */}
        <Link
          href={`/entretien/parler?relecteur=${relecteur.id}&passees=${encodeURIComponent(suivantes)}`}
          className="btn"
        >
          {ENTRETIEN.passer}
        </Link>
        <Link href="/" className="justification underline">
          {ENTRETIEN.terminer}
        </Link>
      </div>
    </div>
  );
}
