import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PasseurService, PASSEUR_RULES } from '@/services/passeur.service';
import { ConservateurService } from '@/services/conservateur.service';
import { LLMOperatorService } from '@/services/llm-operator.service';
import { createMemoryStore, type KeyValueStore } from '@/lib/redis';
import { constitutionEmotionFilter } from '@/lib/constitution';

const FAMILY = 'fam_1';
const MEMBER = 'mem_1';
const NOW = new Date(2026, 6, 28);

const TENSION_STORY = {
  id: 's_tension',
  familyId: FAMILY,
  authorId: 'mem_2',
  title: 'Les vélos de la rue des Peupliers',
  content:
    'Il réparait les vélos de tout le quartier. On lui a proposé un vélo neuf trois fois. Il refusait. Il n’a jamais voulu expliquer pourquoi.',
  createdAt: new Date(2026, 4, 14),
  lastViewedAt: new Date(2026, 5, 3),
  views: 12,
  archived: false,
  quarantined: false,
  linkedEntities: [{ id: 'e1', type: 'PERSON', memberId: 'mem_2' }],
  conversations: [],
};

const CALM_STORY = {
  ...TENSION_STORY,
  id: 's_calme',
  title: 'La tarte aux poires',
  content: 'Le poirier donne trop de fruits à la mi-octobre. On fait la tarte le 15.',
  createdAt: new Date(2026, 6, 1),
  lastViewedAt: new Date(2026, 6, 20),
  linkedEntities: [],
};

/**
 * Les règles décrivent désormais ce qu'elles cherchent en SQL. Un faux
 * `findMany` qui ignorerait le `where` rendrait ces tests complaisants :
 * il applique donc réellement les clauses que les règles produisent.
 */
function matchesWhere(story: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') {
      return (condition as Array<Record<string, unknown>>).some((clause) => matchesWhere(story, clause));
    }
    if (field === 'linkedEntities' || field === 'conversations') {
      const some = (condition as { some: Record<string, unknown> }).some;
      const children = (story[field] ?? []) as Array<Record<string, unknown>>;
      return children.some((child) => matchesWhere(child, some));
    }
    const value = story[field];
    if (condition !== null && typeof condition === 'object') {
      const { lt } = condition as { lt?: Date | number };
      if (lt !== undefined) {
        if (value === null || value === undefined) return false;
        return Number(value) < Number(lt);
      }
      return true;
    }
    return value === condition;
  });
}

function buildService(
  stories: Array<Record<string, unknown>>,
  store: KeyValueStore = createMemoryStore(),
  llm = new LLMOperatorService(undefined),
) {
  const prisma = {
    story: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        stories.filter((story) => matchesWhere(story, where)).slice(0, take ?? undefined),
    },
    member: {
      findMany: async () => [
        { id: 'mem_1', name: 'Emma', deathDate: null },
        { id: 'mem_2', name: 'Claire', deathDate: null },
        { id: 'mem_3', name: 'Philippe', deathDate: null },
      ],
    },
    visibilityLog: { groupBy: async () => [] },
    // Rien n'est mis en sourdine par ce membre dans ces scénarios.
    storyMute: { findMany: async () => [] },
  } as unknown as PrismaClient;

  return new PasseurService(prisma, store, llm, new ConservateurService(prisma, store));
}

describe('PasseurService — parcimonie', () => {
  it('ne pose qu’une seule question par session', async () => {
    const store = createMemoryStore();
    const service = buildService([TENSION_STORY], store);

    expect(await service.generateQuestion(FAMILY, MEMBER, NOW)).not.toBeNull();
    expect(await service.generateQuestion(FAMILY, MEMBER, NOW)).toBeNull();
  });

  it('ne renvoie rien plutôt qu’une question faible quand aucune règle ne s’applique', async () => {
    const service = buildService([CALM_STORY]);
    expect(await service.generateQuestion(FAMILY, MEMBER, NOW)).toBeNull();
  });

  it('épuise les angles un par un, puis se tait', async () => {
    const store = createMemoryStore();
    const seen = new Set<string>();

    for (let i = 0; i < PASSEUR_RULES.length + 1; i += 1) {
      await store.del(`passeur:${FAMILY}:${MEMBER}`);
      const question = await buildService([TENSION_STORY], store).generateQuestion(FAMILY, MEMBER, NOW);
      if (!question) break;
      // Jamais deux fois la même paire (récit, règle) pour ce membre.
      expect(seen.has(question.ruleId)).toBe(false);
      seen.add(question.ruleId);
    }

    await store.del(`passeur:${FAMILY}:${MEMBER}`);
    expect(await buildService([TENSION_STORY], store).generateQuestion(FAMILY, MEMBER, NOW)).toBeNull();
  });
});

