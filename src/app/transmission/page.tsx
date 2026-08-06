import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { metricsService } from '@/services/metrics.service';
import { conservateur } from '@/services/conservateur.service';
import { formatDateFr } from '@/lib/normalize';
import { enPourcentage, raisonDe } from '@/lib/honnetete';

export const dynamic = 'force-dynamic';

/**
 * CE QUE L'APPLICATION FAIT DE VOTRE MÉMOIRE — reddition de comptes.
 *
 * ── Ce que cette page a cessé d'être ──
 *
 * Elle s'appelait « Transmission » et s'ouvrait sur « 23 % » en corps 4xl :
 * la part des récits ayant engendré un autre récit, avec une cible V1 de
 * 20 % (§9.1). C'était MON tableau de bord, servi à la famille comme un
 * bulletin scolaire. La §12 interdit le score, et pour une raison que la
 * §9 ne dit pas : une famille ne peut rien faire d'un pourcentage, sinon
 * écrire pour le faire monter — c'est-à-dire l'optimisation d'engagement
 * que la même ligne interdit. Le taux de transmission, la latence médiane,
 * la profondeur de chaîne et la conversion des fils n'ont pas disparu :
 * ils sont dans `/api/family/:id/metrics` et dans l'export (amendement 3),
 * où ils mesurent le PRODUIT, ce qu'ils ont toujours été.
 *
 * ── Ce qu'elle reste, et qui est dû ──
 *
 * Ce que l'algorithme écarte, met en sourdine ou n'a jamais remontré. La
 * §6.3 donne à la famille le contrôle, l'Annexe A point 5 lui garantit
 * qu'aucun récit ne devient inaccessible par effet d'algorithme : ni l'une
 * ni l'autre ne tient si le produit ne dit pas ce qu'il fait. Cette
 * reddition-là n'est pas un score — c'est une comptabilité que le produit
 * rend de lui-même, y compris quand elle l'accuse.
 *
 * Et un zéro n'y vaut jamais pour une mesure : sans lecture enregistrée,
 * « distorsion 0/100 » se lirait « mémoire parfaitement fidèle » alors
 * qu'on n'a rien pu regarder (amendement 6, clause 1).
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
    <div className="space-y-6">
      <h1 className="text-[2rem] leading-[1.12]">Ce que l’application fait de votre mémoire</h1>

      <p className="leading-relaxed">
        Cette application choisit ce qu’elle vous montre, et ce choix exclut le reste. Voici ce
        qu’elle écarte, ce qu’elle tait, et ce qu’elle n’a jamais remontré.
      </p>

      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Ce que l’algorithme écarte</h2>

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

      {/* Ce chiffre-ci n'est pas une note donnée à la famille : il mesure un
          biais que la FORME du produit introduit. Un fil écrit avantage le
          clavier rapide, et sans cette ligne on ne saurait pas si l'interface
          a fait taire ceux qui ne tapent pas. Il reste donc ici. */}
      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Ce que la forme du produit fait à la parole</h2>
        <dl className="space-y-2">
          <Row
            label="La voix, pas le clavier"
            value={enPourcentage(metrics.narratedShare)}
            note={raisonDe(
              metrics.narratedShare,
              'Part des messages notés par quelqu’un d’autre que celui qui parle. Un fil écrit avantage le clavier rapide ; cette mesure dit de combien.',
            )}
          />
        </dl>
      </section>

      {forgotten.length > 0 ? (
        <section className="carte space-y-3">
          <h2 className="text-xl leading-snug">Rappel patrimonial</h2>
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

      {/* Retirer un chiffre sans le dire serait le retirer deux fois. */}
      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Ce qui ne figure plus ici</h2>
        <p className="justification">
          Cette page affichait en grand la part de vos récits qui en avaient suscité d’autres, et
          le seuil qu’il aurait fallu franchir. C’était une note donnée à une famille sur sa façon
          de se souvenir, et rien n’en découlait qu’on puisse faire de bonne foi. Ces chiffres
          mesurent l’application, pas vous : ils restent dans l’export, qui vous appartient.
        </p>
      </section>
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-2">
      <dt className="font-sans text-base">
        {label}
        <span className="justification block">{note}</span>
      </dt>
      <dd className="text-lg tabular-nums">{value}</dd>
    </div>
  );
}
