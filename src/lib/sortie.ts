/**
 * CE QUI SORT DU SERVEUR — et qui doit être dit avant de sortir.
 *
 * L'application a une page entière intitulée « Ce que l'application fait de
 * votre mémoire ». Elle y détaille ce que l'algorithme écarte, met en
 * sourdine, n'a jamais remontré. Elle ne disait rien du seul endroit où la
 * mémoire QUITTE PHYSIQUEMENT le serveur de la famille.
 *
 * Deux chemins existent pour transcrire un enregistrement :
 *
 *  · LE MOTEUR LOCAL, dans le navigateur du relecteur. Le fichier ne bouge
 *    pas ; c'est déjà écrit à l'écran, et c'est vrai.
 *  · L'API, si `OPENAI_API_KEY` est renseignée. La VOIX d'une personne — un
 *    enregistrement de sa grand-mère — est alors envoyée à un tiers, hors
 *    de l'Union européenne. L'écran disait seulement que la machine « se
 *    trompe et qu'il lui arrive d'inventer ». C'est vrai, et ce n'est pas
 *    la question : personne n'était informé du départ.
 *
 * Une phrase générique aurait été pire que rien. Écrire « votre voix part
 * chez un tiers » sur une installation SANS clé serait faux, et ferait
 * renoncer des gens à un chemin qui ne sort de nulle part. Ce qui est dit
 * dépend donc de la configuration RÉELLE du serveur — lue ici, à un seul
 * endroit, plutôt que devinée dans chaque écran.
 *
 * §6.2 : toute suggestion porte sa justification. §3.5 : rien n'entre sans
 * relecture. Il manquait la troisième — rien ne sort sans qu'on le dise.
 */

export type CheminDeTranscription = 'local' | 'api';

/**
 * Le chemin qu'empruntera une transcription demandée MAINTENANT, sur CE
 * serveur. Lu à chaque appel : la clé peut être ajoutée ou retirée sans
 * reconstruire l'application.
 */
export function cheminDeTranscription(): CheminDeTranscription {
  return process.env.OPENAI_API_KEY ? 'api' : 'local';
}

/** Le nom du tiers, quand il y en a un. Jamais inventé, jamais tu. */
export const TIERS_TRANSCRIPTION = 'OpenAI (États-Unis)';

/**
 * Ce qu'on dit à quelqu'un qui s'apprête à demander une transcription.
 * Deux textes, parce qu'il y a deux vérités différentes.
 */
export const AVERTISSEMENT_TRANSCRIPTION: Record<CheminDeTranscription, string> = {
  local:
    'Le texte sera produit sur cet appareil : l’enregistrement ne quitte pas le serveur de la famille.',
  api: `L’enregistrement sera envoyé à ${TIERS_TRANSCRIPTION} pour être transcrit. La voix de la personne sort donc du serveur de la famille, et de l’Union européenne. Le texte revient ici ; l’enregistrement, lui, aura été transmis.`,
};

/**
 * La même chose, à froid, pour la page de reddition de comptes. Elle décrit
 * l'installation — pas un geste en cours.
 */
export const SORTIE_DECRITE: Record<CheminDeTranscription, string> = {
  local:
    'Rien ne sort. Les transcriptions sont produites dans le navigateur de la personne qui relit, et aucun service tiers ne reçoit vos enregistrements. Aucun texte de récit n’est envoyé nulle part.',
  api: `Les enregistrements que vous envoyez en transcription partent chez ${TIERS_TRANSCRIPTION}. C’est le seul contenu de votre mémoire qui quitte ce serveur, et il ne part que sur un geste explicite : personne ne transcrit à votre place. Le reste — récits, photos, fils, dates — ne sort jamais.`,
};
