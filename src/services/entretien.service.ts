import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { PasseurService, passeur as defaultPasseur } from './passeur.service';
import { ReserveService, reserveService as defaultReserves } from './reserve.service';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

/**
 * L'ENTRETIEN — une question à la fois, à voix haute.
 *
 * Les deux personnes qui détiennent le plus de mémoire dans une famille sont
 * souvent celles qui écrivent le moins. La §5.5 l'a reconnu pour l'enfant de
 * sept ans ; c'est aussi vrai à l'autre bout.
 *
 * Ce service n'invente rien : le Passeur pose déjà des questions, la
 * transcription exige déjà une relecture humaine (§3.5), la §2.3 sépare déjà
 * le narrateur du scribe. L'entretien les assemble en un geste — un écran,
 * une question, un bouton — et c'est ce qui le rend peu risqué : s'il est
 * faux, le retirer ne coûte rien.
 *
 * ── La séparation est le mode d'emploi ──
 *
 * Jeanne parle, Emma relit. Cela crée le rôle qui manquait au produit :
 * « relire ce que ta grand-mère a dit hier » est court, concret, et se
 * reprend après six mois d'interruption — contrairement à « animer la
 * mémoire familiale ».
 */

/**
 * Les questions de secours, quand le Passeur n'a rien à proposer.
 *
 * Ce sont celles de la §5.5, formulées pour être ENTENDUES et non lues :
 * une question posée à voix haute n'a pas la même syntaxe qu'une étiquette
 * de bouton. Elles ne dépendent d'aucun récit — c'est tout l'intérêt : une
 * mémoire vide doit pouvoir commencer par la parole.
 */
export const QUESTIONS_DE_DEPART = [
  'De qui vous souvenez-vous le mieux, dans la maison où vous avez grandi ?',
  // « quand vous pensez à votre enfance » se heurtait au motif `pensez à`
  // du filtre non coercitif — un faux positif, ce motif visant l'injonction
  // « pensez à raconter ». On reformule plutôt que d'assouplir la garde :
  // une garde franche qui coûte un mot vaut mieux qu'une garde nuancée qui
  // laisse passer une relance culpabilisante.
  'Quel est le premier lieu qui vous revient, de votre enfance ?',
  'Y a-t-il un objet que votre famille a gardé, et dont personne ne sait plus l’histoire ?',
  'Qu’est-ce qu’on faisait chez vous, que plus personne ne fait ?',
  'De quoi parlait-on à table, quand vous étiez petit ?',
] as const;

export interface QuestionEntretien {
  texte: string;
  /** Pourquoi celle-ci. §6.2 : toute suggestion porte sa justification. */
  justification: string;
  /** Le récit visé, quand il y en a un. Sert à la provenance, pas à filtrer. */
  storyId: string | null;
  /** L'entité visée : c'est elle qu'un « passer » met en retrait. */
  entityId: string | null;
}

export interface Entretien {
  question: QuestionEntretien;
  /** Nul entretien sans relecteur nommé : voir `relecteursPossibles`. */
  relecteurId: string;
}

