/**
 * Entity.normalizedName — §2.1 règle 4 :
 * lowercase, sans accent, sans ponctuation. Utilisé pour le matching.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacritiques
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // ponctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/** "MM-JJ" en temps local, format utilisé par Tradition.monthDay. */
export function monthDayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

export function formatDateFr(date: Date | null | undefined): string {
  if (!date) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(date);
}

/**
 * La date d'un récit, en disant TOUJOURS de quelle date il s'agit.
 *
 * Le défaut corrigé : `formatDateFr(story.eventDate ?? story.createdAt)`.
 * Écrit à la même place, dans la même graisse, sans étiquette, un récit
 * sans date d'événement affichait sa date de saisie — et « La montre
 * arrêtée · 3 janvier 2026 » se lit comme la date de l'histoire. Le
 * produit affirmait une date qu'il ne connaissait pas (amendement 6).
 *
 * Le livre avait déjà tranché : `dateDe()` rend `null` plutôt que de
 * substituer. La même règle vaut à l'écran, avec une nuance — le livre
 * peut se taire, une liste triée par date de saisie doit dire sur quoi
 * elle trie. On ne cache donc pas `createdAt` : on le NOMME.
 */
export function dateDuRecit(recit: { eventDate: Date | null; createdAt: Date }): string {
  return recit.eventDate ? formatDateFr(recit.eventDate) : `noté le ${formatDateFr(recit.createdAt)}`;
}

const MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

/**
 * « 10-15 » → « le 15 octobre ». La page des traditions affichait le format
 * de STOCKAGE : « Chaque année, le 10-15 ».
 *
 * Ce n'est pas qu'inélégant. « 10-15 » se lit 15 octobre pour qui connaît la
 * convention, 10 mai pour qui lit à la française, et rien du tout pour tout
 * le monde — la date la plus ancienne d'une famille méritait mieux qu'un
 * champ de base de données recopié tel quel. Le premier du mois se dit
 * « 1er », comme partout ailleurs en français.
 *
 * Une valeur qu'on ne sait pas lire est rendue telle quelle : mieux vaut
 * afficher « le 13-45 » que d'inventer un mois.
 */
export function moisJourEnClair(monthDay: string): string {
  const match = monthDay.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return `le ${monthDay}`;

  const mois = Number(match[1]);
  const jour = Number(match[2]);
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return `le ${monthDay}`;

  return `le ${jour === 1 ? '1er' : jour} ${MOIS[mois - 1]}`;
}
