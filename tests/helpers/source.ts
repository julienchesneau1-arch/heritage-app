/**
 * LIRE DU CODE SANS LIRE CE QUI L'EXPLIQUE — ADR-105.
 *
 * Plusieurs gardes de ce dépôt cherchent une chaîne interdite dans un fichier
 * source : « le routeur ne connaît pas le CostGate », « le noyau audio ne nomme
 * aucun moteur », « la file ne connaît pas l'Undo Engine ».
 *
 * ⚠ ELLES MORDENT SUR LA DOCUMENTATION QUI LES EXPLIQUE, et c'est arrivé
 * QUATRE fois : ADR-096 sur un nom de variable, ADR-098 sur une liste citée,
 * ADR-102 sur deux noms de produits en commentaire, ADR-105 sur la phrase qui
 * décrit à qui la file rend ses intentions.
 *
 * Les deux premières fois, j'ai reformulé la prose. C'était le mauvais
 * échange : une garde qui force la documentation à devenir évasive protège le
 * code et abîme ce qui le rend relisable. La distinction commentaire / code est
 * RÉELLE et mécanique — c'est donc à la garde de la faire.
 *
 * ⚠ ET CE FICHIER EXISTE PARCE QU'IL Y EN AVAIT DÉJÀ DEUX COPIES.
 * `router.test.ts` et `passerelle.test.ts` portaient chacun la leur ; la
 * troisième allait naître dans `file.test.ts`. Trois dépouilleurs du même fait
 * auraient fini par diverger (ADR-041), et le jour de la divergence, aucune des
 * trois gardes n'aurait fait autorité.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */

/**
 * Retire commentaires de bloc et commentaires de ligne.
 *
 * Volontairement simple : ce n'est pas un analyseur syntaxique, et il n'a pas à
 * l'être. Le seul mode de panne qui compte — tout dépouiller et rendre les
 * gardes aveugles — est couvert par le contrôle négatif de
 * `tests/helpers/source.test.ts`.
 */
export function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}
