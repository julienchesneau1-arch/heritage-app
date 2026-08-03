import type { Entity, Member, PrismaClient, Story } from '@prisma/client';
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
 */

export interface PasseurQuestion {
  text: string;
  justification: string;
  storyId: string;
  ruleId: string;
  confidence: number; // 0-1
}

export type StoryWithEntities = Story & { linkedEntities: Entity[] };

export interface PasseurContext {
  members: Member[];
  llm: LLMOperatorService;
  now: Date;
}

interface PasseurRule {
  id: string;
  weight: number;
  test(story: StoryWithEntities, context: PasseurContext): Promise<boolean>;
  generate(story: StoryWithEntities, context: PasseurContext): Promise<PasseurQuestion | null>;
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

export const PASSEUR_RULES: PasseurRule[] = [
  {
    id: 'TENSION_UNRESOLVED',
    weight: 1.0,
    async test(story) {
      return TENSION_MARKERS.some((marker) => marker.test(story.content));
    },
    async generate(story, context) {
      // Formulation déterministe : c'est elle qui fait foi si le LLM est
      // absent ou si sa sortie échoue à la vérification.
      const fallback = `« ${story.title} » raconte un fait sans en donner la raison. Quelqu'un connaît-il le reste ?`;
      const text = await context.llm.phraseQuestion(story.content, fallback);
      if (!constitutionEmotionFilter(text)) return null;
      return {
        text,
        justification: `Cette histoire contient une tension non résolue : « ${story.title} ».`,
        storyId: story.id,
        ruleId: 'TENSION_UNRESOLVED',
        confidence: 0.8,
      };
    },
  },
  {
    id: 'MISSING_VIEWPOINT',
    weight: 0.9,
    async test(story, context) {
      const linkedPeople = story.linkedEntities.filter((entity) => entity.type === 'PERSON');
      return linkedPeople.length > 0 && linkedPeople.length < context.members.length;
    },
    async generate(story, context) {
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
    async test(story, context) {
      const reference = story.lastViewedAt ?? story.createdAt;
      const daysSince = (context.now.getTime() - reference.getTime()) / 86_400_000;
      return daysSince > 365 && story.views < 5;
    },
    async generate(story) {
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
    async test(story, context) {
      return yearsSince(story.createdAt, context.now) >= 2;
    },
    async generate(story, context) {
      const years = yearsSince(story.createdAt, context.now);
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

    const [stories, members] = await Promise.all([
      this.prisma.story.findMany({
        where: { familyId, archived: false, quarantined: false },
        include: { linkedEntities: true },
      }),
      this.prisma.member.findMany({ where: { familyId, isDeleted: false } }),
    ]);

    const context: PasseurContext = { members, llm: this.llm, now };
    const candidates: PasseurQuestion[] = [];

    for (const story of stories) {
      // Le Conservateur retire les sur-exposées des suggestions.
      if (await this.conservateur.isOverexposed(story.id)) continue;

      for (const rule of PASSEUR_RULES) {
        if (!(await rule.test(story, context))) continue;
        if (await this.wasAskedRecently(familyId, memberId, story.id, rule.id)) continue;

        const question = await rule.generate(story, context);
        // Règle 3 : filtre constitutionnel, y compris sur les formulations internes.
        if (question && constitutionEmotionFilter(question.text)) candidates.push(question);
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => score(b) - score(a));
    const selected = candidates[0]!;

    await this.store.setex(sessionKey(familyId, memberId), SESSION_TTL_SECONDS, selected.ruleId);
    await this.store.setex(
      askedKey(familyId, memberId, selected.storyId, selected.ruleId),
      RECENT_QUESTION_TTL_SECONDS,
      'true',
    );

    return selected;
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

function yearsSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / (86_400_000 * 365.25));
}

function sessionKey(familyId: string, memberId: string) {
  return `passeur:${familyId}:${memberId}`;
}

function askedKey(familyId: string, memberId: string, storyId: string, ruleId: string) {
  return `passeur:asked:${familyId}:${memberId}:${storyId}:${ruleId}`;
}

export const passeur = new PasseurService();
