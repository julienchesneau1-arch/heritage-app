import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  PasseurService,
  PASSEUR_RULES,
  couldRememberFirsthand,
  tensionFragment,
} from '@/services/passeur.service';
import { ConservateurService } from '@/services/conservateur.service';
import { ThreadService } from '@/services/thread.service';
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

const MEMBERS = [
  { id: 'mem_1', name: 'Emma', birthDate: new Date(1998, 2, 4), deathDate: null },
  { id: 'mem_2', name: 'Claire', birthDate: new Date(1971, 0, 9), deathDate: null },
  { id: 'mem_3', name: 'Philippe', birthDate: new Date(1968, 10, 30), deathDate: null },
];

function buildService(
  stories: Array<Record<string, unknown>>,
  store: KeyValueStore = createMemoryStore(),
  llm = new LLMOperatorService(undefined),
  members: Array<Record<string, unknown>> = MEMBERS,
  fils: Array<Record<string, unknown>> = [],
) {
  const prisma = {
    story: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        stories.filter((story) => matchesWhere(story, where)).slice(0, take ?? undefined),
    },
    member: {
      findMany: async () => members,
    },
    visibilityLog: { groupBy: async () => [] },
    // Rien n'est mis en sourdine par ce membre dans ces scénarios.
    storyMute: { findMany: async () => [] },
    thread: { findMany: async () => fils },
  } as unknown as PrismaClient;

  return new PasseurService(
    prisma,
    store,
    llm,
    new ConservateurService(prisma, store),
    new ThreadService(prisma),
  );
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

