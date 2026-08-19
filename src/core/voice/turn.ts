/**
 * LE TOUR DE PAROLE — ce qui rend l'oral fluide SANS rien concéder. ADR-074.
 *
 * `docs/06` tranche d'avance, et c'est la contrainte de tout ce fichier :
 *
 * > **« Et l'honnêteté prime sur la fluidité. »**
 * > ✅ « Le calendrier n'a pas confirmé le changement. Je ne te dis pas qu'il
 * >    est fait. »  ❌ « C'est modifié ! »
 *
 * LE PROBLÈME, POSÉ CORRECTEMENT
 * ---------------------------------------------------------------------------
 * Un assistant vocal généraliste paraît fluide parce qu'il **parle avant de
 * savoir** : il génère une continuation plausible pendant que l'action est
 * encore en vol. Jarvis ne peut pas faire cela — c'est précisément ce que
 * `S15` interdit.
 *
 * Mais il n'en a pas besoin, et la mesure le montre :
 *
 * ```text
 * Intent Tier 0                    0,0046 ms   ← mesuré, 10 000 énoncés
 * Policy Gate (Cedar, en mémoire)  < 1 ms
 * Outil local + relecture          quelques ms (PostgreSQL local)
 * ```
 *
 * **La chaîne de Jarvis ne coûte rien.** L'intuition « vérifié, donc lent » est
 * fausse ici : le budget de latence est presque entièrement consommé par la
 * transcription et la synthèse, pas par la vérification.
 *
 * LA SOLUTION : DEUX TEMPS, COMME UN HUMAIN
 * ------------------------------------------
 * ```text
 * « ajoute du café à ma liste »
 *   ↓ immédiat
 * « je m'en occupe »        ← ne prétend RIEN sur l'action
 *   ↓ quelques millisecondes
 * « c'est dans ta liste »   ← le VERDICT, quand il est connu
 * ```
 *
 * Ce n'est pas une astuce pour paraître rapide : l'accusé de réception porte
 * sur **la réception**, pas sur l'effet. Un humain dit « ok, je le fais » avant
 * de l'avoir fait, et personne n'y voit un mensonge.
 *
 * CE QUI REND LA PROPRIÉTÉ STRUCTURELLE ET NON DÉCLARATIVE
 * --------------------------------------------------------
 * `accuseReception` ne reçoit **que la proposition d'intention**. Elle n'a
 * aucun accès à un statut de vérification, à une sortie d'outil, à un verdict.
 * Elle est donc **incapable** de dire « c'est fait » — pas par discipline, par
 * type.
 *
 * ⚠ Le nom du type de statut ne s'écrit nulle part dans ce fichier, et ce n'est
 * pas un hasard : `tests/voice/tour.test.ts` cherche ce nom en TEXTE BRUT, y
 * compris dans les commentaires. Le détecteur reste bête exprès — le rendre
 * assez malin pour ignorer les commentaires, c'est lui ouvrir un trou.
 *
 * C'est le geste de `confirmed()`, qui est la seule fabrique de `CONFIRMED` du
 * système : on ne demande pas à l'auteur de se retenir, on lui retire le
 * moyen.
 *
 * ⚠ CE QUI EST BRANCHÉ, ET CE QUI NE L'EST PAS — À LIRE AVANT DE CITER CE FICHIER
 * ---------------------------------------------------------------------------
 * `tests/redteam/wiring.test.ts` raisonne par FICHIER : il dira que ce module
 * est atteint. Il le sera — par `ecouter`, que le CLI appelle sur chaque ligne.
 * Cela ne dit **rien** d'`accuseReception`.
 *
 * ```text
 * ecouter          BRANCHÉ   src/apps/cli/main.ts, sur chaque énoncé
 * accuseReception  ÉCRIT     aucun appelant de production
 * ```
 *
 * `accuseReception` n'a pas d'appelant honnête aujourd'hui : dans un terminal,
 * le verdict arrive en quelques millisecondes, et intercaler « je m'en occupe »
 * avant « c'est fait » dégraderait la lecture pour faire tourner du code. Elle
 * attend une surface où l'attente EXISTE — la synthèse vocale. Écrire le
 * contrat avant le tuyau est délibéré (même geste que le CostGate, ADR-040) ;
 * le faire passer pour branché serait le défaut que `docs/26 §2` recense neuf
 * fois. `tests/voice/tour.test.ts` fige les deux moitiés séparément.
 */
import type { IntentProposal } from '../intent/engine.js';

