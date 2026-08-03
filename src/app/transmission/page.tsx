import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { metricsService } from '@/services/metrics.service';
import { conservateur } from '@/services/conservateur.service';
import { formatDateFr } from '@/lib/normalize';

export const dynamic = 'force-dynamic';

/**
 * « Transmission » — §9.
 *
 * La page dit ce que le produit mesure sur lui-même, y compris ce qui
 * l'accuse (distorsion, récits invisibles). Une métrique cachée serait une
 * décision prise à la place de la famille.
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
        <p className="text-4xl">{percent(metrics.transmissionRate)}</p>
        <p className="leading-relaxed">
          des récits ont engendré au moins un autre récit.
        </p>
        <p className="justification">
          {metrics.passagesCount} passage{metrics.passagesCount > 1 ? 's' : ''} pour{' '}
          {metrics.storiesCount} récit{metrics.storiesCount > 1 ? 's' : ''}. C’est la seule métrique qui
          engage le produit : une histoire doit pouvoir en engendrer une autre.
        </p>
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Chaînes</h2>
        <dl className="space-y-2">
          <Row
            label="Latence médiane"
            value={metrics.medianLatencyDays === null ? '—' : `${metrics.medianLatencyDays} jours`}
            note="Temps écoulé entre un récit et celui qu’il a suscité."
          />
          <Row
            label="Plus longue chaîne"
            value={`${metrics.maxChainDepth} récit${metrics.maxChainDepth > 1 ? 's' : ''}`}
            note="Profondeur maximale d’une suite de transmissions."
          />
          <Row
            label="Conversations"
            value={`${metrics.conversationsConverted} / ${metrics.conversationsTotal}`}
            note="Questions posées qui sont devenues un récit."
          />
        </dl>
      </section>

      <section className="space-y-3 border-t border-rule pt-6">
        <h2 className="section-label">Ce que l’algorithme fait à votre mémoire</h2>
        <dl className="space-y-2">
          <Row
            label="Récits jamais revus depuis 12 mois"
            value={`${report.invisibleStories} / ${report.totalStories}`}
            note="Ils restent lisibles, cherchables et exportables."
          />
          <Row
            label="Récits sur-exposés"
            value={String(report.overexposedStories)}
            note="Au-delà de 15 % des affichages sur 12 mois, un récit cesse d’être suggéré."
          />
          <Row
            label="Récits en quarantaine"
            value={String(report.quarantinedStories)}
            note="Trois refus explicites d’un même membre. Réversible à tout moment."
          />
          <Row
            label="Distorsion"
            value={`${report.distortionScore} / 100`}
            note="Écart entre qui a écrit les récits et qui est réellement lu. Mesuré, pas corrigé."
          />
        </dl>
      </section>

      {forgotten.length > 0 ? (
        <section className="space-y-3 border-t border-rule pt-6">
          <h2 className="section-label">Rappel patrimonial</h2>
          <p className="justification">
            Ces récits n’ont pas été relus depuis plus de douze mois. Ils sont listés ici, et nulle part
            ailleurs : rien ne les pousse dans le flux.
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
