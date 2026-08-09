/**
 * Vocabulaire de la mémoire.
 *
 * Référence : 00 §14 (huit types de mémoire), 03 §11 (Memory Guard).
 *
 * Distinction fondamentale, à ne jamais confondre :
 *
 *   `memoryType` — DE QUOI il s'agit : un épisode, un fait, une préférence…
 *   `kind`       — QUEL CRÉDIT on lui accorde : fait confirmé, déduction,
 *                  hypothèse, ou affirmation externe non vérifiée.
 *
 * Un email affirmant « Julien aime les réunions tardives » a bien un contenu de
 * nature préférence, mais son crédit est celui d'une affirmation externe. Il ne
 * devient jamais une PREFERENCE (05/B8).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PrivacyClass, Provenance } from '../types/domain.js';
import type { MemoryKind } from '../types/domain.js';

export const MemoryType = z.enum([
  'EPISODIC', // M2 — ce qui s'est passé
  'SEMANTIC', // M3 — ce qui est vrai
  'PREFERENCE', // M4 — ce que l'utilisateur préfère
  'RULE', // M5 — instruction explicite
  'INTENT', // M6 — objectif poursuivi
  'DECISION', // M7 — décision prise
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemoryState = z.enum(['ACTIVE', 'DORMANT', 'ARCHIVED', 'DELETED']);
export type MemoryState = z.infer<typeof MemoryState>;

/**
 * Ce qu'un modèle (ou un outil) PROPOSE.
 *
 * Remarquez ce qui est absent : ni `kind`, ni `confidence` définitive, ni
 * `state`. Le proposant ne choisit pas le crédit qu'on accorde à sa
 * proposition — c'est précisément le rôle du Guard.
 */
export const MemoryProposal = z.object({
  memoryType: MemoryType,
  content: z.string().min(1).max(4000),
  /** D'où vient l'information. Détermine le `kind` retenu. */
  provenance: Provenance,
  /** Source concrète : « conversation », identifiant d'email, URL… */
  source: z.string().min(1),
  privacyClass: PrivacyClass.default('ORANGE'),
  subjectEntityId: z.uuid().nullable().default(null),
  /** Confiance suggérée. Le Guard peut la réduire, jamais l'augmenter. */
  suggestedConfidence: z.number().min(0).max(1).default(0.5),
  expiresAt: z.string().nullable().default(null),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

/** Une mémoire telle qu'elle est stockée puis relue. */
export interface StoredMemory {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly memoryType: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly provenance: Provenance;
  readonly privacyClass: PrivacyClass;
  readonly state: MemoryState;
  readonly subjectEntityId: string | null;
  readonly createdAt: string;
  readonly lastVerifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly hasEmbedding: boolean;
}

/**
 * Plafonds de confiance par crédit.
 *
 * Une affirmation externe ne peut pas être « presque certaine », quelle que
 * soit l'assurance avec laquelle elle est formulée. C'est la traduction
 * numérique de la défense contre l'empoisonnement de mémoire (T4).
 */
export const CONFIDENCE_CEILING: Readonly<Record<MemoryKind, number>> = {
  FACT: 1.0,
  INFERENCE: 0.8,
  HYPOTHESIS: 0.5,
  EXTERNAL_CLAIM: 0.4,
};

/**
 * Empreinte de déduplication.
 *
 * Normalisation volontairement agressive : casse, accents, ponctuation et
 * espaces multiples sont neutralisés. « Ajoute du café » et « ajoute du cafe ! »
 * ne doivent pas produire deux mémoires.
 */
export function contentDigest(memoryType: MemoryType, content: string): string {
  const normalized = content
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacritiques combinants
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${memoryType}\u001f${normalized}`).digest('hex');
}
