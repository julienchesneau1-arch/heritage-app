import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { StoryService } from '@/services/story.service';
import { LLMOperatorService } from '@/services/llm-operator.service';
import { normalizeName } from '@/lib/normalize';

const FAMILY = 'fam_1';

const MEMBERS = [
  { id: 'm_robert', name: 'Robert Martin' },
  { id: 'm_claire', name: 'Claire Martin' },
  { id: 'm_jean', name: 'Jean Dupont' },
  { id: 'm_jeanne', name: 'Jeanne Martin' },
];

function buildService(llm = new LLMOperatorService(undefined)) {
  const created: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];

  const prisma = {
    member: { findMany: async () => MEMBERS },
    entity: {
      upsert: async (args: { where: unknown; create: Record<string, unknown> }) => {
        upserts.push(args.create);
        return { id: `e_${upserts.length}`, ...args.create };
      },
    },
    story: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 's_1', ...args.data };
      },
    },
  } as unknown as PrismaClient;

  return { service: new StoryService(prisma, llm), created, upserts };
}

const INPUT = {
  authorId: 'm_claire',
  title: 'La montre arrêtée',
  content: 'Robert portait une Omega de 1962. Il l’a arrêtée en juin 1994.',
  tone: 'factuel' as const,
};

describe('Rattachement des entités aux membres', () => {
  it('relie « Robert » au membre « Robert Martin »', async () => {
    const { service, upserts } = buildService();
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'Robert', type: 'PERSON' }],
    });
    expect(upserts[0]).toMatchObject({ normalizedName: 'robert', memberId: 'm_robert' });
  });

  it('ne relie rien quand le prénom est ambigu', async () => {
    // « Martin » est le nom de trois membres : mieux vaut aucun lien qu'un faux.
    const { service, upserts } = buildService();
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'Martin', type: 'PERSON' }],
    });
    expect(upserts[0]).toMatchObject({ memberId: null });
  });

  it('ne relie pas un homonyme partiel qui n’est pas un mot entier', async () => {
    const { service, upserts } = buildService();
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'Rob', type: 'PERSON' }],
    });
    expect(upserts[0]).toMatchObject({ memberId: null });
  });

  it('normalise le nom stocké (§2.1 règle 4)', async () => {
    const { service, upserts } = buildService();
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'L’Atelier de Robert-Émile', type: 'PLACE' }],
    });
    expect(upserts[0]!.normalizedName).toBe(normalizeName('L’Atelier de Robert-Émile'));
  });

  it('ignore un type d’entité hors grammaire', async () => {
    const { service, upserts } = buildService();
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'Quelque chose', type: 'SENTIMENT' as never }],
    });
    expect(upserts).toHaveLength(0);
  });
});

describe('Extraction automatique — le LLM ne comble que le silence', () => {
  it('n’extrait rien quand la famille a déjà nommé ses entités', async () => {
    const llm = new LLMOperatorService('clef-de-test');
    const extract = vi.spyOn(llm, 'extractEntities').mockResolvedValue([]);
    vi.spyOn(llm, 'classifyStructure').mockResolvedValue('objet-emotionnel');

    const { service } = buildService(llm);
    await service.createStory(FAMILY, {
      ...INPUT,
      entityNames: [{ name: 'Robert', type: 'PERSON' }],
    });

    expect(extract).not.toHaveBeenCalled();
  });

  it('extrait quand aucune entité n’a été saisie', async () => {
    const llm = new LLMOperatorService('clef-de-test');
    const extract = vi
      .spyOn(llm, 'extractEntities')
      .mockResolvedValue([{ name: 'Robert', type: 'PERSON' }]);
    vi.spyOn(llm, 'classifyStructure').mockResolvedValue('objet-emotionnel');

    const { service, upserts } = buildService(llm);
    await service.createStory(FAMILY, INPUT);

    expect(extract).toHaveBeenCalledOnce();
    expect(upserts[0]).toMatchObject({ memberId: 'm_robert' });
  });

  it('sans clé API, ne tente ni classification ni extraction', async () => {
    const llm = new LLMOperatorService(undefined);
    const extract = vi.spyOn(llm, 'extractEntities');
    const classify = vi.spyOn(llm, 'classifyStructure');

    const { service, created } = buildService(llm);
    await service.createStory(FAMILY, INPUT);

    expect(extract).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ structureType: 'evenement-marquant' });
  });
});

describe('Longueur du récit', () => {
  it('est déduite du texte, pas déclarée', async () => {
    const { service, created } = buildService();
    await service.createStory(FAMILY, { ...INPUT, content: 'a'.repeat(2000) });
    expect(created[0]).toMatchObject({ length: 'long' });
  });
});
