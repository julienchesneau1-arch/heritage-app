/**
 * CE QUE L'UTILISATEUR CONFIRME — assemblé et relu au même endroit.
 *
 * `docs/03 §3` en fait une exigence :
 *
 *   > La confirmation doit porter sur ce qui va **réellement se produire**, pas
 *   > sur une intention résumée.
 *
 * C'est la défense qui tient quand un modèle a été convaincu : peu importe ce
 * qu'il raconte, l'humain voit la valeur concrète avant de dire oui.
 *
 * DEUX DÉFAUTS QUE CE MODULE CORRIGE — ADR-063
 * ---------------------------------------------------------------------------
 * **1. Une liste NOIRE là où il fallait une liste blanche.**
 * Les valeurs à confirmer voyageaient dans `error.details`, mélangées à des
 * métadonnées (`tool`, `autonomy`). Deux consommateurs — l'Assistant et le CLI —
 * les triaient chacun de leur côté par `key !== 'tool' && key !== 'autonomy'`.
 *
 * Or le Gateway étalait `...sensitiveValues` **après** ces deux clés : un
 * paramètre nommé `tool` aurait écrasé la métadonnée, puis aurait été filtré
 * par les deux consommateurs. **L'humain aurait confirmé une valeur qu'il n'a
 * jamais vue.** Aucun outil ne porte ce nom aujourd'hui ; c'est un piège, pas
 * un incident.
 *
 * **2. Une troncature SILENCIEUSE.** `.slice(0, 200)` coupait sans le dire.
 * `web_search.query` accepte 256 caractères : cinquante-six pouvaient
 * disparaître de ce que l'utilisateur confirme, sans un mot. Ce n'était pas
 * latent — c'était le comportement du jour.
 *
 * LA TRONCATURE SE DIT DANS LA CHAÎNE, PAS DANS UN DRAPEAU
 * ---------------------------------------------------------
 * Un booléen `tronqué` à côté de la valeur suppose que chaque affichage pense à
 * le lire. Il y en a trois — CLI, passerelle web, et le prochain. La mention
 * est donc **dans le texte** : elle survit à un consommateur distrait, ce qu'un
 * drapeau ne fait pas.
 */

/**
 * Préfixe des clés qui portent une valeur à confirmer.
 *
 * Tout le reste de `details` est de la métadonnée. Une liste BLANCHE : une clé
 * inconnue n'est plus affichée par défaut, elle est ignorée par défaut — et
 * c'est le bon sens du doute pour un affichage qui n'a pas à inventer.
 */
export const CONFIRM_PREFIX = 'valeur.';

/** Au-delà, on coupe — mais on le DIT. */
export const CONFIRM_MAX = 200;

/** La clé sous laquelle un paramètre voyage jusqu'à l'affichage. */
export function confirmableKey(parameterName: string): string {
  return `${CONFIRM_PREFIX}${parameterName}`;
}

/**
 * Rend une valeur pour l'œil humain, sans jamais la raccourcir en silence.
 *
 * `JSON.stringify` plutôt que `String()` : un objet rendu « [object Object] »
 * ne permettrait de confirmer rien.
 */
export function renderConfirmable(raw: unknown): string {
  const texte = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');
  if (texte.length <= CONFIRM_MAX) return texte;
  return (
    `${texte.slice(0, CONFIRM_MAX)}… ` +
    `(tronqué — ${String(texte.length)} caractères au total)`
  );
}

export interface ValeurAConfirmer {
  /** Le nom du paramètre, sans le préfixe de transport. */
  readonly nom: string;
  readonly rendu: string;
}

/**
 * Extrait les valeurs à confirmer d'un `details` d'erreur.
 *
 * UN SEUL EXTRACTEUR, et c'est le point : l'Assistant et le CLI le partagent.
 * Deux tris du même fait finissent par diverger, et le jour où ils divergent
 * aucun ne fait autorité (ADR-041).
 *
 * L'ordre est **stable** — trié par nom. Deux confirmations successives de la
 * même action doivent présenter les mêmes valeurs dans le même ordre : un
 * ordre qui bouge fait relire, et ce qu'on relit trop souvent finit par ne
 * plus être lu.
 */
export function readConfirmables(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly ValeurAConfirmer[] {
  if (details === undefined) return [];
  return Object.entries(details)
    .filter(([key]) => key.startsWith(CONFIRM_PREFIX))
    .map(([key, value]) => ({
      nom: key.slice(CONFIRM_PREFIX.length),
      rendu: String(value),
    }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}
