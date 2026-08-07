/**
 * AMENDEMENT 6 — Le produit n'affirme que ce qu'il a vérifié.
 *
 * Les amendements 1, 3 et 5 interdisent d'inférer une ÉMOTION, de retenir
 * les données d'une famille, d'imposer un ordre. Douze incidents relevés
 * pendant l'implémentation relèvent d'un défaut qu'aucun d'eux ne couvre :
 * le produit affirmait un FAIT qu'il n'avait pas établi.
 *
 * Aucun ne plantait. Aucun ne faisait échouer un test d'exécution. Ils ne
 * se voient qu'en posant, pour chaque phrase affichée, deux questions :
 * sur quoi repose-t-elle, et que vaut-elle quand cette base est vide ?
 *
 * Ce module rend la règle exécutable au lieu de la commenter. Quatre
 * clauses, quatre outils.
 */

// ─────────────────────────────────────────────────────────────────────
// Clause 1 — Une mesure impossible ne vaut pas zéro.
// ─────────────────────────────────────────────────────────────────────

/**
 * Le résultat d'un calcul qui peut ne pas avoir de base.
 *
 * Le type est une union discriminée, et c'est délibéré : on ne PEUT pas
 * lire `.valeur` sans avoir traité le cas non mesurable. Un `number | null`
 * se rendait tel quel dans du JSX et affichait « 0 » ; ici le compilateur
 * refuse. C'est ce qui fait la différence entre une règle et un vœu.
 */
export type Mesure =
  | { readonly mesurable: true; readonly valeur: number; readonly base: number }
  | { readonly mesurable: false; readonly base: number; readonly raison: string };

/**
 * Une part sur une base — taux, ratio, proportion.
 *
 * `distorsion 0/100` sur une famille sans aucune lecture se lisait
 * « mémoire parfaitement fidèle ». `transmission 0 %` sur trois récits se
 * lisait comme un échec. Dans les deux cas la valeur par défaut d'un
 * langage — zéro — était présentée comme un résultat.
 *
 * @param minimum Base en deçà de laquelle la mesure ne peut pas exprimer
 *   sa cible. Le taux de transmission vise « une histoire sur cinq » : avec
 *   quatre récits il ne peut valoir que 0, 25, 50, 75 ou 100 %, et saute
 *   par-dessus le seuil qu'il est censé évaluer.
 */
export function mesurer(
  part: number,
  base: number,
  options: { sujet: string; minimum?: number },
): Mesure {
  const minimum = options.minimum ?? 1;

  if (base <= 0) {
    return {
      mesurable: false,
      base: 0,
      raison: `Aucun ${options.sujet} enregistré : il n’y a pas un taux nul, il n’y a pas de taux.`,
    };
  }

  if (base < minimum) {
    // La raison est lue par la famille : « 2 récit » se voit.
    const pluriel = base > 1 ? `${options.sujet}s` : options.sujet;
    return {
      mesurable: false,
      base,
      raison: `${base} ${pluriel} : trop peu pour conclure — il en faut au moins ${minimum}.`,
    };
  }

  return { mesurable: true, valeur: part / base, base };
}

/** Une valeur qui existe, ou pas. Pour ce qui n'est pas une part sur une base. */
export function connu(valeur: number | null, raison: string): Mesure {
  return valeur === null
    ? { mesurable: false, base: 0, raison }
    : { mesurable: true, valeur, base: 1 };
}

/** « 42 % », ou le tiret. Jamais « 0 % » pour dire « on ne sait pas ». */
export function enPourcentage(mesure: Mesure): string {
  return mesure.mesurable ? `${Math.round(mesure.valeur * 100)} %` : '—';
}

/** Ce qu'on écrit sous la valeur : le résultat, ou pourquoi il n'y en a pas. */
export function raisonDe(mesure: Mesure, quandMesurable: string): string {
  return mesure.mesurable ? quandMesurable : mesure.raison;
}

// ─────────────────────────────────────────────────────────────────────
// Clause 2 — Une vue bornée dit ce qu'elle borne.
// ─────────────────────────────────────────────────────────────────────

/**
 * La phrase que doit porter toute liste tronquée, tout graphe limité,
 * toute page paginée. `null` quand rien n'est caché — on ne meuble pas.
 *
 * Huit points sur un graphe laissaient croire que Robert n'apparaissait
 * que dans huit récits alors qu'il y en avait quatorze. Une image bornée
 * qui se tait sur ses bornes affirme une complétude qu'elle n'a pas.
 */
export function divulguer(options: {
  affiches: number;
  total: number;
  unite: string;
  /** « les plus récents », « les plus reliés d'abord »… */
  ordre?: string;
}): string | null {
  const { affiches, total, unite, ordre } = options;
  if (total <= affiches) return null;
  return `${affiches} ${unite} affichés sur ${total}${ordre ? ` — ${ordre}` : ''}.`;
}

// ─────────────────────────────────────────────────────────────────────
// Clause 3 — Un superlatif se vérifie avant de s'énoncer.
// ─────────────────────────────────────────────────────────────────────

/**
 * Y a-t-il un vrai premier ?
 *
 * « C'est le récit qui relie le plus d'éléments » était affirmé même quand
 * plusieurs en reliaient autant : le classement n'avait pas départagé, il
 * avait rendu le premier venu. Sur un corpus où presque tous les récits
 * relient deux entités — le cas courant — la phrase était fausse.
 *
 * On demande donc TOUJOURS un candidat de plus que nécessaire, et on
 * compare. Sans le second, la question ne peut pas être posée.
 */
export function estVraimentPremier(valeurs: readonly number[]): boolean {
  if (valeurs.length === 0) return false;
  if (valeurs.length === 1) return true;
  return valeurs[0]! > valeurs[1]!;
}

// ─────────────────────────────────────────────────────────────────────
// Clause 4 — Rien de dérivé du présent n'est gravé.
// ─────────────────────────────────────────────────────────────────────

/**
 * Un texte destiné à être mis en cache, exporté ou copié chez un tiers
 * contient-il un calcul qui vieillira ?
 *
 * « Il y a 10 ans, le décès de Robert », gravé dans un flux iCalendar que
 * l'agenda recopie, devient faux l'an prochain sans que personne ne s'en
 * aperçoive. On publie la date de référence ; l'arithmétique reste au
 * lecteur, qui la refait chaque fois qu'il lit.
 */
const CALCULS_PERISSABLES = [
  /\bil y a \d+\s*(an|ans|mois|jour|jours|semaine|semaines)\b/i,
  /\bdepuis \d+\s*(an|ans|mois|jour|jours)\b/i,
  /\bdans \d+\s*(an|ans|mois|jour|jours)\b/i,
  // Pas de `\b` devant « âgé » : en JavaScript la frontière de mot s'appuie
  // sur [A-Za-z0-9_], donc elle n'existe pas devant une lettre accentuée.
  // Le motif ne se déclenchait jamais.
  /âgé[e]?\s+de\s+\d+\s*ans?\b/i,
  /\b\d+\s*ans? (plus tard|après|auparavant)\b/i,
];

export function contientUnCalculPerissable(texte: string): boolean {
  return CALCULS_PERISSABLES.some((motif) => motif.test(texte));
}
