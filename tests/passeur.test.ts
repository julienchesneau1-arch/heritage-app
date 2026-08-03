import { describe, expect, it } from 'vitest';
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
  createdAt: new Date(2023, 4, 14),
  lastViewedAt: new Date(2026, 1, 3),
  views: 12,
  archived: false,
  quarantined: false,
  linkedEntities: [{ id: 'e1', type: 'PERSON', memberId: 'mem_2' }],
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

function buildService(stories: unknown[], store: KeyValueStore = createMemoryStore()) {
  const prisma = {
    story: { findMany: async () => stories },
    member: {
      findMany: async () => [
        { id: 'mem_1', name: 'Emma', deathDate: null },
        { id: 'mem_2', name: 'Claire', deathDate: null },
        { id: 'mem_3', name: 'Philippe', deathDate: null },
      ],
    },
    visibilityLog: { groupBy: async () => [] },
  } as unknown as PrismaClient;

  const conservateur = new ConservateurService(prisma, store);
  // Pas de clé API : le Passeur utilise ses formulations déterministes.
  const llm = new LLMOperatorService(undefined);

  return new PasseurService(prisma, store, llm, conservateur);
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

  it('ne repose pas la même question au même membre dans les deux semaines', async () => {
    const store = createMemoryStore();
    const first = buildService([TENSION_STORY], store);
    const question = await first.generateQuestion(FAMILY, MEMBER, NOW);
    expect(question?.ruleId).toBe('TENSION_UNRESOLVED');

    // Nouvelle session (le verrou horaire est levé), même histoire.
    // La règle déjà jouée est écartée : soit un autre angle, soit rien.
    await store.del(`passeur:${FAMILY}:${MEMBER}`);
    const second = buildService([TENSION_STORY], store);
    const next = await second.generateQuestion(FAMILY, MEMBER, NOW);
    expect(next?.ruleId).not.toBe('TENSION_UNRESOLVED');

    // Épuisement des angles : au bout du compte, le Passeur se tait.
    const seen = new Set<string>([question!.ruleId, next!.ruleId]);
    for (let i = 0; i < PASSEUR_RULES.length; i += 1) {
      await store.del(`passeur:${FAMILY}:${MEMBER}`);
      const more = await buildService([TENSION_STORY], store).generateQuestion(FAMILY, MEMBER, NOW);
      if (!more) break;
      expect(seen.has(more.ruleId)).toBe(false);
      seen.add(more.ruleId);
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
});

describe('PasseurService — Constitution', () => {
  it('aucune formulation produite par les règles n’infère d’émotion', async () => {
    const context = {
      members: [
        { id: 'mem_1', name: 'Emma', deathDate: null },
        { id: 'mem_3', name: 'Philippe', deathDate: null },
      ],
      llm: new LLMOperatorService(undefined),
      now: NOW,
    };

    for (const rule of PASSEUR_RULES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const question = await rule.generate(TENSION_STORY as any, context as any);
      if (question) expect(constitutionEmotionFilter(question.text)).toBe(true);
    }
  });

  it('la règle TENSION ne se déclenche pas sur des mots-outils banals', async () => {
    // Un test naïf sur « ne », « pas », « mais » ferait de chaque récit une tension.
    const rule = PASSEUR_RULES.find((r) => r.id === 'TENSION_UNRESOLVED')!;
    const banal = {
      ...CALM_STORY,
      content: 'On ne met pas de sucre, mais un peu de crème. Toujours des poires du jardin.',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await rule.test(banal as any, {} as any)).toBe(false);
  });
});
