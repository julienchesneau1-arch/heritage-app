import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { metricsService, MIN_STORIES_FOR_RATE } from '@/services/metrics.service';
import { conservateur } from '@/services/conservateur.service';
import { formatDateFr } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

/**
 * « Transmission » — §9.
 *
 * La page dit ce que le produit mesure sur lui-même, y compris ce qui
 * l'accuse. Elle doit surtout dire ce qu'il **ne mesure pas**.
 *
 * Un zéro affiché à la place d'une mesure impossible est un mensonge : sur
 * une famille sans lecture enregistrée, « distorsion 0/100 » se lit
 * « mémoire parfaitement fidèle » alors qu'on n'a rien pu regarder. Sur une
 * famille de trois récits, « transmission 0 % » se lit comme un échec alors
 * que c'est un manque de matière. Ici, l'absence de mesure s'écrit « — »,
 * et la raison est donnée.
 */
export default async function TransmissionPage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  const [metrics, report, forgotten] = await Promise.all([
    metricsService.transmission(context.family.id),
    conservateur.report(context.family.id),
    conservateur.getForgottenStories(context.family.id, 3),
  ]);

  return (
    <div className="space-y-10">
      <h1 className="text-2xl">Transmission</h1>

      <section className="space-y-2">
        {metrics.transmissionRate === null ? (
          <>
            <p className="text-4xl">—</p>
            <p className="leading-relaxed">
              Trop tôt pour dire quoi que ce soit.
            </p>
            <p className="justification">
              La famille compte {metrics.storiesCount} récit{metrics.storiesCount > 1 ? 's' : ''}. En
              dessous de {MIN_STORIES_FOR_RATE}, cette mesure ne peut même pas exprimer sa propre cible
              — viser « une histoire sur cinq » n’a pas de sens quand il y en a trois. Afficher un
              pourcentage ici serait un verdict rendu sans dossier.
            </p>
          </>
        ) : (
          <>
            <p className="text-4xl">{percent(metrics.transmissionRate)}</p>
            <p className="leading-relaxed">des récits ont engendré au moins un autre récit.</p>
            <p className="justification">
              {metrics.passagesCount} passage{metrics.passagesCount > 1 ? 's' : ''} pour{' '}
              {metrics.storiesCount} récits. C’est la seule métrique qui engage le produit : une
              histoire doit pouvoir en engendrer une autre.
            </p>
          </>
        )}
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Chaînes</h2>
        <dl className="space-y-2">
          <Row
            label="Latence médiane"
            value={metrics.medianLatencyDays === null ? '—' : `${metrics.medianLatencyDays} jours`}
            note={
              metrics.medianLatencyDays === null
                ? 'Aucun récit n’en a encore engendré un autre.'
                : 'Temps écoulé entre un récit et celui qu’il a suscité.'
            }
          />
          <Row
            label="Plus longue chaîne"
            value={
              metrics.maxChainDepth === 0
                ? '—'
                : `${metrics.maxChainDepth} récit${metrics.maxChainDepth > 1 ? 's' : ''}`
            }
            note={
              metrics.maxChainDepth === 0
                ? 'Aucune suite de transmissions pour l’instant.'
                : 'Profondeur maximale d’une suite de transmissions.'
            }
          />
          <Row
            label="Fils devenus récit"
            value={
              metrics.passeurConversion === null
                ? '—'
                : `${metrics.threadsCrystallized} / ${metrics.threadsTotal}`
            }
            note={
              metrics.passeurConversion === null
                ? 'Aucun fil n’a encore été ouvert : il n’y a pas un taux nul, il n’y a pas de taux.'
                : 'Fils de discussion qui se sont cristallisés en récit.'
            }
          />
        </dl>
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Ce que l’algorithme fait à votre mémoire</h2>

        {report.impressions === 0 ? (
          <p className="justification">
            Aucune lecture n’a encore été enregistrée. Les deux mesures qui en dépendent sont donc
            impossibles — ce qui n’est pas la même chose qu’un bon résultat.
          </p>
        ) : null}

        <dl className="space-y-2">
          <Row
            label="Récits jamais revus depuis 12 mois"
            value={`${report.invisibleStories} / ${report.totalStories}`}
            note="Ils restent lisibles, cherchables et exportables. Un récit récent n’y figure pas : il n’a pas encore eu douze mois pour être oublié."
          />
          <Row
            label="Récits sur-exposés"
            value={report.overexposedStories === null ? '—' : String(report.overexposedStories)}
            note={
              report.overexposedStories === null
                ? 'Rien à mesurer sans impressions enregistrées.'
                : 'Au-delà du double de la part moyenne, un récit cesse d’être suggéré.'
            }
          />
          <Row
            label="Récits mis en sourdine"
            value={String(report.quarantinedStories)}
            note="Trois refus explicites d’un même membre, pour ce membre seulement. Réversible à tout moment."
          />
          <Row
            label="Distorsion"
            value={report.distortionScore === null ? '—' : `${report.distortionScore} / 100`}
            note={
              report.distortionScore === null
                ? 'Non mesurable : il faut des lectures enregistrées pour comparer qui raconte et qui est lu.'
                : 'Écart entre qui raconte les récits et qui est réellement lu. Mesuré, pas corrigé.'
            }
          />
        </dl>
      </section>

      {forgotten.length > 0 ? (
        <section className="space-y-3 border-t border-rule pt-6">
          <h2 className="section-label">Rappel patrimonial</h2>
          <p className="justification">
            Ces récits existent depuis plus de douze mois et n’ont pas été relus dans cet intervalle.
            Ils sont listés ici, et nulle part ailleurs : rien ne les pousse dans le flux.
          </p>
          <ul className="space-y-2">
            {forgotten.map((story) => (
              <li key={story.id}>
                <Link href={`/recits/${story.id}`} className="underline">
                  {story.title}
                </Link>
                <span className="justification">
                  {' '}
                  · dernière lecture {story.lastViewedAt ? formatDateFr(story.lastViewedAt) : 'jamais'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-2">
      <dt className="font-sans text-sm">
        {label}
        <span className="justification block">{note}</span>
      </dt>
      <dd className="text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}
