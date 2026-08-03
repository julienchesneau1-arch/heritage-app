import type { Conversation, Entity, Member, Prisma, PrismaClient, Story } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { store as defaultStore, type KeyValueStore } from '@/lib/redis';
import { constitutionEmotionFilter } from '@/lib/constitution';
import { LLMOperatorService, llmOperator as defaultLlm } from './llm-operator.service';
import { ConservateurService, conservateur as defaultConservateur } from './conservateur.service';

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
  storyId: string;
  ruleId: string;
  confidence: number; // 0-1
}

export type StoryWithEntities = Story & {
  linkedEntities: Entity[];
  conversations: Conversation[];
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
    /**
     * Un membre de la famille a posé une question, et personne n'a répondu.
     *
     * C'est le vide informationnel le plus pur du produit : il n'a pas été
     * déduit d'un texte, il a été formulé par quelqu'un. Sans cette règle,
     * une question posée n'est visible qu'en rouvrant le récit exact sur
     * lequel elle porte — autant dire qu'elle se perd.
     */
    id: 'UNANSWERED_QUESTION',
    weight: 1.0,
    take: 10,
    where: () => ({ conversations: { some: { status: 'pending' } } }),
    match(story, context) {
      return story.conversations.some(
        (conversation) =>
          conversation.status === 'pending' && conversation.questionerId !== context.memberId,
      );
    },
    draft(story, context) {
      const pending = story.conversations.find(
        (conversation) =>
          conversation.status === 'pending' && conversation.questionerId !== context.memberId,
      );
      if (!pending) return null;

      const asker = context.members.find((member) => member.id === pending.questionerId);
      return {
        text: `« ${pending.questionText} »`,
        justification: `${asker?.name ?? 'Un membre de la famille'} a posé cette question sur « ${story.title} ». Elle est restée sans réponse.`,
        storyId: story.id,
        ruleId: 'UNANSWERED_QUESTION',
        confidence: 0.95,
      };
    },
  },
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
      return {
        text: `« ${story.title} » raconte un fait sans en donner la raison. Quelqu'un connaît-il le reste ?`,
        justification: `Cette histoire contient une tension non résolue : « ${story.title} ».`,
        storyId: story.id,
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
      const missing = context.members.find(
        (member) => !linkedMemberIds.has(member.id) && member.id !== story.authorId && !member.deathDate,
      );
      if (!missing) return null;

      return {
        text: `${missing.name} n'a pas encore raconté cette histoire de son point de vue.`,
        justification: `Un membre de la famille lié à cette histoire n'a pas encore partagé son point de vue.`,
        storyId: story.id,
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
      return {
        text: `« ${story.title} » fait partie des récits les moins relus de la famille.`,
        justification: story.lastViewedAt
          ? `Dernière lecture enregistrée : ${story.lastViewedAt.toISOString().split('T')[0]}.`
          : `Aucune lecture enregistrée depuis la création de ce récit.`,
        storyId: story.id,
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
  ) {}

  async generateQuestion(
    familyId: string,
    memberId: string,
    now = new Date(),
  ): Promise<PasseurQuestion | null> {
    // Parcimonie : une question par session.
    if (await this.store.get(sessionKey(familyId, memberId))) return null;

    const [members, muted] = await Promise.all([
      this.prisma.member.findMany({ where: { familyId, isDeleted: false } }),
      // Ce que CE membre a fait taire — pas ce que la famille a fait taire.
      this.conservateur.mutedStoryIds(familyId, memberId),
    ]);
    const context: PasseurContext = { members, memberId, now };

    // Une requête bornée par règle, en parallèle — jamais un scan du corpus.
    const perRule = await Promise.all(
      PASSEUR_RULES.map(async (rule) => ({
        rule,
        stories: (await this.prisma.story.findMany({
          where: {
            familyId,
            archived: false,
            ...(muted.length > 0 ? { id: { notIn: muted } } : {}),
            ...rule.where(context),
          },
          include: {
            linkedEntities: true,
            // Bornées elles aussi : une question en attente suffit à décrire le vide.
            conversations: { where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 3 },
          },
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
      if (await this.wasAskedRecently(familyId, memberId, candidate.storyId, candidate.ruleId)) continue;
      // Le Conservateur retire les sur-exposées des suggestions.
      if (await this.conservateur.isOverexposed(candidate.storyId)) continue;

      const selected = await this.enrichSelected(candidate, perRule);

      await this.store.setex(sessionKey(familyId, memberId), SESSION_TTL_SECONDS, selected.ruleId);
      await this.store.setex(
        askedKey(familyId, memberId, selected.storyId, selected.ruleId),
        RECENT_QUESTION_TTL_SECONDS,
        'true',
      );

      return selected;
    }

    return null;
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
  async markIgnored(familyId: string, memberId: string, storyId: string, ruleId: string): Promise<void> {
    await this.store.setex(askedKey(familyId, memberId, storyId, ruleId), RECENT_QUESTION_TTL_SECONDS, 'true');
  }

  private async wasAskedRecently(familyId: string, memberId: string, storyId: string, ruleId: string) {
    return (await this.store.get(askedKey(familyId, memberId, storyId, ruleId))) === 'true';
  }
}

function score(question: PasseurQuestion): number {
  const rule = PASSEUR_RULES.find((r) => r.id === question.ruleId);
  return question.confidence * (rule?.weight ?? 0);
}

function sessionKey(familyId: string, memberId: string) {
  return `passeur:${familyId}:${memberId}`;
}

function askedKey(familyId: string, memberId: string, storyId: string, ruleId: string) {
  return `passeur:asked:${familyId}:${memberId}:${storyId}:${ruleId}`;
}

export const passeur = new PasseurService();
