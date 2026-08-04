import { SOURCE_WHATSAPP } from '../whatsapp';
import { SOURCE_MESSENGER } from './messenger';
import { SOURCE_SMS } from './sms';
import type { Lecture, OptionsLecture, Source } from './modele';

export * from './modele';
export { reparerDoubleEncodage } from './messenger';

/**
 * Les sources reconnues, dans l'ordre où on les essaie.
 *
 * L'ordre compte peu : chaque lecteur a une signature distincte. Il
 * importe surtout qu'aucune détection ne repose sur la seule extension —
 * un `.txt` peut être n'importe quoi.
 */
export const SOURCES: Source[] = [SOURCE_WHATSAPP, SOURCE_MESSENGER, SOURCE_SMS];

/**
 * Quelle source a produit ce fichier ?
 *
 * On regarde le début du contenu, pas seulement le nom : c'est le contenu
 * qui fait foi. `null` quand rien ne correspond — et l'interface le dit
 * plutôt que de tenter une lecture au hasard, qui produirait un import
 * silencieusement faux.
 */
export function detecterSource(contenu: string, nomFichier: string): Source | null {
  const debut = contenu.slice(0, 4000);
  return SOURCES.find((source) => source.reconnait(debut, nomFichier)) ?? null;
}

export function lireConversation(
  contenu: string,
  nomFichier: string,
  options: OptionsLecture = {},
): { source: Source; lecture: Lecture } | null {
  const source = detecterSource(contenu, nomFichier);
  if (!source) return null;
  return { source, lecture: source.lire(contenu, options) };
}

/** Toutes les extensions acceptées, pour le sélecteur de fichier. */
export const EXTENSIONS_ACCEPTEES = [...new Set(SOURCES.flatMap((s) => s.extensions))].join(',');
