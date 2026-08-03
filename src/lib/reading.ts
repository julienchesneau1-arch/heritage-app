import { cookies } from 'next/headers';

/**
 * Confort de lecture.
 *
 * Le réglage est par APPAREIL, pas par membre : la tablette de la
 * grand-mère n'a pas les mêmes yeux que le téléphone de sa petite-fille,
 * et c'est souvent le même compte familial qui sert sur les deux.
 *
 * Ce n'est pas une préférence esthétique, c'est une condition d'accès.
 * Un récit qu'on ne peut pas lire n'est pas transmis.
 */
export const READING_COOKIE = 'lecture';

export const READING_SIZES = ['normale', 'grande', 'tres-grande'] as const;
export type ReadingSize = (typeof READING_SIZES)[number];

export const READING_LABELS: Record<ReadingSize, string> = {
  normale: 'Normale',
  grande: 'Grande',
  'tres-grande': 'Très grande',
};

/** Appliqué sur <html> : tout le reste est dimensionné en rem. */
export const READING_ROOT_CLASS: Record<ReadingSize, string> = {
  normale: '',
  grande: 'text-[19px]',
  'tres-grande': 'text-[22px]',
};

export function isReadingSize(value: string): value is ReadingSize {
  return (READING_SIZES as readonly string[]).includes(value);
}

export function currentReadingSize(): ReadingSize {
  const value = cookies().get(READING_COOKIE)?.value;
  return value && isReadingSize(value) ? value : 'normale';
}
