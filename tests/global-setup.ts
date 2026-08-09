/**
 * Préparation globale de la suite de tests.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Le journal est append-only : on ne peut ni le vider ni réparer un maillon.
 * C'est la propriété recherchée en exploitation, mais elle rend les tests non
 * idempotents — les tests de détection d'altération laissent délibérément une
 * chaîne rompue derrière eux, et le lancement suivant échouerait sur une
 * « chaîne intacte » qui ne l'est plus.
 *
 * On repart donc d'un schéma neuf à chaque exécution. Recréer vaut mieux que
 * nettoyer : c'est la seule façon d'obtenir une chaîne réellement vierge, et
 * cela vérifie au passage que les migrations descendante et montante
 * fonctionnent — ce que la porte de sortie Phase 0 exige de toute façon.
 */
import { execFileSync } from 'node:child_process';

export default function setup(): void {
  if (
    process.env['JARVIS_DB_PASSWORD'] === undefined ||
    process.env['JARVIS_DB_PASSWORD'] === ''
  ) {
    // Pas de base configurée : les tests concernés se désactivent d'eux-mêmes
    // via `describe.skipIf`. Ce n'est pas une erreur, c'est un environnement
    // de développement sans PostgreSQL.
    return;
  }

  const run = (args: readonly string[]): void => {
    execFileSync('node', ['--import', 'tsx', 'ops/db/migrate.ts', ...args], {
      stdio: 'pipe',
      env: process.env,
    });
  };

  // Descendre toutes les migrations, puis remonter. `down` est idempotent :
  // il ne fait rien quand il n'y a plus rien à annuler.
  for (let i = 0; i < 20; i += 1) run(['down']);
  run(['up']);
}
