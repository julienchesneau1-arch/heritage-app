import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { TriggerModelService } from '@/services/trigger-model.service';
import { PasseurService, subjectOf, type PasseurQuestion } from '@/services/passeur.service';
import { dismissSignal, ignorePasseur } from './actions';
import { PremierJour } from '@/components/premier-jour';

export const dynamic = 'force-dynamic';

const triggerModel = new TriggerModelService();
const passeurService = new PasseurService();

/**
 * « Aujourd'hui » — §5.1.
 *
 * Au plus un Passeur. Au plus un signal temporel. Si les deux manquent,
 * il ne reste que le nom de la famille. Une page vide est un résultat
 * valide : c'est la parcimonie, pas une panne.
 */
/** Où l'on va pour répondre : le fil s'il existe, le récit sinon. */
function lienVersLaQuestion(question: PasseurQuestion): string {
  if (question.threadId && question.storyId) return `/recits/${question.storyId}#conversations`;
  if (question.threadId) return `/fils/${question.threadId}`;
  return `/recits/${question.storyId}#conversations`;
}

export default async function TodayPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  // Avant tout : une mémoire vide n'a rien à suggérer, et un écran muet
  // n'apprend rien à qui vient d'arriver.
  if (context.inventaire.recits === 0 && context.inventaire.fils === 0) {
    return (
      <PremierJour
        familyName={context.family.name}
        members={context.members}
        memberId={context.member.id}
      />
    );
  }

  const [signal, question] = await Promise.all([
    triggerModel.generateSignal(context.family.id, context.member.id),
    passeurService.generateQuestion(context.family.id, context.member.id),
  ]);

  return (
    <div className="space-y-12">
      <p className="font-titre text-3xl leading-tight">
        La mémoire de la famille {context.family.name}.
      </p>

      {question ? (
        <section aria-labelledby="passeur-title" className="space-y-3 pt-2">
          <h2 id="passeur-title" className="section-label">
            Le Passeur
          </h2>
          {/* La carte est la seule chose colorée de cet écran : §6.1 n'admet
              qu'une suggestion, elle a donc droit à toute l'attention — et
              une seule couleur suffit à la donner. */}
          <div className="relative space-y-4 overflow-hidden rounded-lg bg-accent-300 p-6 shadow-md">
            <span
              aria-hidden="true"
              className="rond -right-20 -top-16 h-44 w-44 bg-accent-400/60"
            />
            <p className="relative font-titre text-2xl leading-snug text-accent-900">
              {question.text}
            </p>
            {/* §6.2 : la justification est toujours visible. Sur ce fond
                clair, elle prend le gris chaud mesuré à 5,01:1. */}
            <p className="relative font-sans text-base leading-relaxed text-muted-chaud">
              {question.justification}
            </p>
          <div className="relative flex flex-col gap-3 pt-1">
            {/* Une question posée par quelqu'un appelle une réponse, pas un
                nouveau récit : l'action première change avec la règle. */}
            {question.ruleId === 'UNANSWERED_QUESTION' ? (
              <>
                {/* Une question posée dans un fil n'a pas toujours de récit :
                    on renvoie vers le fil, qui existe toujours. */}
                <Link
                  href={lienVersLaQuestion(question)}
                  className="tap w-full rounded-lg bg-accent-900 px-5 text-base font-semibold text-accent-100"
                >
                  Répondre
                </Link>
                {question.storyId ? (
                  <Link
                    href={`/recits/nouveau?parent=${question.storyId}&trigger=question`}
                    className="tap w-full rounded-lg border border-accent-900 bg-accent-200 px-5 text-base font-semibold text-accent-900"
                  >
                    En faire un récit
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <Link
                  href={`/recits/nouveau?parent=${question.storyId}&trigger=passeur`}
                  className="tap w-full rounded-lg bg-accent-900 px-5 text-base font-semibold text-accent-100"
                >
                  Raconter la suite
                </Link>
                {question.storyId ? (
                  <Link
                    href={`/recits/${question.storyId}`}
                    className="tap w-full rounded-lg border border-accent-900 bg-accent-200 px-5 text-base font-semibold text-accent-900"
                  >
                    Lire l’histoire
                  </Link>
                ) : null}
              </>
            )}
            <form action={ignorePasseur}>
              <input type="hidden" name="subjectId" value={subjectOf(question)} />
              <input type="hidden" name="ruleId" value={question.ruleId} />
              {/* §6.3 : jamais dans un menu, toujours à côté. */}
              <button type="submit" className="font-sans text-base text-accent-900 underline">
                Ne plus me montrer
              </button>
            </form>
          </div>
          </div>
        </section>
      ) : null}

      {/* Le signal passif n'a pas de section à lui : il dit déjà ce que dit
          la ligne d'accueil. L'afficher deux fois serait du remplissage. */}
      {signal && signal.type !== 'PASSIVE' ? (
        <section aria-labelledby="signal-title" className="space-y-3 border-t border-rule pt-6">
          <h2 id="signal-title" className="section-label">
            {signal.type === 'TRADITION' ? 'Tradition' : 'Rappel temporel'}
          </h2>
          <p className="text-lg leading-relaxed">{signal.payload.message}</p>
          <p className="justification">{signal.payload.justification}</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {signal.payload.storyId ? (
              <Link href={`/recits/${signal.payload.storyId}`} className="btn">
                Lire l’histoire
              </Link>
            ) : null}
            {signal.payload.traditionId ? (
              <Link href="/traditions" className="btn">
                Voir la tradition
              </Link>
            ) : null}
            <form action={dismissSignal}>
              <input type="hidden" name="signalType" value={signal.type} />
              <button type="submit" className="justification underline">
                Ne plus me montrer
              </button>
            </form>
          </div>
        </section>
      ) : null}
    </div>
  );
}
