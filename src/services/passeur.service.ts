import type { Entity, Member, Prisma, PrismaClient, Story } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { store as defaultStore, type KeyValueStore } from '@/lib/redis';
import { constitutionEmotionFilter } from '@/lib/constitution';
import { LLMOperatorService, llmOperator as defaultLlm } from './llm-operator.service';
import { ConservateurService, conservateur as defaultConservateur } from './conservateur.service';
import { ThreadService, threadService as defaultThreads } from './thread.service';
import { ReserveService, reserveService as defaultReserves } from './reserve.service';

/**
 * PASSEUR SERVICE — §3.3.
 *
 * Mission : augmenter la probabilité qu'une histoire engendre une autre.
 * Poser des questions, jamais imposer des réponses.
 *
 * Règles de génération :
 *  1. Une seule question par session (parcimonie).
 *  2. La question doit être justifiable en une phrase.
 *  3. La question ne doit jamais inférer une émotion.
 *  4. La question doit pointer vers un vide informationnel.
 *
 * ── Coût ──
 * Une règle ne parcourt jamais tout le corpus : elle déclare une requête
 * bornée qui décrit ce qu'elle cherche. Et la formulation par le LLM
 * n'intervient qu'APRÈS la sélection, sur la seule question retenue :
 * poser la question au modèle pour chaque candidat reviendrait à payer
 * cinquante appels pour en afficher un.
 */

export interface PasseurQuestion {
  text: string;
  justification: string;
  /** Le récit visé, quand la question en désigne un. */
  storyId: string | null;
  /** Le fil visé. Une question posée dans un fil n'a pas toujours de récit. */
  threadId: string | null;
  ruleId: string;
  confidence: number; // 0-1
}

/** Ce sur quoi porte la question — c'est aussi la clé de « déjà posée ». */
export function subjectOf(question: PasseurQuestion): string {
  return question.threadId ?? question.storyId ?? 'sans-objet';
}

export type StoryWithEntities = Story & {
  linkedEntities: Entity[];
};

export interface PasseurContext {
  members: Member[];
  /** Le membre à qui l'on s'adresse. Une question ne lui est jamais renvoyée. */
  memberId: string;
  now: Date;
}

interface PasseurRule {
  id: string;
  weight: number;
  /** Requête bornée : ce que la règle cherche, exprimé en SQL plutôt qu'en boucle. */
  where(context: PasseurContext): Prisma.StoryWhereInput;
  /** Nombre maximum de récits examinés par cette règle. */
  take: number;
  /** Filtre fin, en mémoire, sur le petit lot renvoyé. Synchrone et bon marché. */
  match(story: StoryWithEntities, context: PasseurContext): boolean;
  /** Formulation déterministe. C'est elle qui fait foi si le LLM est absent. */
  draft(story: StoryWithEntities, context: PasseurContext): PasseurQuestion | null;
  /** Reformulation par le LLM. Appelée uniquement sur la question retenue. */
  enrich?(
    question: PasseurQuestion,
    story: StoryWithEntities,
    llm: LLMOperatorService,
  ): Promise<PasseurQuestion>;
}

/**
 * Marqueurs de tension : une chose est dite, sa raison ne l'est pas.
 * Volontairement restrictif — un marqueur trop large ("pas", "ne") ferait
 * de chaque récit une tension, donc d'aucun.
 */
