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
      <h1 className="text-2xl">Restaurer une sauvegarde</h1>
      <p className="leading-relaxed">
        Déposez un fichier d’export Héritage. Une nouvelle famille sera créée à partir de son contenu.
      </p>
      <p className="justification">
        L’import ne fusionne jamais avec une mémoire existante et n’écrase rien : deux mémoires qui se
        recouvrent en partie ne se réconcilient pas toutes seules, et se tromper ici coûterait des récits.
        Les photos ne sont pas restaurées — un export ne contient que leurs descriptions, pas les fichiers.
      </p>

      {searchParams.erreur ? (
        <p className="justification text-accent">{decodeURIComponent(searchParams.erreur)}</p>
      ) : null}
      {searchParams.ok ? (
        <p className="leading-relaxed">{decodeURIComponent(searchParams.ok)}</p>
      ) : null}

      <form action={restoreBackup} className="space-y-3">
        <label htmlFor="backup" className="section-label block">
          Fichier d’export (.json)
        </label>
        <input
          id="backup"
          name="backup"
          type="file"
          accept="application/json,.json"
          required
          className="block w-full font-sans text-sm file:mr-3 file:min-h-[44px] file:rounded-sm file:border file:border-rule file:bg-transparent file:px-4 file:font-sans file:text-sm"
        />
        <button type="submit" className="btn-primary">
          Restaurer
        </button>
      </form>
    </div>
  );
}
