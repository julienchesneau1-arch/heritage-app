/**
 * Préparation globale de la suite de tests.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Le journal est append-only : on ne peut ni le vider ni réparer un maillon.
 * C'est la propriété recherchée en exploitation, mais elle rend les tests non
 * idempotents — les tests de détection d'altération laissent délibérément une
 * chaîne rompue, et le lancement suivant échouerait sur une « chaîne intacte »
 * qui ne l'est plus.
 *
 * On repart donc d'un schéma neuf à chaque exécution. Recréer vaut mieux que
 * nettoyer : c'est la seule façon d'obtenir une chaîne réellement vierge, et
 * cela vérifie au passage que les migrations descendante et montante
 * fonctionnent — ce que la porte de sortie Phase 0 exige de toute façon.
 *
 * ⚠ CONSÉQUENCE DIRECTE : ce fichier DÉTRUIT le schéma de la base qu'il vise.
 *   D'où le garde-fou ci-dessous, non contournable par configuration.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Base de test par défaut. Jamais la base de développement. */
const TEST_DB = 'jarvis_test';

export default function setup(): void {
  // Charge `.env` s'il existe, comme le font les scripts npm via
  // `--env-file-if-exists`. Sans cela, `pnpm test` échouerait sur une machine
  // fraîchement installée alors que `pnpm jarvis` fonctionne — une incohérence
  // que personne ne comprendrait au premier essai.
  if (existsSync('.env')) process.loadEnvFile('.env');

  /* ---------------------------------------------------------------------- *
   * GARDE-FOU
   *
   * `.env` désigne la base de DÉVELOPPEMENT. La charger sans rien forcer
   * ferait tourner la suite sur les données réelles de l'utilisateur — et
   * comme la suite recrée le schéma, elle les effacerait.
   *
   * On force donc la base de test, puis on VÉRIFIE que le nom retenu contient
   * bien « test ». Deux barrières plutôt qu'une : la seconde tient même si
   * quelqu'un surcharge la première par variable d'environnement.
   * ---------------------------------------------------------------------- */
  process.env['JARVIS_ENV'] = 'test';
  process.env['JARVIS_DB_NAME'] = process.env['JARVIS_TEST_DB_NAME'] ?? TEST_DB;

  const target = process.env['JARVIS_DB_NAME'];
  if (target === undefined || !target.includes('test')) {
    throw new Error(
      `Refus de lancer les tests sur la base « ${target ?? '?'} » : ` +
        'son nom ne contient pas « test ». La suite recrée le schéma et ' +
        'détruirait les données. Corriger JARVIS_TEST_DB_NAME.',
    );
  }

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