const TENSION_MARKERS = [
  /\brefusai?t\b/i,
  /\bn'a jamais (voulu|accepté|dit|expliqué)\b/i,
  /\bne (voulait|voulut|parlait|parla) jamais\b/i,
  /\bpersonne ne (sait|savait|comprenait|a jamais su)\b/i,
  /\bon n'a jamais su\b/i,
  /\bsans (jamais )?(expliquer|dire pourquoi|un mot)\b/i,
  /\bmystère\b/i,
  /\bmais il (n'|ne )/i,
  /\bmais elle (n'|ne )/i,
];

const YEAR_MS = 86_400_000 * 365.25;

export const PASSEUR_RULES: PasseurRule[] = [
  {
    id: 'TENSION_UNRESOLVED',
    weight: 1.0,
    take: 40,
    // Les marqueurs ne s'expriment pas en SQL : on borne au corpus récent.
    where: () => ({}),
    match(story) {
      return TENSION_MARKERS.some((marker) => marker.test(story.content));
    },
    draft(story) {
      // On ne détecte pas une « tension non résolue » : on repère une
      // tournure. Décréter la tension serait présenter une inférence comme
      // un constat. Citer le passage rend la justification vérifiable —
      // la famille peut juger elle-même si le Passeur a raison.
      const fragment = tensionFragment(story.content);
      if (!fragment) return null;

      return {
        text: `« ${story.title} » raconte un fait sans en donner la raison. Quelqu'un connaît-il le reste ?`,
        justification: `Ce récit dit : « ${fragment} » — sans dire pourquoi.`,
        storyId: story.id,
        threadId: null,
        ruleId: 'TENSION_UNRESOLVED',
        confidence: 0.8,
      };
    },
    async enrich(question, story, llm) {
      // Le LLM ne choisit ni l'histoire, ni la règle — seulement les mots.
      const text = await llm.phraseQuestion(story.content, question.text);
      return constitutionEmotionFilter(text) ? { ...question, text } : question;
    },
  },
  {
    id: 'MISSING_VIEWPOINT',
    weight: 0.9,
    take: 40,
    where: () => ({ linkedEntities: { some: { type: 'PERSON' } } }),
    match(story, context) {
      const linkedPeople = story.linkedEntities.filter((entity) => entity.type === 'PERSON');
      return linkedPeople.length > 0 && linkedPeople.length < context.members.length;
    },
    draft(story, context) {
      const linkedMemberIds = new Set(
        story.linkedEntities.map((entity) => entity.memberId).filter((id): id is string => Boolean(id)),
      );

      // La date de l'événement raconté, à défaut celle du récit.
      const reference = story.eventDate ?? story.createdAt;

      const missing = context.members.find(
        (member) =>
          !linkedMemberIds.has(member.id) &&
          member.id !== story.authorId &&
          !member.deathDate &&
          // Sans ce filtre, l'application demandait à un enfant de sept ans
          // son point de vue sur un déménagement de 1971. Absurde, et blessant
          // quand le récit touche à un deuil.
          couldRememberFirsthand(member, reference),
      );
      if (!missing) return null;

      return {
        // Ce n'est pas un constat sur ce que ce membre a vécu — on n'en sait
        // rien. C'est une invitation, et elle est formulée comme telle.
        text: `${missing.name} en garde peut-être un autre souvenir. Le sien n'a pas été noté.`,
        // L'ancienne justification disait « un membre lié à cette histoire »
        // alors que la règle choisit précisément quelqu'un qui n'y est PAS
        // rattaché : elle affirmait le contraire de son propre critère.
        justification: `${missing.name} n'apparaît pas dans ce récit, et n'en a pas donné sa version.`,
        storyId: story.id,
        threadId: null,
        ruleId: 'MISSING_VIEWPOINT',
        confidence: 0.7,
      };
    },
  },
  {
    id: 'RARE_PATRIMONY',
    weight: 0.8,
    take: 10,
    where: (context) => ({
      views: { lt: 5 },
      OR: [
        { lastViewedAt: { lt: new Date(context.now.getTime() - YEAR_MS) } },
        { lastViewedAt: null, createdAt: { lt: new Date(context.now.getTime() - YEAR_MS) } },
      ],
    }),
    match: () => true,
    draft(story) {
      // « fait partie des récits les moins relus » est un comparatif que la
      // règle ne vérifie pas : elle teste ce récit seul, jamais les autres.
      // Si tout le corpus est peu lu, celui-ci n'a rien de singulier. On
      // s'en tient donc à ce qui est mesuré.
      return {
        text: story.lastViewedAt
          ? `« ${story.title} » n'a pas été rouvert depuis plus d'un an.`
          : `« ${story.title} » n'a jamais été rouvert depuis qu'il a été écrit.`,
        justification: story.lastViewedAt
          ? `${story.views} lecture${story.views > 1 ? 's' : ''} enregistrée${story.views > 1 ? 's' : ''}, la dernière le ${story.lastViewedAt.toISOString().split('T')[0]}.`
          : `Aucune lecture enregistrée depuis la création de ce récit.`,
        storyId: story.id,
        threadId: null,
        ruleId: 'RARE_PATRIMONY',
        confidence: 0.6,
      };
    },
  },
  {
    id: 'TEMPORAL_LINK',
    weight: 0.7,
    take: 10,
    where: (context) => ({ createdAt: { lt: new Date(context.now.getTime() - 2 * YEAR_MS) } }),
    match: () => true,
    draft(story, context) {
      const years = Math.floor((context.now.getTime() - story.createdAt.getTime()) / YEAR_MS);
      return {
        text: `« ${story.title} » a été raconté il y a ${years} ans. Qu'est-ce qui a changé depuis ?`,
        justification: `Le temps a passé depuis la création de cette histoire (${years} ans).`,
        storyId: story.id,
        threadId: null,
        ruleId: 'TEMPORAL_LINK',
        confidence: 0.5,
      };
    },
  },
];

const SESSION_TTL_SECONDS = 3600; // 1 question par heure par membre
const RECENT_QUESTION_TTL_SECONDS = 14 * 86_400;

export class PasseurService {
  constructor(
    private prisma: PrismaClient = defaultPrisma,
    private store: KeyValueStore = defaultStore,
    private llm: LLMOperatorService = defaultLlm,
    private conservateur: ConservateurService = defaultConservateur,
    private threads: ThreadService = defaultThreads,
    private reserves: ReserveService = defaultReserves,
  ) {}

  async generateQuestion(
    familyId: string,
    memberId: string,
    now = new Date(),
  ): Promise<PasseurQuestion | null> {
    // Parcimonie : une question par session.
    if (await this.store.get(sessionKey(familyId, memberId))) return null;

    const [members, muted, enReserve, recitsReserves] = await Promise.all([
      this.prisma.member.findMany({ where: { familyId, isDeleted: false } }),
      // Ce que CE membre a fait taire — pas ce que la famille a fait taire.
      this.conservateur.mutedStoryIds(familyId, memberId),
      // Ce sur quoi CE membre a demandé qu'on ne l'interroge plus. La
      // sourdine porte sur un récit déjà lu ; la réserve vient avant, et
      // porte sur le sujet lui-même. Personne d'autre ne la connaît.
      this.reserves.entitesEnReserve(familyId, memberId),
      // Et les récits qui parlent de ce sujet : une question peut arriver
      // par un fil accroché à un récit, sans passer par l'entité.
      this.reserves.recitsEnReserve(familyId, memberId),
    ]);
    const context: PasseurContext = { members, memberId, now };

    // Filtre posé DANS LA REQUÊTE, et non après le tri : un récit écarté
    // par une réserve ne doit jamais entrer dans les candidats, sans quoi il
    // suffirait d'un chemin oublié pour que la question revienne.
    const horsReserve =
      enReserve.size > 0 ? { linkedEntities: { none: { id: { in: [...enReserve] } } } } : {};

    // ── Avant toute règle : une question que quelqu'un a réellement posée ──
    //
    // Elle passe devant les règles déduites d'un texte, et c'est délibéré :
    // c'est le seul vide informationnel que le produit n'a pas inféré. Depuis
    // le fil, elle n'a plus besoin d'un récit pour exister — on peut demander
    // « d'où venait ce vélo ? » sans que personne ait rédigé quoi que ce soit.
    //
    // La réserve s'applique ici aussi, et il faut y penser : ce chemin
    // passe DEVANT les règles et ne verrait pas le filtre posé plus bas.
    // Une question posée par un proche reste une question, et ne fait pas
    // exception au silence demandé.
    const posee = await this.unansweredQuestion(familyId, memberId, enReserve, recitsReserves);
    if (posee && !(await this.wasAskedRecently(familyId, memberId, subjectOf(posee), posee.ruleId))) {
      return this.remember(familyId, memberId, posee);
    }

    // Une requête bornée par règle, en parallèle — jamais un scan du corpus.
    const perRule = await Promise.all(
      PASSEUR_RULES.map(async (rule) => ({
        rule,
        stories: (await this.prisma.story.findMany({
          where: {
            familyId,
            archived: false,
            ...(muted.length > 0 ? { id: { notIn: muted } } : {}),
            ...horsReserve,
            ...rule.where(context),
          },
          include: { linkedEntities: true },
          orderBy: { createdAt: 'desc' },
          take: rule.take,
        })) as StoryWithEntities[],
      })),
    );

    const drafts: PasseurQuestion[] = [];
    for (const { rule, stories } of perRule) {
      for (const story of stories) {
        if (!rule.match(story, context)) continue;
        const question = rule.draft(story, context);
        // Règle 3 : le filtre constitutionnel s'applique aussi aux formulations internes.
        if (question && constitutionEmotionFilter(question.text)) drafts.push(question);
      }
    }

    drafts.sort((a, b) => score(b) - score(a));

    // On descend le classement jusqu'au premier candidat recevable. Les
    // vérifications coûteuses (store) ne portent que sur les meilleurs, pas
    // sur les cinquante autres.
    for (const candidate of drafts) {
      if (await this.wasAskedRecently(familyId, memberId, subjectOf(candidate), candidate.ruleId)) continue;
      // Le Conservateur retire les sur-exposées des suggestions.
      if (candidate.storyId && (await this.conservateur.isOverexposed(candidate.storyId))) continue;

      return this.remember(familyId, memberId, await this.enrichSelected(candidate, perRule));
    }

    return null;
  }

  /**
   * Un fil ouvert par une question, et personne n'a repris la parole.
   * Le fil peut pendre à un récit, à une entité, ou à rien : la question
   * existe indépendamment de ce qui a été rédigé.
   */
  private async unansweredQuestion(
    familyId: string,
    memberId: string,
    enReserve: Set<string> = new Set(),
    recitsReserves: Set<string> = new Set(),
  ): Promise<PasseurQuestion | null> {
    const filtre = enReserve.size > 0 || recitsReserves.size > 0;
    // On demande plus d'un fil : le premier peut porter sur un sujet mis en
    // réserve, et s'arrêter là ferait taire le Passeur pour rien.
    const threads = await this.threads.unanswered(familyId, memberId, filtre ? 10 : 1);
    // Les DEUX ancrages. Un fil peut pendre à une entité ou à un récit, et
    // c'est par le second que la question passait encore.
    const thread = threads.find(
      (t) =>
        (!t.entityId || !enReserve.has(t.entityId)) &&
        (!t.storyId || !recitsReserves.has(t.storyId)),
    );
    const question = thread?.messages[0];
    if (!thread || !question) return null;

    const sujet = thread.story
      ? `sur « ${thread.story.title} »`
      : thread.entity
        ? `à propos de ${thread.entity.name}`
        : `à la famille`;

    return {
      text: `« ${question.body} »`,
      justification: `${thread.openedBy.name} a posé cette question ${sujet}. Personne n'a encore repris la parole dans ce fil.`,
      storyId: thread.storyId,
      threadId: thread.id,
      ruleId: 'UNANSWERED_QUESTION',
      confidence: 0.95,
    };
  }

  /** Parcimonie : une question par heure, et jamais deux fois la même. */
  private async remember(
    familyId: string,
    memberId: string,
    question: PasseurQuestion,
  ): Promise<PasseurQuestion> {
    await this.store.setex(sessionKey(familyId, memberId), SESSION_TTL_SECONDS, question.ruleId);
    await this.store.setex(
      askedKey(familyId, memberId, subjectOf(question), question.ruleId),
      RECENT_QUESTION_TTL_SECONDS,
      'true',
    );
    return question;
  }

  /** Un seul appel LLM par session, sur la seule question qui sera affichée. */
  private async enrichSelected(
    question: PasseurQuestion,
    perRule: Array<{ rule: PasseurRule; stories: StoryWithEntities[] }>,
  ): Promise<PasseurQuestion> {
    const entry = perRule.find(({ rule }) => rule.id === question.ruleId);
    if (!entry?.rule.enrich || !this.llm.isAvailable) return question;

    const story = entry.stories.find((candidate) => candidate.id === question.storyId);
    if (!story) return question;

    return entry.rule.enrich(question, story, this.llm);
  }

  /** Une question ignorée ne revient pas avant deux semaines. */
  async markIgnored(familyId: string, memberId: string, subjectId: string, ruleId: string): Promise<void> {
    await this.store.setex(askedKey(familyId, memberId, subjectId, ruleId), RECENT_QUESTION_TTL_SECONDS, 'true');
  }

  private async wasAskedRecently(familyId: string, memberId: string, subjectId: string, ruleId: string) {
    return (await this.store.get(askedKey(familyId, memberId, subjectId, ruleId))) === 'true';
  }
}

/**
 * Âge en deçà duquel on n'invite pas quelqu'un à raconter son souvenir d'un
 * événement. Ce n'est pas une théorie sur la mémoire : c'est une borne de
 * bon sens. Sur les données réelles, sans elle, l'application proposait à
 * Emma — née le jour même — de donner sa version de sa propre naissance.
 */
const MEMORY_AGE_YEARS = 5;

/**
 * Cette personne peut-elle avoir un souvenir de première main de ce récit ?
 *
 * On ne conclut jamais qu'elle en a un — seulement qu'elle n'est pas exclue.
 * Une date de naissance inconnue ne disqualifie personne : on ne sait pas,
 * et on ne prétend pas savoir.
 */
export function couldRememberFirsthand(
  member: { birthDate: Date | null; deathDate: Date | null },
  reference: Date,
): boolean {
  if (member.birthDate && member.birthDate.getTime() > reference.getTime() - MEMORY_AGE_YEARS * YEAR_MS)
    return false;
  if (member.deathDate && member.deathDate < reference) return false;
  return true;
}

/** Le bout de phrase qui a déclenché la règle, rendu citable. */
export function tensionFragment(content: string, maxLength = 90): string | null {
  for (const marker of TENSION_MARKERS) {
    const found = content.match(marker);
    if (!found || found.index === undefined) continue;

    // On étend jusqu'aux frontières de phrase, pour citer quelque chose de
    // lisible plutôt que trois mots arrachés à leur contexte.
    const before = content.lastIndexOf('.', found.index) + 1;
    const afterDot = content.indexOf('.', found.index + found[0].length);
    const after = afterDot === -1 ? content.length : afterDot;

    const sentence = content.slice(before, after).replace(/\s+/g, ' ').trim();
    if (!sentence) continue;

    return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trimEnd()}…` : sentence;
  }
  return null;
}

function score(question: PasseurQuestion): number {
  const rule = PASSEUR_RULES.find((r) => r.id === question.ruleId);
  return question.confidence * (rule?.weight ?? 0);
}

function sessionKey(familyId: string, memberId: string) {
  return `passeur:${familyId}:${memberId}`;
}

function askedKey(familyId: string, memberId: string, subjectId: string, ruleId: string) {
  return `passeur:asked:${familyId}:${memberId}:${subjectId}:${ruleId}`;
}

export const passeur = new PasseurService();
