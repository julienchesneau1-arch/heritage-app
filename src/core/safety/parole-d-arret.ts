/**
 * « JARVIS, STOP. » — la phrase qui atteint l'arrêt d'urgence.
 *
 * ADR-104. `docs/05 §C2`, `CRITIQUE`, donne cette phrase comme **entrée** du
 * scénario :
 *
 *   > **Entrée :** « Jarvis, stop. »
 *   > **Attendu :** sorties interrompues, actions en attente annulées, actions
 *   > externes bloquées, journal conservé.
 *
 * ⚠ LE MÉCANISME EXISTAIT DEPUIS ADR-057. LA PHRASE N'ATTEIGNAIT RIEN.
 * ---------------------------------------------------------------------------
 * `halt.ts` est écrit, testé, et le Tool Gateway l'HONORE : arrêté, plus rien
 * ne passe. Mais `engage()` n'avait **aucun appelant** — ni dans le noyau, ni
 * dans le CLI, ni dans la passerelle web. Personne ne pouvait appuyer sur le
 * bouton.
 *
 *     Un arrêt d'urgence qu'aucune phrase n'atteint n'est pas un arrêt
 *     d'urgence. C'est un mécanisme d'arrêt d'urgence.
 *
 * C'est le motif d'ADR-094 — *une capacité que l'interface ne montre pas est,
 * du siège de l'utilisateur, une capacité absente* — appliqué au contrôle de
 * dernier recours, et sur le seul scénario doré classé `CRITIQUE` dont
 * l'entrée est une phrase.
 *
 * ⚠ POURQUOI CETTE RECONNAISSANCE N'EST PAS DANS `intent/engine.ts`
 * ---------------------------------------------------------------------------
 * Le moteur d'intention produit des **propositions d'outil**, et une
 * proposition traverse le Policy Gate. `halt.ts` l'a tranché dès sa première
 * ligne : *« un arrêt d'urgence que la politique peut refuser n'est pas un
 * arrêt d'urgence »* — et le moment où l'on appuie sur le bouton est
 * précisément celui où la politique peut se comporter autrement qu'attendu.
 *
 * La reconnaissance vit donc à part, et l'Assistant la consulte **avant**
 * toute autre chose : avant le `Tier 0`, avant le `Tier 1`, avant le résolveur
 * de référents, avant le Gate.
 *
 * ⚠ LA GARDE QUI COMPTE EST CELLE DES FAUX POSITIFS UTILES
 * ---------------------------------------------------------------------------
 * « Arrête la tâche du plombier » n'est pas un arrêt d'urgence : c'est
 * `task_cancel`. Avaler cette phrase transformerait une annulation ordinaire
 * en paralysie complète de Jarvis, et l'utilisateur ne comprendrait pas ce qui
 * vient de se passer.
 *
 * ```text
 * arrête tout · stop · jarvis stop · arrêt d'urgence   → ARRÊT
 * arrête la tâche du plombier · arrête le minuteur     → l'outil ordinaire
 * ```
 *
 * La règle est donc : un arrêt d'urgence ne prend **aucun complément d'objet**.
 * « tout » et « toi » en sont les seuls admis, parce qu'ils ne désignent rien
 * de particulier.
 *
 * ⚠ ET LE SENS DE L'ERREUR EST CHOISI. Un faux positif arrête Jarvis — bruyant,
 * visible, réparable par une levée explicite. Un faux négatif laisse Jarvis
 * agir quand on lui a demandé de s'arrêter. Le premier coûte une minute, le
 * second peut coûter une action qu'on ne voulait pas. En cas de doute, on
 * arrête.
 */

/**
 * Enlève accents, apostrophes typographiques et ponctuation terminale.
 *
 * ⚠ SEULEMENT POUR LA RECONNAISSANCE. Le texte de l'utilisateur n'est jamais
 * modifié ailleurs — on normalise la CLÉ de lecture, pas la donnée.
 */
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
 * Les formes qui déclenchent un arrêt.
 *
 * ⚠ CHACUNE EST ANCRÉE AUX DEUX BOUTS (`^…$`), et c'est la garde. Sans les
 * ancres, « arrête tout ce qui concerne le plombier » serait un arrêt
 * d'urgence — et ce n'est pas ce que la personne a dit.
 */
const FORMES: readonly RegExp[] = [
  /* « stop », « jarvis stop », « jarvis, stop » — la forme de `docs/05 §C2`. */
  /^(?:jarvis[ ,]*)?stop(?:pe)?(?: tout)?$/u,
  /* « arrête tout », « arrête-toi », « arrête » seul. */
  /^(?:jarvis[ ,]*)?arrete(?:s|-toi| toi| tout)?$/u,
  /* La formulation littérale du bouton. */
  /^(?:jarvis[ ,]*)?arret d'urgence$/u,
  /* « coupe tout », employé au moins autant que « arrête tout ». */
  /^(?:jarvis[ ,]*)?coupe tout$/u,
];

/**
 * Cette phrase est-elle une demande d'arrêt d'urgence ?
 *
 * Fonction PURE, sans entrée-sortie, comme `intent/engine.ts` : la décision
 * d'arrêter ne doit pas pouvoir échouer pour une raison d'infrastructure.
 */
export function estUneParoleDArret(texte: string): boolean {
  const nu = aplati(texte);
  return FORMES.some((forme) => forme.test(nu));
}
