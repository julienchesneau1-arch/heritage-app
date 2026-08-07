/**
 * LA MORT — ce que l'application fait, et ce qu'elle cesse de faire.
 *
 * Une application qui promet cinquante ans de mémoire familiale rencontrera
 * la mort. Le modèle portait `deathDate` depuis le premier jour, et ce champ
 * ne servait qu'à trois choses : le calendrier, éviter que le Passeur
 * interroge un défunt, et un signal daté. Pour le reste, rien n'avait été
 * décidé — et l'absence de décision produisait ceci :
 *
 *   L'écran de l'entretien proposait une grand-mère MORTE comme relectrice
 *   de l'enregistrement qu'on venait de faire sur elle.
 *
 * `relecteursPossibles` ne filtrait que `isDeleted`, c'est-à-dire « retiré
 * de la famille ». Un défunt n'est pas retiré : il est toujours là, et le
 * produit lui demandait d'écouter. C'est le genre de chose après laquelle on
 * ne rouvre pas une application.
 *
 * ── LA DOCTRINE : IL CESSE D'ÊTRE UN ACTEUR, IL RESTE UN SUJET ──
 *
 * Cette phrase tranche tous les cas, et elle vient de la Constitution :
 * l'Annexe A point 6 fait de l'oubli une DÉCISION, et la §2.6 interdit de
 * décider à la place de quelqu'un. Un mort ne décide plus ; personne ne
 * décide à sa place. Donc :
 *
 * CE QUI S'ARRÊTE — les rôles qui supposent une volonté présente :
 *   · il n'est plus proposé comme RELECTEUR d'un entretien ;
 *   · on ne peut plus prendre son identité sur « Qui êtes-vous ? » ;
 *   · son lien personnel ne prouve plus rien — l'identité vérifiée est ce
 *     qui autorise à SUPPRIMER, et supprimer au nom d'un mort n'est pas
 *     une suppression, c'est une usurpation.
 *
 * CE QUI CONTINUE — tout ce qui le concerne sans exiger qu'il agisse :
 *   · ses récits restent, sous son nom (§2.1 : les histoires restent) ;
 *   · il reste NARRATEUR : « je note ce que ma grand-mère racontait » est
 *     précisément ce qu'on vient faire ici après une mort, et le lui
 *     retirer viderait le produit de son objet ;
 *   · sa demande portée reste affichée, et personne ne peut la lever à sa
 *     place — c'est la §2.6 appliquée à quelqu'un qui ne peut plus parler ;
 *   · ses dates restent au calendrier, sauf retrait explicite.
 *
 * ── CE QUE L'APPLICATION NE FAIT PAS ──
 *
 * Aucun mémorial, aucune bougie, aucune mention automatique, aucun ton
 * particulier. La §12 interdit l'inférence émotionnelle : le produit ne sait
 * pas ce que cette mort fait à cette famille, et il n'a pas à le supposer.
 * Il enregistre une date et il en tire des conséquences pratiques. C'est
 * tout, et c'est déjà beaucoup.
 *
 * ── ET SI LA DATE EST FAUSSE ? ──
 *
 * Quelqu'un pourrait inscrire une date de décès pour couper l'accès d'un
 * vivant. C'est vrai — et c'est déjà vrai de « Retirer de la famille », que
 * la spec assume (§2.1). La date se corrige depuis `/famille`, et tout
 * revient : rien n'est détruit, rien n'est irréversible.
 */

import type { Member } from '@prisma/client';

/**
 * Fragment Prisma : ceux qui peuvent encore AGIR.
 *
 * `isDeleted` (retiré de la famille) et `deathDate` sont deux choses
 * distinctes, et c'est la confusion des deux qui a produit le défaut.
 */
export const ACTEURS = { isDeleted: false, deathDate: null } as const;

/** Fragment Prisma : ceux dont on parle encore — les morts compris. */
export const PRESENTS = { isDeleted: false } as const;

export function peutAgir(membre: { isDeleted?: boolean; deathDate?: Date | null }): boolean {
  return membre.isDeleted !== true && (membre.deathDate ?? null) === null;
}

export function estDecede(membre: { deathDate?: Date | null }): boolean {
  return (membre.deathDate ?? null) !== null;
}

