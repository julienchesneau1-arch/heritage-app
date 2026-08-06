import { DECES } from '@/lib/deces';

export const dynamic = 'force-dynamic';

/** Affichée quand aucune famille n'est reconnue : l'URL est le secret partagé (§4.1). */
export default function WelcomePage({ searchParams }: { searchParams: { lien?: string } }) {
  return (
    <div className="space-y-4">
      <h1 className="text-[2rem] leading-[1.12]">Héritage</h1>

      {/* Un lien refusé PARCE QUE la personne est décédée doit se distinguer
          d'un lien cassé — sans quoi la famille croirait à une panne et
          ferait tourner le lien, ce qui ne réparerait rien. */}
      {searchParams.lien === 'decede' ? (
        <p className="carte leading-relaxed">{DECES.lienRefuse}</p>
      ) : null}

      <p className="leading-relaxed">
        Cette adresse n’est rattachée à aucune famille.
      </p>
      <p className="justification">
        L’accès se fait par le lien privé de votre famille, de la forme <code>/f/&lt;identifiant&gt;</code>.
        Ce lien est le secret partagé : il n’y a pas de mot de passe à retenir.
      </p>
      <p className="pt-4">
        <a href="/commencer" className="btn-primary">
          Commencer une mémoire
        </a>
      </p>
      <p className="justification">
        Ou{' '}
        <a href="/restaurer" className="underline">
          restaurer une sauvegarde
        </a>{' '}
        depuis un export Héritage.
      </p>
    </div>
  );
}
