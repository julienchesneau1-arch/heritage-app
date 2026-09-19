/**
 * « LA PREMIÈRE », « LE DEUXIÈME », « LE DERNIER » — ADR-107.
 *
 * Réponse à la ligne la plus coûteuse du banc de fluidité : `REFERENCE 0/8`.
 *
 * ⚠ CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS
 * ---------------------------------------------------------------------------
 * Il LIT une position dans une phrase. Il ne sait pas ce qu'il y a à cette
 * position, il n'interroge rien, et il ne décide de rien. C'est l'Assistant
 * qui confronte la position au dernier affichage — et qui DEMANDE dès que la
 * confrontation échoue.
 *
 * La séparation n'est pas cosmétique : `intent/engine.ts` doit rester une
 * fonction PURE du texte (ADR-073), et une lecture d'ordinal qui irait
 * chercher en base ferait dépendre la COMPRÉHENSION d'une entrée-sortie.
 *
 * ⚠ POURQUOI « DERNIER » N'EST PAS UN NOMBRE
 * ---------------------------------------------------------------------------
 * « la dernière » ne désigne pas une position, elle désigne une **place
 * relative à la fin**. La traduire en `n` ici demanderait de connaître la
 * longueur de la liste — c'est-à-dire de savoir ce qu'il y a à cette position,
 * ce que ce module refuse justement de savoir.
 *
 * Le type porte donc la distinction jusqu'au résolveur, qui, lui, a la liste.
 */

/** Une position lue dans une phrase. `DERNIER` n'est pas un rang. */
export type Ordinal = { readonly rang: number } | { readonly depuisLaFin: 1 };

/**
 * Les ordinaux écrits en toutes lettres.
 *
 * ⚠ ÉNUMÉRÉS PLUTÔT QUE DÉRIVÉS. Une table de cinq entrées est plus honnête
 * qu'un générateur qui prétendrait couvrir « vingt-troisième » : personne ne
 * dit « la vingt-troisième » en parlant d'une liste qu'il vient de voir, et
 * une liste de plus de cinq éléments se désigne par son contenu, pas par son
 * rang.
 */
const MOTS: Readonly<Record<string, number>> = {
  premier: 1,
  premiere: 1,
  deuxieme: 2,
  second: 2,
  seconde: 2,
  troisieme: 3,
  quatrieme: 4,
  cinquieme: 5,
};

/** Accents et apostrophes retirés — pour la LECTURE seulement. */
function aplati(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/['’]/gu, "'")
    .trim();
}

/**
 * Lit une position dans un fragment de phrase.
 *
 * Rend `null` quand il n'y en a pas — et `null` est une RÉPONSE : l'Assistant
 * demandera plutôt que de supposer la première.
 */
export function litUnOrdinal(fragment: string): Ordinal | null {
  const nu = aplati(fragment);

  /* « la dernière », « le dernier » — traité AVANT la table, parce qu'il n'y
     a pas de rang à lui donner. */
  if (/^(?:la |le |l')?derni(?:er|ere)$/u.test(nu)) return { depuisLaFin: 1 };

  const mot = /^(?:la |le |l')?([a-z]+)$/u.exec(nu)?.[1];
  if (mot !== undefined) {
    const rang = MOTS[mot];
    if (rang !== undefined) return { rang };
  }

  /* Les formes chiffrées : « la 1re », « le 2e », « la 3 ». Elles sont rares à
     l'oral et fréquentes au clavier ; les refuser ferait dépendre la
     compréhension du mode de saisie. */
  const chiffre = /^(?:la |le |l')?(\d{1,2})(?:\s*(?:er|re|e|eme|ème))?$/u.exec(nu)?.[1];
  if (chiffre !== undefined) {
    const rang = Number(chiffre);
    /* ⚠ ZÉRO N'EST PAS UNE POSITION, et « la 0 » ne veut rien dire. Le laisser
       passer produirait un index négatif au résolveur — un défaut qui ne se
       verrait qu'à l'usage, sur une liste réelle. */
    if (rang >= 1) return { rang };
  }

  return null;
}
