/**
 * IDENTITÉ D'OPÉRATION — Foundation 4, ADR-030.
 *
 * LE DÉFAUT QUE CE MODULE REND IMPOSSIBLE
 * ---------------------------------------
 * Le banc de Foundation 3 a mesuré ceci (`docs/18 §5`) :
 *
 *   repli A → B, MÊME clé      →  1 effet   ✅
 *   repli A → B, NOUVELLE clé  →  2 effets  🔴
 *
 * Le journal d'intention protège une CLÉ. Un routeur qui frappe une nouvelle
 * clé pour « réessayer ailleurs » n'effectue pas un repli : il lance une
 * seconde action, et le noyau ne peut pas le deviner.
 *
 * Foundation 3 avait laissé cela en convention documentaire. Une convention se
 * perd. On la remplace ici par une propriété du TYPE :
 *
 *   — `OperationIdentity` est une chaîne MARQUÉE. Aucune chaîne ordinaire ne
 *     lui est assignable, et TypeScript refuse à la compilation ;
 *   — `mint()` est la seule fabrique, et elle représente une INTENTION NEUVE ;
 *   — un repli passe par `sameOperation()`, qui rend l'identité inchangée.
 *
 * Écrire `invoke({ ...call, operationId: mint() })` dans un chemin de repli
 * devient donc un acte visible, greppable, et vérifié par
 * `tests/lab/invariants.test.ts` (I5).
 */
import { randomUUID } from 'node:crypto';

declare const OPERATION_IDENTITY: unique symbol;

/**
 * Identité immuable d'une intention utilisateur.
 *
 * Marquée nominalement : `const x: OperationIdentity = 'abc'` ne compile pas.
 */
export type OperationIdentity = string & {
  readonly [OPERATION_IDENTITY]: 'OperationIdentity';
};

/**
 * Frappe une identité NEUVE.
 *
 * ⚠ Chaque appel déclare une intention utilisateur DISTINCTE. Appeler cette
 * fonction dans un chemin de reprise, de rejeu ou de repli est le défaut que ce
 * module existe pour empêcher.
 */
export function mint(seed?: string): OperationIdentity {
  const value = seed === undefined ? randomUUID() : `${seed}-${randomUUID()}`;
  return value as OperationIdentity;
}

/**
 * Conserve l'identité au travers d'un changement de fournisseur.
 *
 * Fonction identité au sens mathématique, et c'est voulu : elle n'existe pas
 * pour transformer quoi que ce soit, mais pour rendre l'intention LISIBLE au
 * point du code où le mauvais réflexe serait de frapper une nouvelle clé.
 *
 * ```ts
 * // ✅ un repli
 * await invoke({ ...call, operationId: sameOperation(call.operationId) });
 *
 * // 🔴 une seconde action déguisée en repli
 * await invoke({ ...call, operationId: mint() });
 * ```
 */
export function sameOperation(identity: OperationIdentity): OperationIdentity {
  return identity;
}

/**
 * L'identité de l'ANNULATION d'une capture — ADR-066.
 *
 * Annuler est une action neuve : elle a son effet, sa politique, son entrée au
 * journal. Le réflexe est donc `mint()` — et c'est le défaut. `mint()` frappe
 * une clé aléatoire, si bien que deux demandes d'annulation de la même capture
 * deviennent **deux actions**, et l'inverse s'exécute deux fois.
 *
 * L'identité est donc DÉRIVÉE de la capture, sans aléa :
 *
 * ```
 * une capture  →  une annulation  →  une clé
 * ```
 *
 * Le doublement est alors fermé là où ce dépôt le ferme toujours — par le
 * journal d'intention du Tool Gateway, atomiquement (ADR-029) — et non par une
 * garde applicative que deux appels concurrents contourneraient.
 *
 * Même esprit que `sameOperation` : une fonction nommée au point du code où le
 * mauvais réflexe serait invisible.
 */
export function forUndo(snapshotId: string): OperationIdentity {
  return `undo-${snapshotId}` as OperationIdentity;
}

/**
 * Restaure une identité lue en base.
 *
 * Réservée à la couche de persistance : PostgreSQL rend des `string`, et il
 * faut bien refermer la frontière quelque part. L'invariant I5 vérifie que ce
 * point de rentrée reste unique et cantonné.
 */
export function fromStorage(raw: string): OperationIdentity {
  return raw as OperationIdentity;
}

/**
 * Accepte une identité proposée par un CLIENT authentifié.
 *
 * Frontière de confiance distincte de `fromStorage`, et elle mérite son propre
 * nom : ici la valeur vient de l'extérieur du processus.
 *
 * Pourquoi c'est légitime : un client qui renvoie la même clé après une coupure
 * réseau fait EXACTEMENT ce qu'il faut — c'est le mécanisme qui empêche le
 * double envoi quand l'utilisateur appuie deux fois. Le refuser rendrait la
 * reprise côté client impossible.
 *
 * Pourquoi ce n'est pas dangereux : l'identité ne confère aucun droit. Elle
 * sert à DÉDUPLIQUER, jamais à autoriser. Un client qui rejoue la clé d'un
 * autre obtiendra un refus de rejeu, pas un accès.
 *
 * ⚠ Ce raisonnement cesserait de tenir le jour où plusieurs utilisateurs
 *   partageraient une base. La clé devrait alors être portée par l'acteur.
 */
export function fromClient(raw: string): OperationIdentity {
  return raw as OperationIdentity;
}

/** Deux appels portent-ils la même intention ? */
export function isSameOperation(
  a: OperationIdentity,
  b: OperationIdentity,
): boolean {
  return a === b;
}
