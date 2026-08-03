import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { TriggerModelService } from '@/services/trigger-model.service';
import { PasseurService } from '@/services/passeur.service';
import { dismissSignal, ignorePasseur } from './actions';

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
export default async function TodayPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  if (!context.member) redirect('/qui');

  const [signal, question] = await Promise.all([
    triggerModel.generateSignal(context.family.id, context.member.id),
    passeurService.generateQuestion(context.family.id, context.member.id),
  ]);

  return (
    <div className="space-y-12">
      <p className="text-xl leading-relaxed">
        La mémoire de la famille {context.family.name}.
      </p>

      {question ? (
        <section aria-labelledby="passeur-title" className="space-y-3 border-t border-rule pt-6">
          <h2 id="passeur-title" className="section-label">
            Le Passeur
          </h2>
          <p className="text-lg leading-relaxed">{question.text}</p>
          {/* §6.2 : la justification est toujours visible. */}
          <p className="justification">{question.justification}</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              href={`/recits/nouveau?parent=${question.storyId}&trigger=passeur`}
              className="btn-primary"
            >
              Raconter la suite
            </Link>
            <Link href={`/recits/${question.storyId}`} className="btn">
              Lire l’histoire
            </Link>
            <form action={ignorePasseur}>
              <input type="hidden" name="storyId" value={question.storyId} />
              <input type="hidden" name="ruleId" value={question.ruleId} />
              <button type="submit" className="justification underline">
                Ne plus me montrer
              </button>
            </form>
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
