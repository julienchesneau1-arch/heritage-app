/**
 * Paquet de contexte — borné, filtré, et honnête sur ce qu'il écarte.
 *
 * Porte de sortie Phase 1 : « Le contexte envoyé au modèle est borné et
 * mesuré ; jamais un vidage de base. »
 */
import { describe, expect, it } from 'vitest';
import {
  buildContextPacket,
  DEFAULT_BUDGET,
  type ConversationTurn,
} from '../../src/core/context/packet.js';
import type { StoredMemory } from '../../src/core/memory/types.js';
import type { MemoryKind, PrivacyClass } from '../../src/core/types/domain.js';

function memory(
  overrides: Partial<StoredMemory> & { id: string },
): StoredMemory {
  return {
    kind: 'FACT' as MemoryKind,
    memoryType: 'SEMANTIC',
    content: 'contenu de test',
    confidence: 0.9,
    source: 'test',
    sourceType: 'USER_EXPLICIT',
    dataCategory: 'PERSONAL_MEMORY',
    provenance: 'USER',
    privacyClass: 'ORANGE' as PrivacyClass,
    state: 'ACTIVE',
    subjectEntityId: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastVerifiedAt: null,
    expiresAt: null,
    hasEmbedding: true,
    ...overrides,
  };
}

const noTurns: readonly ConversationTurn[] = [];

describe('filtrage de confidentialité', () => {
  it('écarte les mémoires RED pour une destination ORANGE', () => {
    const result = buildContextPacket({
      query: 'test',
      memories: [
        memory({ id: 'a', privacyClass: 'RED', content: 'IBAN FR76 1234' }),
        memory({ id: 'b', privacyClass: 'GREEN', content: 'la météo est belle' }),
      ],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'ORANGE',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memories.map((m) => m.id)).toEqual(['b']);
    expect(result.value.omitted.byPrivacy).toBe(1);
    expect(JSON.stringify(result.value)).not.toContain('FR76');
  });

  it('autorise RED vers une destination locale', () => {
    const result = buildContextPacket({
      query: 'test',
      memories: [memory({ id: 'a', privacyClass: 'RED' })],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'RED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memories.length).toBe(1);
  });

  it('le filtrage précède le budget, pas l\'inverse', () => {
    // Une mémoire RED ne doit pas simplement se retrouver en fin de liste :
    // elle doit être absente, même quand il reste de la place.
    const result = buildContextPacket({
      query: 'test',
      memories: [memory({ id: 'red', privacyClass: 'RED', confidence: 1 })],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'GREEN',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memories).toEqual([]);
  });
});

describe('budget', () => {
  it('n\'excède jamais le budget en caractères', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      memory({ id: `m${String(i)}`, content: 'x'.repeat(200) }),
    );

    const result = buildContextPacket({
      query: 'test',
      memories: many,
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'RED',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.characters).toBeLessThanOrEqual(DEFAULT_BUDGET.maxCharacters);
    expect(result.value.memories.length).toBeLessThanOrEqual(DEFAULT_BUDGET.maxMemories);
  });

  it('déclare ce qu\'il a écarté au lieu de tronquer en silence', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      memory({ id: `m${String(i)}`, content: 'y'.repeat(300) }),
    );

    const result = buildContextPacket({
      query: 'test',
      memories: many,
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'RED',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.omitted.byBudget).toBeGreaterThan(0);
    expect(result.value.omitted.reasons.length).toBeGreaterThan(0);
    expect(result.value.omitted.reasons.join(' ')).toContain('budget');
  });

  it('borne le nombre de tours de conversation', () => {
    const turns: ConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
      speaker: i % 2 === 0 ? 'USER' : 'JARVIS',
      content: `tour ${String(i)}`,
      turnIndex: i,
    }));

    const result = buildContextPacket({
      query: 'test',
      memories: [],
      entities: [],
      turns,
      maxPrivacyClass: 'RED',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns.length).toBe(DEFAULT_BUDGET.maxTurns);
    // On garde les plus RÉCENTS, pas les premiers.
    expect(result.value.turns[result.value.turns.length - 1]?.turnIndex).toBe(29);
  });
});

describe('priorité par crédit', () => {
  it('un fait confirmé passe devant une affirmation externe', () => {
    const result = buildContextPacket({
      query: 'test',
      memories: [
        memory({
          id: 'externe',
          kind: 'EXTERNAL_CLAIM',
          confidence: 0.4,
          content: 'Julien aime les réunions tardives',
        }),
        memory({
          id: 'fait',
          kind: 'FACT',
          confidence: 0.9,
          content: 'Julien préfère le matin',
        }),
      ],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'RED',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memories[0]?.id).toBe('fait');
  });

  it('une affirmation externe très confiante ne dépasse pas une inférence solide', () => {
    // Le plafond de crédit du Guard borne déjà la confiance à 0,4 ; la
    // pondération du paquet est la seconde barrière.
    const result = buildContextPacket({
      query: 'test',
      memories: [
        memory({ id: 'externe', kind: 'EXTERNAL_CLAIM', confidence: 0.4 }),
        memory({ id: 'inference', kind: 'INFERENCE', confidence: 0.8 }),
      ],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'RED',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memories[0]?.id).toBe('inference');
  });
});

describe('paquet vide', () => {
  it('reste valide quand il n\'y a rien à dire', () => {
    const result = buildContextPacket({
      query: 'bonjour',
      memories: [],
      entities: [],
      turns: noTurns,
      maxPrivacyClass: 'GREEN',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memories).toEqual([]);
    expect(result.value.omitted.byPrivacy).toBe(0);
    expect(result.value.omitted.byBudget).toBe(0);
  });
});