/**
 * Ce que l'application dit, une fois, sans emphase.
 *
 * Pas « en mémoire de », pas « disparu·e » : une constatation. Le ton
 * appartient à la famille, pas au produit.
 */
export const DECES = {
  mention: 'Cette personne est décédée.',
  consequence:
    'Ses récits restent, et on peut toujours noter ce qu’elle racontait. Elle n’est plus proposée pour relire un enregistrement, et son lien personnel n’ouvre plus de session à son nom : personne ne parle en son nom.',
  lienRefuse:
    'Ce lien personnel appartenait à quelqu’un dont la date de décès est enregistrée. Il n’ouvre plus de session à son nom. Si cette date est une erreur, elle se corrige depuis la page Famille.',
  reserveMaintenue:
    'La personne qui a fait cette demande est décédée. Elle ne peut plus la retirer, et personne ne peut le faire à sa place.',
} as const;

/*
 * ── LE SIGNAL DU JOUR ANNIVERSAIRE ──
 *
 * Le TriggerModel écrivait : « Il y a 12 ans, Robert Martin nous
 * quittait. » Deux fautes dans cinq mots, et la doctrine de ce fichier les
 * nomme toutes les deux.
 *
 *  · « NOUS » — le produit se compte parmi les endeuillés. Il n'est pas de
 *    la famille. Personne ne lui a demandé d'en être.
 *  · « QUITTAIT » — un euphémisme choisit un registre. Or « le ton
 *    appartient à la famille, pas au produit » : une famille dit « mort »,
 *    une autre « parti », une troisième ne dit rien. Ce n'est pas au
 *    logiciel de trancher, un matin, sur l'écran d'accueil.
 *
 * Reste la difficulté propre au français : « décédé » s'accorde, et le
 * produit ne connaît pas le genre — il ne le demandera pas non plus, ce
 * serait une donnée de plus pour une phrase. D'où une tournure NOMINALE,
 * sans verbe et sans accord. C'est la même sortie que `DECES.mention`,
 * qui contourne le problème par « cette personne ».
 *
 * `« Aujourd'hui, Robert Martin aurait eu 95 ans »` reste tel quel : ce
 * n'est ni un « nous » ni un euphémisme, c'est une soustraction.
 */
export function anniversaireDeces(nom: string, ans: number): string {
  if (ans <= 0) return `Le décès de ${nom}, cette année.`;
  return `Il y a ${ans} ${ans > 1 ? 'ans' : 'an'}, le décès de ${nom}.`;
}

/** Le nom tel qu'il s'affiche : anonymisé si retiré, tel quel sinon. */
export function nomAffiche(membre: Pick<Member, 'name' | 'isDeleted'>): string {
  return membre.isDeleted ? 'Membre anonymisé' : membre.name;
}

/*
 * ── UN POINT DE PASSAGE, ET UNE SÉLECTION QUI LE REND POSSIBLE ──
 *
 * La §2.1 règle 1 le dit sans réserve : « la règle ne dit pas anonymisé
 * dans les récits, elle dit anonymisé. » `voixDe()` la tenait dans les
 * fils. Ailleurs, chaque endroit qui chargeait une personne refaisait le
 * geste à la main — et `outils/oubli.mts` a trouvé cinq sorties où il
 * n'avait pas été fait : la page Archives, la route du détail d'un récit,
 * celle des archives, celle des fils, et la liste des récits.
 *
 * Trois d'entre elles ne pouvaient MÊME PAS anonymiser : leur `select`
 * ne chargeait pas `isDeleted`. C'est la vraie cause — pas un oubli
 * ponctuel, une sélection qui rendait la règle inapplicable sans que rien
 * ne le signale. `QUI` et `nommer()` vont donc par paire.
 */

/** Ce qu'il faut TOUJOURS charger d'une personne pour pouvoir la nommer. */
export const QUI = { id: true, name: true, isDeleted: true } as const;

/** La même personne, nommée selon la règle. Le seul geste à faire. */
export function nommer<T extends { name: string; isDeleted: boolean }>(personne: T): T;
export function nommer<T extends { name: string; isDeleted: boolean }>(personne: T | null): T | null;
export function nommer<T extends { name: string; isDeleted: boolean }>(personne: T | null): T | null {
  return personne === null ? null : { ...personne, name: nomAffiche(personne) };
}
