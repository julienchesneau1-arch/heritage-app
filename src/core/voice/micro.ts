/**
 * L'ÉTAT DU MICRO — et le témoin qui ne peut pas mentir.
 *
 * Réponse à `docs/26 §4.17`, question 1 : **« Qui d'autre est dans la pièce ? »**
 * Décidée en ADR-093.
 *
 * LE TROU, ÉNONCÉ EXACTEMENT
 * ---------------------------------------------------------------------------
 * Le mot d'activation borne ce qui est **transcrit**. Il ne borne jamais ce qui
 * est **capté** : la détection travaille par construction sur un flux continu.
 *
 * Un micro ouvert entend des tiers — le conjoint, l'enfant, l'invité, le
 * livreur — qui n'ont rien demandé et ignorent qu'un ordinateur écoute. Aucun
 * mécanisme de ce dépôt ne les concerne, parce que tout y est écrit du point de
 * vue de l'utilisateur.
 *
 * TROIS RÈGLES, ET UNE SEULE EST DU CODE AUJOURD'HUI
 * ---------------------------------------------------------------------------
 * ```text
 * R1  Rien de ce qui précède le mot d'activation n'existe.
 *     Tampon circulaire en RAM, dimensionné à la fenêtre de détection.
 *     Jamais sur disque, jamais dans le journal, jamais dans un contexte
 *     de modèle. Ce qui franchit la frontière est un booléen et un instant.
 *
 * R2  L'écoute est visible sans avoir à demander.          ← CE FICHIER
 *     Et le témoin est dérivé du MÊME état que la capture.
 *
 * R3  Une phrase non sollicitée ne dit pas de quoi il s'agit.
 *     Implémentée dans `plafond.ts` : `PROACTIF` plafonne à `PERSONAL`.
 * ```
 *
 * POURQUOI R2 EST LA SEULE QU'ON PEUT ÉCRIRE MAINTENANT
 * ---------------------------------------------------------------------------
 * R1 demande du code audio, qui n'existe pas. R3 est déjà faite ailleurs.
 *
 * R2, elle, n'est pas un problème d'audio : c'est un problème de TYPE. Et le
 * défaut qu'elle ferme est celui qu'on ne voit jamais venir.
 *
 *     Le réflexe naturel est deux variables :
 *         `capteurActif: boolean`   et   `temoinAllume: boolean`
 *
 *     Elles seront synchronisées le premier jour. Puis un chemin d'erreur
 *     rendra la main sans éteindre le témoin, ou l'éteindra sans fermer le
 *     flux. Personne ne le verra, parce que le seul observateur de cet écart
 *     est une personne qui croit que le micro est fermé.
 *
 * ADR-041 le dit pour les données : *« deux registres du même fait finissent
 * par diverger, et le jour où ils divergent aucun ne fait autorité »*. Ici le
 * fait est *« est-ce que ça écoute »*, et la divergence a un nom : **un micro
 * ouvert avec la lumière éteinte.**
 *
 * D'où la forme de ce module : **un seul état, deux lectures TOTALES.** Il
 * n'existe aucune fonction capable d'allumer le témoin, et aucune capable de
 * l'éteindre. On change l'état ; le témoin suit, parce qu'il n'est rien d'autre
 * qu'une façon de lire cet état.
 *
 * > On ne peut pas consentir à ce qu'on ne voit pas. Un témoin qui peut mentir
 * > est pire que pas de témoin : il fabrique un consentement qui n'a pas eu
 * > lieu.
 *
 * ⚠ CE QUE CE MODULE NE RÉSOUT PAS, ET QUI RESTE OUVERT
 * ---------------------------------------------------------------------------
 * Un témoin logiciel s'adresse à qui regarde l'écran. **Un invité ne regarde
 * pas l'écran de Julien.** R2 protège le propriétaire, pas le tiers.
 *
 * Ce qui protège le tiers est R1 — ce qu'il dit n'existe nulle part — et R3 —
 * Jarvis ne lance pas de phrase révélatrice devant lui. C'est une réponse
 * partielle, et elle est écrite comme telle en `docs/26 §4.17`.
 */
import { z } from 'zod';

/**
 * L'état du micro. **Trois valeurs, pas deux.**
 *
 * `FERME` et `TRANSCRIT` sont évidents. C'est `ECOUTE_MOT_CLE` qui porte tout
 * le sujet : le matériel capte, en permanence, et rien n'en sort. C'est
 * exactement l'état que le langage courant appelle « éteint » et que ce type
 * refuse d'appeler ainsi.
 *
 * Fusionner `FERME` et `ECOUTE_MOT_CLE` en un `actif: boolean` serait la
 * manière la plus discrète de rendre R2 fausse : le micro capterait, et le
 * type dirait qu'il ne capte pas.
 */
export const EtatMicro = z.enum([
  /** Aucune capture. Le périphérique n'est pas ouvert. */
  'FERME',
  /** Capture en tampon circulaire. Rien n'en sort qu'un booléen. */
  'ECOUTE_MOT_CLE',
  /** Le mot d'activation a été reconnu : l'audio part vers la transcription. */
  'TRANSCRIT',
]);
export type EtatMicro = z.infer<typeof EtatMicro>;

/**
 * Ce que le témoin doit montrer. Trois états, un par état du micro.
 *
 * `VEILLE` n'est pas `ETEINT`, et la distinction est la règle elle-même : un
 * micro qui écoute un mot d'activation CAPTE. Le montrer « éteint » parce que
 * rien n'est enregistré serait un mensonge sur le matériel.
 */
export const Temoin = z.enum(['ETEINT', 'VEILLE', 'ACTIF']);
export type Temoin = z.infer<typeof Temoin>;

const TEMOIN: Readonly<Record<EtatMicro, Temoin>> = {
  FERME: 'ETEINT',
  ECOUTE_MOT_CLE: 'VEILLE',
  TRANSCRIT: 'ACTIF',
};

/** Ce que le témoin montre. Dérivé de l'état — jamais posé à côté de lui. */
export function temoin(etat: EtatMicro): Temoin {
  return TEMOIN[etat];
}

/** Le matériel capte-t-il ? La question physique, pas la question logicielle. */
export function capte(etat: EtatMicro): boolean {
  return etat !== 'FERME';
}

/**
 * L'audio franchit-il la frontière du tampon circulaire ?
 *
 * C'est R1 exprimée comme une question à laquelle un seul état répond `true`.
 * Le jour où le code audio existera, c'est cette fonction qui devra garder
 * l'écriture — et non un commentaire demandant de faire attention.
 */
export function sortDuTampon(etat: EtatMicro): boolean {
  return etat === 'TRANSCRIT';
}
