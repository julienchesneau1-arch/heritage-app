import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TriggerModelService } from '@/services/trigger-model.service';
import { createMemoryStore } from '@/lib/redis';

const FAMILY = 'fam_1';
const MEMBER = 'mem_1';
const TODAY = new Date(2026, 9, 15, 12, 0, 0); // 15 octobre 2026

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    tradition: { findFirst: async () => null },
    member: { findMany: async () => [] },
    story: { findMany: async () => [] },
    family: { findUnique: async () => ({ id: FAMILY, name: 'Martin' }) },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('TriggerModelService — parcimonie', () => {
  it('ne renvoie jamais plus d’un signal, même quand tout tombe le même jour', async () => {
    const service = new TriggerModelService(
      fakePrisma({
        tradition: { findFirst: async () => ({ id: 'trad_1', name: 'La tarte aux poires' }) },
        member: {
          findMany: async () => [
            { id: 'm1', name: 'Jeanne', birthDate: new Date(1934, 9, 15), deathDate: null },
            { id: 'm2', name: 'Robert', birthDate: null, deathDate: new Date(2014, 9, 15) },
          ],
        },
        story: {
          findMany: async () => [
            { id: 's1', title: 'La tarte', createdAt: new Date(2022, 9, 15) },
          ],
        },
      }),
      createMemoryStore(),
    );

    const signals = await service.generateSignals(FAMILY, MEMBER, TODAY);
    expect(signals).toHaveLength(1);
  });

  it('donne la priorité à la date de décès (5) sur l’anniversaire de naissance (4)', async () => {
    const service = new TriggerModelService(
      fakePrisma({
        member: {
          findMany: async () => [
            { id: 'm1', name: 'Jeanne', birthDate: new Date(1934, 9, 15), deathDate: null },
            { id: 'm2', name: 'Robert', birthDate: null, deathDate: new Date(2014, 9, 15) },
          ],
        },
      }),
      createMemoryStore(),
    );

    const signal = await service.generateSignal(FAMILY, MEMBER, TODAY);
    expect(signal?.type).toBe('ANNIVERSARY');
    expect(signal?.payload.message).toContain('Robert');
    expect(signal?.payload.message).toContain('nous quittait');
  });

  it('tombe sur le signal passif quand rien ne se passe', async () => {
    const service = new TriggerModelService(fakePrisma(), createMemoryStore());
    const signal = await service.generateSignal(FAMILY, MEMBER, TODAY);
    expect(signal?.type).toBe('PASSIVE');
    expect(signal?.priority).toBe(1);
  });

  it('accompagne toujours le message d’une justification', async () => {
    const service = new TriggerModelService(
      fakePrisma({
        tradition: { findFirst: async () => ({ id: 'trad_1', name: 'La tarte aux poires' }) },
      }),
      createMemoryStore(),
    );
    const signal = await service.generateSignal(FAMILY, MEMBER, TODAY);
    expect(signal?.payload.justification.length).toBeGreaterThan(0);
  });
});

describe('TriggerModelService — droit au silence', () => {
  it('tait un type de signal après trois fermetures, pour 30 jours', async () => {
    const store = createMemoryStore();
    const service = new TriggerModelService(
      fakePrisma({
        tradition: { findFirst: async () => ({ id: 'trad_1', name: 'La tarte aux poires' }) },
      }),
      store,
    );

    expect(await service.generateSignal(FAMILY, MEMBER, TODAY)).not.toBeNull();

    for (let i = 0; i < 3; i += 1) {
      await service.dismissSignalType(FAMILY, MEMBER, 'TRADITION');
    }

    const after = await service.generateSignal(FAMILY, MEMBER, TODAY);
    // Le signal TRADITION est muet ; il ne reste que le passif (priorité 1).
    expect(after?.type).toBe('PASSIVE');
  });

  it('ne tait pas un type après une seule fermeture', async () => {
    const store = createMemoryStore();
    const service = new TriggerModelService(
      fakePrisma({
        tradition: { findFirst: async () => ({ id: 'trad_1', name: 'La tarte aux poires' }) },
      }),
      store,
    );

    await service.dismissSignalType(FAMILY, MEMBER, 'TRADITION');
    const signal = await service.generateSignal(FAMILY, MEMBER, TODAY);
    expect(signal?.type).toBe('TRADITION');
  });
});