export class EntretienService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private passeur: PasseurService = defaultPasseur,
    private reserves: ReserveService = defaultReserves,
  ) {}

  /**
   * Qui peut relire, pour celui qui parle.
   *
   * **Jamais soi-même.** Toute la valeur du dispositif tient à ce qu'une
   * autre personne écoute : c'est elle qui garantit que rien d'inventé par
   * la machine n'entre dans la mémoire (§3.5), et c'est le rôle qui donne à
   * quelqu'un une raison de revenir.
   *
   * Le relecteur est désigné à CHAQUE entretien, jamais une fois pour
   * toutes : un relecteur permanent deviendrait le dépositaire de tous les
   * secrets de la maison sans que personne l'ait décidé, et l'entretien
   * suivant se ferait devant lui par défaut — ce qui n'est pas un
   * consentement.
   */
  async relecteursPossibles(familyId: string, quiParleId: string) {
    return this.prisma.member.findMany({
      where: { familyId, isDeleted: false, id: { not: quiParleId } },
      select: { id: true, name: true, generation: true },
      orderBy: [{ generation: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * La question à poser maintenant.
   *
   * Le Passeur d'abord — il sait ce qui manque à la mémoire, et il respecte
   * déjà les réserves de celui qui parle. À défaut, une question de départ
   * qui ne suppose aucun récit.
   *
   * `passees` porte les entités déjà passées dans cette session. Deux
   * passages sur le même sujet et l'on cesse de le proposer, silencieusement
   * — c'est la règle « un signal comportemental ne peut que retirer ».
   */
  async prochaineQuestion(
    familyId: string,
    quiParleId: string,
    passees: string[] = [],
  ): Promise<QuestionEntretien> {
    const duPasseur = await this.passeur.generateQuestion(familyId, quiParleId);

    if (duPasseur) {
      const entityId = await this.entiteDe(duPasseur.storyId);
      const enRetrait = compter(passees, entityId) >= 2;
      if (!enRetrait) {
        return {
          texte: duPasseur.text,
          justification: duPasseur.justification,
          storyId: duPasseur.storyId,
          entityId,
        };
      }
    }

    // Le repli tourne sur les entités déjà écartées : une question de départ
    // ne porte sur rien de précis, donc rien à mettre en retrait.
    const enReserve = await this.reserves.entitesEnReserve(familyId, quiParleId);
    const index = (passees.length + enReserve.size) % QUESTIONS_DE_DEPART.length;

    return {
      texte: QUESTIONS_DE_DEPART[index]!,
      justification:
        'Cette question ne vient d’aucun récit : elle est là pour commencer, et vous pouvez la passer.',
      storyId: null,
      entityId: null,
    };
  }

  /** L'entité principale d'un récit, s'il en a une. Sert au « passer ». */
  private async entiteDe(storyId: string | null): Promise<string | null> {
    if (!storyId) return null;
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      select: { linkedEntities: { select: { id: true }, take: 1 } },
    });
    return story?.linkedEntities[0]?.id ?? null;
  }
}

function compter(liste: string[], valeur: string | null): number {
  if (!valeur) return 0;
  return liste.filter((element) => element === valeur).length;
}

export const entretienService = new EntretienService();

/**
 * Ce que l'on dit AVANT le premier enregistrement, jamais après.
 *
 * Quelqu'un qui parle seul dans une pièce doit savoir qui l'écoutera avant
 * d'ouvrir la bouche. La confidentialité d'un entretien n'est pas une note
 * de bas de page — et sans relecteur nommé, l'entretien ne commence pas.
 */
export function avertissement(nomDuRelecteur: string): string {
  return `Ce que vous direz sera relu par ${nomDuRelecteur}.`;
}

/** Les phrases fixes de l'entretien, extraites pour être testées. */
export const ENTRETIEN = {
  titre: 'Parler',
  quoi: 'Une question, et vous répondez à voix haute. Rien à écrire.',
  passer: 'Passer',
  garder: 'Garder',
  effacer: 'Effacer',
  terminer: 'Terminer',
  reserve: 'Y a-t-il des choses dont vous ne voulez pas qu’on vous parle ?',
  /**
   * Dit au moment de la réécoute. C'est le moment où quelqu'un qui vient de
   * dire une chose qu'il regrette peut la reprendre — et il doit être AVANT
   * la transcription, sinon le texte existe déjà quelque part.
   */
  reecoute: 'Réécoutez avant de garder. Effacer ne laisse rien.',
} as const;

/** Les phrases de ce module franchissent les deux filtres. Testé. */
export function phrasesDeLEntretien(): string[] {
  return [...Object.values(ENTRETIEN), ...QUESTIONS_DE_DEPART, avertissement('Emma')];
}

export { constitutionEmotionFilter, isNonCoerciveLanguage };