/**
 * Un énoncé transcrit — et le champ qui décide de tout.
 *
 * UNE TRANSCRIPTION PARTIELLE EST UNE HYPOTHÈSE, PAS UNE PHRASE
 * -------------------------------------------------------------
 * Un moteur de reconnaissance en flux émet des hypothèses qu'il **révise**.
 * « Envoie un message à Paul » passe par « Envoie un message », puis
 * « Envoie un message à Pau »… Agir sur l'une d'elles, c'est agir sur quelque
 * chose que l'utilisateur **n'a jamais dit**.
 *
 * Le risque n'est pas théorique : c'est exactement le gain de fluidité que
 * cherche un assistant vocal — commencer plus tôt. Ici, commencer plus tôt sur
 * un texte mutable produirait une action sur une phrase inventée par la
 * machine.
 *
 * D'où l'invariant : **un énoncé non final ne franchit jamais le Policy Gate.**
 */
export interface Utterance {
  readonly text: string;
  /** Le moteur de transcription garantit-il que ce texte ne changera plus ? */
  readonly final: boolean;
}

/**
 * Ce qu'on a le droit de faire d'un énoncé.
 *
 * Une décision NOMMÉE plutôt qu'un booléen : `peutAgir(u)` se lit comme une
 * permission, et une permission se contourne en la niant. `ATTENDRE` porte son
 * motif, et ce motif se dit à l'utilisateur si besoin.
 */
export type EcouteVerdict =
  | { readonly kind: 'AGIR'; readonly texte: string }
  | { readonly kind: 'ATTENDRE'; readonly motif: string };

/**
 * Décide si un énoncé peut entrer dans la chaîne.
 *
 * Le seul chemin par lequel de l'audio devient une action. Un appelant qui
 * passerait `utterance.text` directement au moteur d'intention contournerait
 * cette porte — `tests/voice/tour.test.ts` vérifie qu'aucun code de `src/` ne
 * le fait.
 */
export function ecouter(utterance: Utterance): EcouteVerdict {
  if (!utterance.final) {
    return {
      kind: 'ATTENDRE',
      motif:
        'transcription encore provisoire : le moteur peut la réviser, et agir ' +
        "sur une hypothèse reviendrait à agir sur une phrase que l'utilisateur " +
        "n'a pas prononcée",
    };
  }
  if (utterance.text.trim().length === 0) {
    return {
      kind: 'ATTENDRE',
      motif: 'énoncé vide : rien n’a été compris, et le silence n’est pas une demande',
    };
  }
  return { kind: 'AGIR', texte: utterance.text.trim() };
}

/**
 * LES SEULES PHRASES D'ACCUSÉ DE RÉCEPTION.
 *
 * Un ensemble CLOS, et c'est ce qui le rend vérifiable : on peut prouver
 * qu'aucune d'elles n'affirme un effet. Une phrase libre ne se prouverait pas.
 *
 * Aucune ne contient de passé composé d'action — « c'est fait », « envoyé »,
 * « ajouté ». Toutes portent sur la RÉCEPTION ou sur l'INTENTION, jamais sur le
 * résultat.
 */
export const ACCUSES = {
  /** Cas courant : la demande est comprise, l'action part. */
  ENGAGE: "je m'en occupe",
  /** L'action demande une confirmation : on annonce la question qui vient. */
  CONFIRMATION: 'un instant, je te demande une confirmation',
  /** La demande n'a pas été comprise : on le dit tout de suite. */
  INCOMPRIS: "je n'ai pas compris",
} as const;

export type Accuse = (typeof ACCUSES)[keyof typeof ACCUSES];

/**
 * CE QUE JARVIS DIT IMMÉDIATEMENT — et qui ne prétend rien.
 *
 * ⚠ LA SIGNATURE EST LA GARANTIE. Cette fonction ne reçoit que la
 * PROPOSITION : ni statut de vérification, ni sortie d'outil, ni verdict. Elle
 * ne peut donc pas dire « c'est fait », quoi qu'écrive son auteur — au même
 * titre que `confirmed()` ne peut pas fabriquer un succès sans preuve.
 *
 * Lui passer un jour le résultat serait le geste qui rouvre le mensonge. Le
 * test structurel de `tests/voice/tour.test.ts` le refuse.
 */
export function accuseReception(proposal: IntentProposal): Accuse {
  if (proposal.kind === 'TOOL_CALL') {
    /* `userConfirms` dit que l'énoncé VAUT confirmation ; sinon une question
       peut suivre, et l'annoncer évite le silence pendant qu'elle se prépare.
       Le silence est ce qui fait dire « il a planté ». */
    return proposal.userConfirms ? ACCUSES.ENGAGE : ACCUSES.CONFIRMATION;
  }
  /* CLARIFY comme UNSUPPORTED : dans les deux cas Jarvis n'a pas de quoi agir,
     et le dire tout de suite vaut mieux qu'un blanc suivi d'une question. */
  return ACCUSES.INCOMPRIS;
}
