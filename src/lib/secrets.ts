/**
 * Vérification des secrets de production.
 *
 * Volontairement SANS aucune importation Node (`node:crypto`, `next/headers`) :
 * ce module est chargé par `src/instrumentation.ts`, que Next compile aussi
 * pour le runtime edge. Une seule importation impossible y casse le build.
 */

const DEV_SECRET = 'dev-secret-non-securise';
const MIN_SECRET_LENGTH = 32;

/**
 * La clé qui signe TOUS les accès : cookie familial, lien personnel, flux du
 * calendrier.
 *
 * Le repli de développement est une constante publiée dans un dépôt public.
 * Mise en ligne telle quelle, elle laisserait n'importe qui forger le cookie
 * de n'importe quelle famille et lire sa mémoire — il suffirait de lire le
 * code source. On refuse donc de servir plutôt que de laisser la porte
 * ouverte : une application de mémoire familiale qui fuit en silence est
 * pire qu'une application qui ne démarre pas.
 */
export function familySecret(): string {
  const configured = process.env.FAMILY_TOKEN_SECRET;

  if (process.env.NODE_ENV === 'production') {
    if (!configured || configured === DEV_SECRET) {
      throw new Error(
        'FAMILY_TOKEN_SECRET absent ou laissé à sa valeur de développement. ' +
          'Cette clé signe tous les accès familiaux : sans elle, les cookies de ' +
          'toutes les familles sont forgeables. Générez-la avec ' +
          '`openssl rand -hex 32` et redémarrez.',
      );
    }
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `FAMILY_TOKEN_SECRET fait ${configured.length} caractères ; il en faut au moins ${MIN_SECRET_LENGTH}.`,
      );
    }
  }

  return configured ?? DEV_SECRET;
}

/**
 * Appelée au démarrage, pour que l'échec survienne avant la première requête
 * plutôt qu'à la première visite d'une famille : un exploitant a le droit de
 * savoir tout de suite que sa mise en ligne est inutilisable.
 */
export function assertProductionSecrets(): void {
  familySecret();

  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL absent : le serveur ne peut joindre aucune mémoire.');
  }
}
