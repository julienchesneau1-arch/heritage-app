/**
 * CE QU'UNE SORTIE D'OUTIL A ÉNUMÉRÉ — ADR-107.
 *
 * « Marque **la première** comme faite » suppose qu'une première existe,
 * c'est-à-dire que Jarvis vient de MONTRER une liste. Ce module répond à une
 * seule question :
 *
 *     quelles identités cette sortie d'outil a-t-elle énumérées, et dans quel
 *     ordre ?
 *
 * ⚠ POURQUOI ICI, ET PAS DANS `render-sortie.ts`
 * ---------------------------------------------------------------------------
 * `render-sortie.ts` sait déjà lire chaque sortie d'outil — c'est le registre
 * unique du RENDU depuis ADR-100. La tentation était d'y ajouter cette
 * fonction.
 *
 * Elle vit dans le noyau pour une raison de couches, pas de goût :
 * `src/apps/render-sortie.ts` est une SURFACE, et l'Assistant — qui a besoin
 * de cette réponse — est dans `src/core`. Le noyau ne dépend pas d'une
 * interface, jamais.
 *
 * Les deux modules lisent la même structure ; ce n'est pas un second registre
 * au sens d'ADR-041. Le FAIT — la liste — a une seule source : la sortie de
 * l'outil. L'un en tire des lignes, l'autre des identités.
 *
 * ⚠ ET LE `GENRE` EST CE QUI REND L'ORDINAL SÛR
 * ---------------------------------------------------------------------------
 * « Supprime la deuxième » après une liste de TÂCHES et après une recherche en
 * MÉMOIRE ne désignent pas la même chose. Sans le genre, un ordinal
 * s'appliquerait à n'importe quel dernier affichage — et l'utilisateur verrait
 * disparaître autre chose que ce qu'il croyait désigner.
 *
 * La règle d'intention déclare le genre qu'elle attend ; l'Assistant refuse et
 * DEMANDE quand le dernier affichage n'est pas de ce genre.
 */
import type { GenreDesigne } from '../context/designation.js';

/** Un élément montré à l'utilisateur, à une position donnée. */
export interface ElementEnumere {
  readonly id: string;
  /**
   * ⚠ LE MÊME VOCABULAIRE QUE `GenreDesigne`, ET C'EST DÉLIBÉRÉ.
   *
   * Une seconde énumération de « sortes de choses qu'on peut désigner »
   * finirait par diverger de celle d'ADR-096 (ADR-041), et la divergence se
   * lirait à l'endroit le plus coûteux : un ordinal qui s'applique au mauvais
   * genre supprime la mauvaise chose.
   */
  readonly genre: GenreDesigne;
  /** Ce qui a été AFFICHÉ. Sert à dire ce qu'on a compris, jamais à décider. */
  readonly libelle: string;
}

function texte(valeur: unknown): string {
  return typeof valeur === 'string' ? valeur : '';
}

function champ(o: unknown, cle: string): unknown {
  return typeof o === 'object' && o !== null
    ? (o as Record<string, unknown>)[cle]
    : undefined;
}

function liste(o: unknown, cle: string): readonly unknown[] {
  const v = champ(o, cle);
  return Array.isArray(v) ? v : [];
}

/** Construit les éléments d'une liste d'objets portant `id` et un libellé. */
function depuis(
  o: unknown,
  cle: string,
  genre: GenreDesigne,
  champLibelle: string,
): readonly ElementEnumere[] {
  const sortie: ElementEnumere[] = [];
  for (const item of liste(o, cle)) {
    const id = texte(champ(item, 'id'));
    /* ⚠ UN ÉLÉMENT SANS IDENTITÉ N'EST PAS ÉNUMÉRÉ. Le compter quand même
       décalerait toutes les positions suivantes : « la deuxième » désignerait
       la troisième ligne affichée. Un décalage silencieux sur une suppression
       est exactement le défaut qu'on ne veut pas. */
    if (id.length === 0) continue;
    sortie.push({ id, genre, libelle: texte(champ(item, champLibelle)) });
  }
  return sortie;
}

/**
 * LA TABLE — une entrée par outil ÉNUMÉRANT, et rien pour les autres.
 *
 * ⚠ ELLE NE COUVRE PAS TOUS LES OUTILS, ET C'EST VOULU. `render-sortie.ts`
 * doit couvrir les vingt-deux, parce qu'un outil muet est un résultat perdu
 * (ADR-100). Ici, l'absence est une réponse juste : `note_create` ne montre
 * pas de liste, donc « la deuxième » n'a rien à désigner après lui.
 *
 * Un test vérifie que tout outil ABSENT de cette table rend bien un tableau
 * vide — la différence entre « n'énumère rien » et « on a oublié de le
 * traiter » ne doit pas se lire dans le silence.
 */
const TABLE: Readonly<Record<string, (o: unknown) => readonly ElementEnumere[]>> = {
  task_list: (o) => depuis(o, 'tasks', 'TASK', 'title'),
  memory_search: (o) => depuis(o, 'results', 'MEMORY', 'content'),
  /* ⚠ `calendar_read` EST ABSENT, ET CE N'EST PAS UN OUBLI.

     Ses événements ne sont pas un `GenreDesigne` : on peut désigner une tâche
     par son nom, pas un événement — `calendar_update` attend un `eventId` qui
     vit chez Google, et c'est la dernière ligne hors surface parlée.

     Ajouter `EVENT` ici obligerait à l'ajouter à `GenreDesigne`, donc au
     résolveur de désignation, qui ne saurait pas le traiter. Mieux vaut une
     absence nommée qu'une énumération que la moitié du système ignore. */
};

/**
 * Les identités énumérées par cette sortie, dans l'ordre de l'affichage.
 *
 * Tableau vide quand l'outil ne montre pas de liste — ce qui est le cas de la
 * plupart d'entre eux.
 */
export function enumerationDe(
  toolId: string,
  output: unknown,
): readonly ElementEnumere[] {
  const lecteur = TABLE[toolId];
  return lecteur === undefined ? [] : lecteur(output);
}

/** Les outils qui énumèrent. Exposé pour que les tests puissent les parcourir. */
export function outilsEnumerants(): readonly string[] {
  return Object.keys(TABLE);
}
