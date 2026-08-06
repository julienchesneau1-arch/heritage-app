import { restoreBackup } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Restauration d'une sauvegarde — la seconde moitié de l'amendement 3.
 * Une mémoire qu'on peut emporter mais pas remettre n'appartient pas
 * vraiment à la famille.
 */
export default function RestorePage({
  searchParams,
}: {
  searchParams: { erreur?: string; ok?: string };
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-[2rem] leading-[1.12]">Restaurer une sauvegarde</h1>
      <p className="leading-relaxed">
        Déposez un fichier d’export Héritage. Une nouvelle famille sera créée à partir de son contenu.
      </p>
      <p className="justification">
        L’import ne fusionne jamais avec une mémoire existante et n’écrase rien : deux mémoires qui se
        recouvrent en partie ne se réconcilient pas toutes seules, et se tromper ici coûterait des récits.
      </p>

      {/* ── Dire ce qui ne revient pas, avant de le faire ──
          Cette page annonçait une seule absence : les photos. Il y en avait
          quatre, dont trois qu'un aller-retour a fait apparaître. Une
          restauration silencieuse sur ses trous se découvre des mois plus
          tard, quand on cherche ce qui manque. */}
      <section className="carte space-y-3">
        <h2 className="text-xl leading-snug">Ce qui revient, et ce qui ne revient pas</h2>
        <p className="justification">
          Reviennent : les récits avec leur texte exact, les personnes, les lieux et les objets, les
          fils et ce qui s’y est dit, les traditions, et les liens de transmission — quel récit est né
          de quel autre. Un récit suspendu revient suspendu, une mise en sourdine reste posée : un
          retrait qui ne survit pas à une restauration n’est pas un retrait.
        </p>
        <p className="justification">
          Ne reviennent pas : les <strong>photos, documents et enregistrements</strong>, car un export
          ne contient que leurs descriptions ; les <strong>brouillons de transcription</strong>, qui
          n’ont plus d’audio à relire — leur texte reste dans le fichier d’export ; le{' '}
          <strong>journal de visibilité</strong>, qui mesure une installation et non une mémoire ; et
          les <strong>réserves</strong>.
        </p>
        <p className="justification">
          Les réserves méritent leur phrase. Une réserve silencieuse a été promise invisible à toute
          la famille, et un export est un fichier que chacun peut télécharger : l’y écrire la
          trahirait. Elle n’y est donc pas, et elle est <strong>à reposer après une restauration</strong>.
          Le fichier d’export le dit lui-même, plutôt que de le taire.
        </p>
      </section>

      {searchParams.erreur ? (
        <p className="justification text-accent">{decodeURIComponent(searchParams.erreur)}</p>
      ) : null}
      {searchParams.ok ? (
        <p className="leading-relaxed">{decodeURIComponent(searchParams.ok)}</p>
      ) : null}

      <form action={restoreBackup} className="space-y-3">
        <label htmlFor="backup" className="etiquette">
          Fichier d’export (.json)
        </label>
        <input
          id="backup"
          name="backup"
          type="file"
          accept="application/json,.json"
          required
          className="block w-full font-sans text-base file:mr-3 file:min-h-[44px] file:rounded-md file:border file:border-divider file:bg-neutre-100 file:px-4 file:font-sans file:text-base"
        />
        <button type="submit" className="btn-primary">
          Restaurer
        </button>
      </form>
    </div>
  );
}
