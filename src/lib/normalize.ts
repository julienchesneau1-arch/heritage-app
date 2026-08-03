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
