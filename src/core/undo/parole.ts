/**
 * « ANNULE LA DERNIÈRE ACTION » — la phrase, à un seul endroit.
 *
 * ADR-105, `docs/09 §2.1`, `docs/26 §4.20`.
 *
 * ⚠ CE MODULE EXISTE PARCE QUE LA PHRASE VIVAIT DANS LE CLI
 * ---------------------------------------------------------------------------
 * `src/apps/cli/main.ts` portait `/^annule la derni[eè]re action/iu` et toute
 * la chaîne qui suit. Conséquence mesurée sur le banc des trente actions :
 *
 * ```text
 * CLI        « annule la dernière action »   →  marche
 * say()      la même phrase                   →  « capacité absente »
 * téléphone  aucun bouton, aucune route       →  rien
 * ```
 *
 * L'Undo Engine existe depuis ADR-066 et il est branché — **à une seule
 * surface**. C'est la forme exacte du défaut qu'ADR-104 venait de réparer sur
 * l'arrêt d'urgence, sur un autre mécanisme.
 *
 * ⚠ LA GARDE EST LA MÊME QUE POUR L'ARRÊT : PAS DE COMPLÉMENT D'OBJET
 * ---------------------------------------------------------------------------
 * ```text
 * annule · annule ça · annule la dernière action       → ANNULATION
 * annule la tâche du plombier · annule le rappel de…   → task_cancel / reminder_cancel
 * ```
 *
 * Une annulation générique qui avalerait « annule la tâche du plombier »
 * défferait **la dernière action** au lieu de la tâche nommée — et
 * l'utilisateur verrait disparaître autre chose que ce qu'il a demandé. C'est
 * le pire des défauts possibles ici : une action réelle, juste pas la bonne.
 *
 * Le sens de l'erreur est d'ailleurs INVERSE de celui de l'arrêt d'urgence.
 * Là-bas, en cas de doute on arrête, parce qu'arrêter ne casse rien. Ici, en
 * cas de doute on **ne défait rien** : mieux vaut demander que défaire la
 * mauvaise chose.
 */

/** Accents, apostrophes typographiques et ponctuation terminale enlevés. */
function aplati(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/['’]/gu, "'")
    .replace(/[.!?;,\s]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * Les formes reconnues, ancrées aux deux bouts.
 *
 * Sans les ancres, « annule la tâche du plombier » commencerait par « annule »
 * et serait avalée. C'est la même discipline que `parole-d-arret.ts`, et elle
 * porte ici un risque plus concret : l'arrêt ne détruit rien, l'annulation si.
 */
const FORMES: readonly RegExp[] = [
  /* « annule », « annule ca », « annule tout ca » — sans objet nommé. */
  /^annule(?:r)?(?: (?:ca|cela|tout ca))?$/u,
  /* La formulation de `docs/09 §2.1`, et ses variantes usuelles. */
  /^annule(?:r)? (?:la |ta |sa )?derniere action$/u,
  /^annule(?:r)? (?:ce|tout ce) que tu viens de faire$/u,
  /^annule(?:r)? ce que tu as fait$/u,
  /* « défais ça », « reviens en arrière » — les deux autres façons de le dire. */
  /^defai(?:s|re) (?:ca|cela)$/u,
  /^reviens en arriere$/u,
  /^retour en arriere$/u,
];

/**
 * Cette phrase demande-t-elle d'annuler la DERNIÈRE action ?
 *
 * Fonction pure, sans entrée-sortie : la compréhension ne doit pas dépendre
 * d'une base. Même discipline que `intent/engine.ts` et `parole-d-arret.ts`.
 */
export function estUneDemandeDAnnulation(texte: string): boolean {
  const nu = aplati(texte);
  return FORMES.some((forme) => forme.test(nu));
}
