/**
 * L'ÉGRESSION SE DÉCIDE SUR LA DESTINATION — `docs/26 §4.5`, ADR-051.
 *
 * LE DÉFAUT QUE CE FICHIER FERME
 * -------------------------------
 * `egress` était dérivé de `ToolDefinition.networkRequired`, et un booléen
 * répondait à deux questions distinctes :
 *
 *   l'appel quitte-t-il le **PROCESSUS** ?    → `networkRequired`
 *   la destination est-elle hors de la
 *   **MACHINE** ?                             → personne
 *
 * Un CalDAV sur `127.0.0.1` sort du processus sans sortir de la machine. Tant
 * que le modèle ne savait pas le dire, les deux issues étaient mauvaises :
 * déclarer `false` laissait sortir un agenda **cloud** sans que le Gate le
 * voie ; déclarer `true` obligeait à laisser `cloudEnabled` armé pour un usage
 * quotidien — et **un interrupteur de sûreté qu'il faut désarmer pour se servir
 * de la machine cesse d'être un interrupteur de sûreté.**
 *
 * CE QUI A RENDU LA QUESTION URGENTE
 * -----------------------------------
 * L'étape F2 du Data Firewall applique `docs/14 §5` : « niveau ≥ SENSITIVE +
 * egress → DENY ». L'agenda est `SENSITIVE`. Mesuré : les quatre outils
 * sortants du dépôt manipulent tous de l'agenda, donc **tous devenaient
 * définitivement refusés, y compris sur un fournisseur purement local.**
 *
 * Le défaut de modélisation cessait d'être une gêne théorique pour devenir un
 * blocage complet. On le ferme.
 *
 * LÀ OÙ L'INFORMATION EXISTE
 * ---------------------------
 * Ni le contrat d'outil (statique) ni le Gate (qui ignore les fournisseurs) ne
 * savent où va l'appel. **Le seul moment où c'est connu est le BRANCHEMENT** :
 * l'outil reçoit son fournisseur à la construction, et `ProviderCapabilities`
 * porte déjà `local`.
 *
 * ⚠ CE QUE CELA COÛTE, ET IL FAUT LE DIRE
 * ----------------------------------------
 * `capabilities.local` est une DÉCLARATION du fournisseur. Un adaptateur qui
 * mentirait — `local: true` en pointant vers Internet — échapperait au Gate.
 * Avant ce fichier, `networkRequired: true` était inconditionnel et ce chemin
 * n'existait pas.
 *
 * Ce n'est pas un troc gratuit, c'est un troc ASSUMÉ : l'alternative rendait la
 * capacité inutilisable. Et il est bornable — `isPrivateAddress`
 * (`apps/server/auth.ts`) sait déjà reconnaître une adresse locale. La
 * corroboration est la condition de levée écrite en `docs/26 §4.5` : au premier
 * adaptateur réel, `local` doit être VÉRIFIÉ, pas cru.
 */
import type { Provider } from '../../providers/contract.js';

/**
 * Cet appel sort-il de la machine ?
 *
 * Décidé au branchement, à partir de ce que le fournisseur déclare de lui-même.
 */
export function leavesMachine(provider: Provider | null): boolean {
  /* Aucun fournisseur : il n'y a personne à appeler, donc rien ne sort.
     L'outil refusera de toute façon à l'exécution (`PROVIDER_UNAVAILABLE`), et
     c'est un refus plus utile qu'un `POLICY_DENIED` — il nomme la cause réelle
     au lieu d'une conséquence. */
  if (provider === null) return false;
  return !provider.capabilities.local;
}