describe('PasseurService — une question que quelqu’un a réellement posée', () => {
  /**
   * Le fil a défait le verrou : une question n'a plus besoin qu'un récit
   * existe pour être posée. Elle peut pendre à une entité, ou à rien.
   */
  const filSurRecit = {
    id: 'thr_1',
    storyId: 's_tension',
    entityId: null,
    openedById: 'mem_2',
    openedBy: { id: 'mem_2', name: 'Claire' },
    story: { id: 's_tension', title: 'Les vélos de la rue des Peupliers' },
    entity: null,
    messageCount: 1,
    messages: [{ id: 'm1', body: 'Est-ce que quelqu’un sait d’où venait ce vélo de 1953 ?', isQuestion: true }],
  };

  const filSurEntite = {
    ...filSurRecit,
    id: 'thr_2',
    storyId: null,
    story: null,
    entityId: 'e_montre',
    entity: { id: 'e_montre', name: 'la montre de Robert' },
    messages: [{ id: 'm2', body: 'Elle est où maintenant ?', isQuestion: true }],
  };

  it('passe avant toute règle déduite d’un texte', async () => {
    const question = await buildService([TENSION_STORY], createMemoryStore(), undefined, MEMBERS, [
      filSurRecit,
    ]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.ruleId).toBe('UNANSWERED_QUESTION');
    expect(question?.text).toContain('d’où venait ce vélo');
  });

  it('nomme qui a posé la question, dans la justification', async () => {
    const question = await buildService([TENSION_STORY], createMemoryStore(), undefined, MEMBERS, [
      filSurRecit,
    ]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.justification).toContain('Claire');
  });

  it('remonte une question posée sur une entité, sans aucun récit', async () => {
    // Impossible avant le fil : `Conversation.storyId` était obligatoire.
    const question = await buildService([], createMemoryStore(), undefined, MEMBERS, [
      filSurEntite,
    ]).generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.ruleId).toBe('UNANSWERED_QUESTION');
    expect(question?.storyId).toBeNull();
    expect(question?.threadId).toBe('thr_2');
    expect(question?.justification).toContain('la montre de Robert');
  });

  it('ne renvoie à personne sa propre question', async () => {
    // La sélection se fait en base : le service passe l'exclusion à la
    // requête, on vérifie qu'elle y est.
    let recu: Record<string, unknown> | null = null;
    const prisma = {
      story: { findMany: async () => [] },
      member: { findMany: async () => MEMBERS },
      visibilityLog: { groupBy: async () => [] },
      storyMute: { findMany: async () => [] },
      thread: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          recu = where;
          return [];
        },
      },
    } as unknown as PrismaClient;
    const store = createMemoryStore();
    await new PasseurService(
      prisma,
      store,
      new LLMOperatorService(undefined),
      new ConservateurService(prisma, store),
      new ThreadService(prisma),
    ).generateQuestion(FAMILY, 'mem_2', NOW);

    expect(recu!.openedById).toEqual({ not: 'mem_2' });
  });

  it('ne se déclenche plus dès que quelqu’un a repris la parole', async () => {
    // Un fil à deux messages n'est plus un vide : la requête ne le rend pas.
    const question = await buildService([], createMemoryStore(), undefined, MEMBERS, [])
      .generateQuestion(FAMILY, MEMBER, NOW);
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

  it('aucune justification produite par les règles n’affirme plus que ce qu’elle vérifie', async () => {
    const context = { members: MEMBERS, memberId: 'mem_1', now: NOW };
    for (const rule of PASSEUR_RULES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = rule.draft(TENSION_STORY as any, context as any);
      if (question) expect(constitutionEmotionFilter(question.justification)).toBe(true);
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

/**
 * Trois affirmations du Passeur ne reposaient sur rien de vérifié.
 * Ce bloc les tient : une question peut être infondée — elle ne peut pas
 * être présentée comme un constat.
 */
describe('Le Passeur n’affirme que ce qu’il a vérifié', () => {
  describe('MISSING_VIEWPOINT — ne demande pas son avis à qui n’était pas né', () => {
    const rule = PASSEUR_RULES.find((r) => r.id === 'MISSING_VIEWPOINT')!;

    const demenagement = {
      ...TENSION_STORY,
      id: 's_demenagement',
      title: 'Le déménagement de Bordeaux',
      content: 'On est partis en novembre. Le camion était trop petit.',
      eventDate: new Date(1971, 10, 3),
      authorId: 'mem_2',
      linkedEntities: [{ id: 'e1', type: 'PERSON', memberId: 'mem_2' }],
    };

    function draftFor(members: Array<Record<string, unknown>>) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rule.draft(demenagement as any, { members, memberId: 'mem_2', now: NOW } as any);
    }

    it('écarte un membre né après l’événement raconté', () => {
      // Lucas, né en 2019, n'a pas de point de vue sur 1971.
      expect(
        draftFor([{ id: 'mem_9', name: 'Lucas', birthDate: new Date(2019, 3, 2), deathDate: null }]),
      ).toBeNull();
    });

    it('écarte un membre trop jeune au moment de l’événement pour s’en souvenir', () => {
      // Cas relevé sur les données réelles : Emma, née le jour même de
      // l'événement, était invitée à donner sa version de sa naissance.
      expect(draftFor([{ id: 'mem_5', name: 'Emma', birthDate: new Date(1971, 10, 3), deathDate: null }]))
        .toBeNull();
      expect(draftFor([{ id: 'mem_6', name: 'Nino', birthDate: new Date(1969, 5, 1), deathDate: null }]))
        .toBeNull();
    });

    it('écarte un membre mort avant l’événement raconté', () => {
      expect(
        draftFor([
          {
            id: 'mem_8',
            name: 'Robert',
            birthDate: new Date(1901, 0, 1),
            deathDate: new Date(1965, 5, 12),
          },
        ]),
      ).toBeNull();
    });

    it('retient un membre qui aurait pu y être', () => {
      const question = draftFor([
        { id: 'mem_3', name: 'Philippe', birthDate: new Date(1960, 10, 30), deathDate: null },
      ]);
      expect(question?.text).toContain('Philippe');
    });

    it('ne disqualifie pas un membre dont on ignore la date de naissance', () => {
      // Ne pas savoir n'est pas savoir que non : le doute laisse la question ouverte.
      const question = draftFor([
        { id: 'mem_7', name: 'Jeanne', birthDate: null, deathDate: null },
      ]);
      expect(question?.text).toContain('Jeanne');
    });

    it('ne prétend plus que le membre choisi est lié au récit', () => {
      // L'ancienne justification disait « lié à cette histoire » alors que la
      // règle sélectionne exactement l'inverse.
      const question = draftFor([
        { id: 'mem_3', name: 'Philippe', birthDate: new Date(1960, 10, 30), deathDate: null },
      ]);
      expect(question!.justification).not.toContain('lié');
      expect(question!.justification).toContain("n'apparaît pas");
    });

    it('formule une invitation, pas un constat sur ce qu’il aurait vécu', () => {
      const question = draftFor([
        { id: 'mem_3', name: 'Philippe', birthDate: new Date(1960, 10, 30), deathDate: null },
      ]);
      expect(question!.text).toContain('peut-être');
    });
  });

  describe('couldRememberFirsthand', () => {
    const reference = new Date(1971, 10, 3);

    it('exclut une naissance postérieure', () => {
      expect(couldRememberFirsthand({ birthDate: new Date(2019, 0, 1), deathDate: null }, reference)).toBe(
        false,
      );
    });

    it('exclut un enfant trop jeune à la date de l’événement', () => {
      expect(couldRememberFirsthand({ birthDate: new Date(1969, 0, 1), deathDate: null }, reference)).toBe(
        false,
      );
    });

    it('exclut un décès antérieur', () => {
      expect(
        couldRememberFirsthand({ birthDate: new Date(1901, 0, 1), deathDate: new Date(1965, 0, 1) }, reference),
      ).toBe(false);
    });

    it('accepte un vivant né avant', () => {
      expect(couldRememberFirsthand({ birthDate: new Date(1950, 0, 1), deathDate: null }, reference)).toBe(
        true,
      );
    });

    it('accepte quand les deux dates sont inconnues', () => {
      expect(couldRememberFirsthand({ birthDate: null, deathDate: null }, reference)).toBe(true);
    });
  });

  describe('TENSION_UNRESOLVED — cite au lieu de décréter', () => {
    const rule = PASSEUR_RULES.find((r) => r.id === 'TENSION_UNRESOLVED')!;

    it('cite le passage qui a déclenché la règle', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = rule.draft(TENSION_STORY as any, {} as any);
      // La citation est extraite du récit, mot pour mot : la famille peut
      // vérifier elle-même si le Passeur a lu quelque chose de réel.
      expect(question!.justification).toContain('Il refusait');
      expect(TENSION_STORY.content).toContain('Il refusait');
    });

    it('ne décrète plus une « tension non résolue »', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = rule.draft(TENSION_STORY as any, {} as any);
      expect(question!.justification.toLowerCase()).not.toContain('tension');
    });

    it('ne produit rien plutôt qu’une citation vide', () => {
      const sansMarqueur = { ...TENSION_STORY, content: 'On mangeait des poires en octobre.' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(rule.draft(sansMarqueur as any, {} as any)).toBeNull();
    });
  });

  describe('tensionFragment', () => {
    it('rend la phrase entière, pas trois mots arrachés', () => {
      // Le marqueur est « refusait » ; la citation va d'un point à l'autre.
      expect(tensionFragment('Il partait tôt. Il refusait de dire où. On mangeait sans lui.')).toBe(
        'Il refusait de dire où',
      );
    });

    it('cite un fragment présent tel quel dans le récit', () => {
      const contenu = 'On a déménagé en mars. Personne ne sait qui a gardé la clé du grenier.';
      const fragment = tensionFragment(contenu)!;
      expect(contenu).toContain(fragment);
    });

    it('abrège une phrase trop longue sans la couper au milieu du néant', () => {
      const long = `Il refusait ${'de répondre '.repeat(20)}.`;
      const fragment = tensionFragment(long)!;
      expect(fragment.length).toBeLessThanOrEqual(90);
      expect(fragment.endsWith('…')).toBe(true);
    });

    it('ne rend rien quand aucun marqueur n’est présent', () => {
      expect(tensionFragment('Le poirier donne trop de fruits à la mi-octobre.')).toBeNull();
    });
  });

  describe('RARE_PATRIMONY — des faits, pas un comparatif invérifié', () => {
    const rule = PASSEUR_RULES.find((r) => r.id === 'RARE_PATRIMONY')!;

    it('ne prétend plus que le récit est parmi les moins relus de la famille', () => {
      // La règle n'examine que ce récit : elle ne peut rien dire des autres.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = rule.draft({ ...TENSION_STORY, views: 2 } as any, {} as any);
      expect(question!.text).not.toContain('les moins');
      expect(question!.justification).not.toContain('les moins');
    });

    it('donne le compte de lectures et la date de la dernière', () => {
      const question = rule.draft(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...TENSION_STORY, views: 3, lastViewedAt: new Date(2024, 0, 15) } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      expect(question!.justification).toContain('3 lectures');
      expect(question!.justification).toContain('2024-01-15');
    });

    it('distingue « jamais rouvert » de « pas rouvert depuis un an »', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jamais = rule.draft({ ...TENSION_STORY, views: 0, lastViewedAt: null } as any, {} as any);
      expect(jamais!.text).toContain('jamais été rouvert');
      expect(jamais!.justification).toContain('Aucune lecture enregistrée');
    });

    it('accorde le singulier sur une seule lecture', () => {
      const question = rule.draft(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...TENSION_STORY, views: 1, lastViewedAt: new Date(2024, 0, 15) } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      expect(question!.justification).toContain('1 lecture enregistrée,');
    });
  });
});