describe('PasseurService — sélection', () => {
  it('choisit la règle au produit confiance × poids le plus élevé', async () => {
    const service = buildService([TENSION_STORY]);
    const question = await service.generateQuestion(FAMILY, MEMBER, NOW);
    // TENSION_UNRESOLVED (0.8 × 1.0) devance MISSING_VIEWPOINT (0.7 × 0.9).
    expect(question?.ruleId).toBe('TENSION_UNRESOLVED');
  });

  it('écarte une histoire sur-exposée', async () => {
    const store = createMemoryStore();
    await store.setex(`conservateur:overexposed:${TENSION_STORY.id}`, 3600, 'true');
    const service = buildService([TENSION_STORY], store);
    expect(await service.generateQuestion(FAMILY, MEMBER, NOW)).toBeNull();
  });

  it('accompagne chaque question d’une justification en une phrase', async () => {
    const service = buildService([TENSION_STORY]);
    const question = await service.generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.justification).toBeTruthy();
    expect(question!.justification.length).toBeLessThan(200);
  });

  it('n’examine qu’un lot borné de récits par règle', async () => {
    const corpus = Array.from({ length: 500 }, (_, i) => ({
      ...TENSION_STORY,
      id: `s_${i}`,
      title: `Récit ${i}`,
    }));
    const service = buildService(corpus);
    const question = await service.generateQuestion(FAMILY, MEMBER, NOW);
    expect(question).not.toBeNull();
    // Le plafond des règles, pas la taille du corpus.
    const maxExamined = PASSEUR_RULES.reduce((sum, rule) => sum + rule.take, 0);
    expect(maxExamined).toBeLessThan(corpus.length);
  });
});

describe('PasseurService — question restée sans réponse', () => {
  const asked = {
    ...TENSION_STORY,
    id: 's_question',
    conversations: [
      {
        id: 'c1',
        status: 'pending',
        questionerId: 'mem_2',
        questionText: 'Est-ce que quelqu’un sait d’où venait ce vélo de 1953 ?',
      },
    ],
  };

  it('passe avant toute règle déduite d’un texte', async () => {
    const question = await buildService([asked]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.ruleId).toBe('UNANSWERED_QUESTION');
    expect(question?.text).toContain('d’où venait ce vélo');
  });

  it('nomme qui a posé la question, dans la justification', async () => {
    const question = await buildService([asked]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.justification).toContain('Claire');
  });

  it('ne renvoie pas à un membre sa propre question', async () => {
    // mem_2 a posé la question : on ne la lui repose pas.
    const question = await buildService([asked]).generateQuestion(FAMILY, 'mem_2', NOW);
    expect(question?.ruleId).not.toBe('UNANSWERED_QUESTION');
  });

  it('ne se déclenche plus une fois la question répondue', async () => {
    const answered = { ...asked, conversations: [{ ...asked.conversations[0]!, status: 'answered' }] };
    const question = await buildService([answered]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.ruleId).not.toBe('UNANSWERED_QUESTION');
  });
});

describe('PasseurService — coût du LLM', () => {
  it('n’appelle le modèle que pour la question retenue, jamais pour les candidats', async () => {
    const corpus = Array.from({ length: 30 }, (_, i) => ({
      ...TENSION_STORY,
      id: `s_${i}`,
      title: `Récit ${i}`,
    }));

    const llm = new LLMOperatorService('clef-de-test');
    const phrase = vi.spyOn(llm, 'phraseQuestion').mockResolvedValue('Qui a offert ce vélo ?');

    const question = await buildService(corpus, createMemoryStore(), llm).generateQuestion(
      FAMILY,
      MEMBER,
      NOW,
    );

    expect(question?.text).toBe('Qui a offert ce vélo ?');
    expect(phrase).toHaveBeenCalledTimes(1);
  });

  it('garde la formulation déterministe si le modèle infère une émotion', async () => {
    const llm = new LLMOperatorService('clef-de-test');
    vi.spyOn(llm, 'phraseQuestion').mockResolvedValue('Vous semblez triste en repensant à ce vélo ?');

    const question = await buildService([TENSION_STORY], createMemoryStore(), llm).generateQuestion(
      FAMILY,
      MEMBER,
      NOW,
    );

    expect(question?.text).toContain('sans en donner la raison');
  });

  it('sans clé API, ne tente aucun appel', async () => {
    const llm = new LLMOperatorService(undefined);
    const phrase = vi.spyOn(llm, 'phraseQuestion');

    await buildService([TENSION_STORY], createMemoryStore(), llm).generateQuestion(FAMILY, MEMBER, NOW);
    expect(phrase).not.toHaveBeenCalled();
  });
});

describe('PasseurService — Constitution', () => {
  it('aucune formulation produite par les règles n’infère d’émotion', async () => {
    const context = {
      members: [
        { id: 'mem_1', name: 'Emma', deathDate: null },
        { id: 'mem_3', name: 'Philippe', deathDate: null },
      ],
      memberId: 'mem_1',
      now: NOW,
    };

    for (const rule of PASSEUR_RULES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = rule.draft(TENSION_STORY as any, context as any);
      if (question) expect(constitutionEmotionFilter(question.text)).toBe(true);
    }
  });

  it('la règle TENSION ne se déclenche pas sur des mots-outils banals', () => {
    // Un test naïf sur « ne », « pas », « mais » ferait de chaque récit une tension.
    const rule = PASSEUR_RULES.find((r) => r.id === 'TENSION_UNRESOLVED')!;
    const banal = {
      ...CALM_STORY,
      content: 'On ne met pas de sucre, mais un peu de crème. Toujours des poires du jardin.',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(rule.match(banal as any, {} as any)).toBe(false);
  });
});
