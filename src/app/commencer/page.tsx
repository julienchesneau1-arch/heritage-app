import Link from 'next/link';
import { createFamily } from '../actions';

export const dynamic = 'force-dynamic';

/** Fondation d'une famille. Sans cette page, l'application n'a qu'un seul utilisateur. */
export default function StartPage({ searchParams }: { searchParams: { erreur?: string } }) {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl">Commencer une mémoire</h1>
        <p className="leading-relaxed">
          Une famille, et la première personne qui la porte. Le reste s’ajoutera ensuite.
        </p>
        <p className="justification">
          Il n’y a pas de mot de passe. L’accès se fera par un lien privé, que vous transmettrez vous-même
          aux vôtres.
        </p>
      </div>

      {searchParams.erreur ? (
        <p className="justification text-accent">
          Il manque un nom de famille, un prénom, ou la génération est invalide.
        </p>
      ) : null}

      <form action={createFamily} className="space-y-5">
        <div className="space-y-1">
          <label htmlFor="familyName" className="etiquette">
            Nom de la famille
          </label>
          <input
            id="familyName"
            name="familyName"
            required
            maxLength={120}
            placeholder="Martin"
            className="champ"
          />
        </div>

        <fieldset className="space-y-4 border-t border-rule pt-5">
          <legend className="section-label">Vous</legend>

          <div className="space-y-1">
            <label htmlFor="name" className="etiquette">
              Nom et prénom
            </label>
            <input
              id="name"
              name="name"
              required
              maxLength={120}
              className="champ"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <label htmlFor="generation" className="etiquette">
                Génération
              </label>
              <select
                id="generation"
                name="generation"
                defaultValue="2"
                className="champ w-auto"
              >
                <option value="1">1 — les aînés</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4 — les plus jeunes</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="birthDate" className="etiquette">
                Date de naissance
              </label>
              <input
                id="birthDate"
                name="birthDate"
                type="date"
                className="champ w-auto"
              />
            </div>
          </div>
          <p className="justification">
            Les dates ne servent qu’à une chose : que l’application sache quel jour un anniversaire tombe.
            Rien n’est envoyé nulle part.
          </p>
        </fieldset>

        <button type="submit" className="btn-primary">
          Créer la famille
        </button>
      </form>

      <p className="justification border-t border-rule pt-6">
        Vous avez déjà un export Héritage ?{' '}
        <Link href="/restaurer" className="underline">
          Restaurer une sauvegarde
        </Link>
      </p>
    </div>
  );
}
