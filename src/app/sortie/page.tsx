import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadContext } from '@/lib/context';
import { FORMAT_COFFRE } from '@/lib/coffre';

export const dynamic = 'force-dynamic';

/**
 * EMPORTER LA MÉMOIRE.
 *
 * Annexe A point 7 : « le succès ultime est que la famille continue de
 * transmettre sans l'app ». Cette page est l'endroit où cette phrase cesse
 * d'être une intention.
 *
 * Elle ne demande rien et ne relance personne (§12) : le produit s'accuse
 * lui-même — c'est la seule tournure que la §6.2 autorise ici, la même que
 * le « rappel patrimonial ». La responsabilité de la copie n'est PAS
 * renvoyée à la famille : c'est le serveur qui est faillible, et c'est lui
 * qui le dit.
 */
export default async function SortiePage() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');

  return (
    <div className="space-y-8">
      <h1 className="text-[2rem] leading-[1.12]">Emporter la mémoire</h1>

      <section className="carte space-y-4">
        <h2 className="text-xl leading-snug">Un seul fichier, et cette application devient inutile</h2>
        <p className="leading-relaxed">
          Ce fichier contient toute la mémoire de la famille {context.family.name} : les récits, dans
          l’ordre de ce qui a engendré quoi, les questions restées sans réponse, et ce que le livre ne
          sait pas. Il s’ouvre dans n’importe quel navigateur, sur une machine sans connexion, et il
          s’imprime.
        </p>
        <p className="leading-relaxed">
          Il porte aussi, dans le même fichier, <strong>toutes les données au format lisible par une
          machine</strong> — de quoi reprendre cette mémoire ailleurs, dans un autre programme, dans
          vingt ans. Rien n’est perdu en chemin.
        </p>

        <a
          href={`/api/family/${context.family.id}/coffre`}
          className="btn-primary inline-block w-full text-center text-base"
        >
          Télécharger toute la mémoire
        </a>

        <p className="justification">
          Format <code>{FORMAT_COFFRE}</code>. Aucun script à l’intérieur : ce sont des pages et des
          données, rien qui s’exécute.
        </p>
      </section>

      {/* ── LE PRODUIT S'ACCUSE, IL NE RÉCLAME PAS ──
          « Vous n'avez pas fait de copie depuis 14 mois » ferait porter à
          la famille la responsabilité d'une décision du produit, ce que la
          §6.2 interdit et ce qu'un anti-pattern nomme explicitement. Le
          sujet de ces phrases est donc l'application. */}
      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Pourquoi cette page existe</h2>
        <p className="leading-relaxed">
          Cette application tourne sur un serveur, et un serveur s’arrête : une panne, une facture
          impayée, quelqu’un qui n’est plus là pour s’en occuper. Une mémoire qui se promet sur
          cinquante ans ne peut pas reposer là-dessus.
        </p>
        <p className="leading-relaxed">
          Gardez ce fichier ailleurs — une clé, un disque, la boîte de quelqu’un d’autre. Le jour où
          cette adresse ne répondra plus, il n’y aura rien à récupérer : vous l’aurez déjà.
        </p>
      </section>

      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Les autres sorties</h2>
        <p className="justification">
          <Link href="/livre" className="underline">
            Le livre
          </Link>{' '}
          — la même mémoire, composée pour l’imprimante, à faire relier.
        </p>
        <p className="justification">
          <Link href={`/api/family/${context.family.id}/export`} className="underline">
            Les données seules
          </Link>{' '}
          — le fichier JSON, si vous n’avez besoin que de cela.
        </p>
        <p className="justification">
          <Link href="/restaurer" className="underline">
            Restaurer
          </Link>{' '}
          — remettre une mémoire exportée dans une application neuve.
        </p>
      </section>
    </div>
  );
}
