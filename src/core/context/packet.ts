/**
 * Paquet de contexte.
 *
 * Référence : 00 §20 (Context Window Manager), 02 Phase 1, PRD §12.
 *
 *   > « Ne jamais injecter toute la mémoire dans le prompt. »
 *   > « Le contexte fourni au modèle doit être minimal mais suffisant. »
 *
 * Ce module applique un BUDGET DUR. Ce qui n'entre pas dans le budget est
 * écarté, et le paquet dit ce qu'il a écarté — plutôt que de tronquer en
 * silence, ce qui produirait des réponses incomplètes sans que personne ne
 * sache pourquoi.
 *
 * Le filtrage de confidentialité intervient AVANT le budget : une mémoire RED
 * destinée à un modèle cloud est retirée, pas reléguée en fin de liste.
 */
import type { PrivacyClass } from '../types/domain.js';
import { ok, type Result } from '../types/result.js';
import type { StoredMemory } from '../memory/types.js';
import type { EntityRef } from './resolver.js';

export interface ContextBudget {
  /** Budget en caractères. Approximation volontairement simple et vérifiable. */
  readonly maxCharacters: number;
  readonly maxMemories: number;
  readonly maxTurns: number;
}

export const DEFAULT_BUDGET: ContextBudget = {
  maxCharacters: 6000,
  maxMemories: 12,
  maxTurns: 6,
};

export interface ConversationTurn {
  readonly speaker: 'USER' | 'JARVIS';
  readonly content: string;
  readonly turnIndex: number;
}

export interface PacketInput {
  readonly query: string;
  readonly memories: readonly StoredMemory[];
  readonly entities: readonly EntityRef[];
  readonly turns: readonly ConversationTurn[];
  /**
   * Classe maximale autorisée pour la destination.
   *
   * Un modèle local peut voir RED ; un modèle cloud ne le peut jamais
   * (03 §6). C'est le paramètre qui rend le filtrage explicite plutôt
   * qu'implicite.
   */
  readonly maxPrivacyClass: PrivacyClass;
  readonly budget?: ContextBudget;
}

export interface ContextPacket {
  readonly query: string;
  readonly entities: readonly EntityRef[];
  readonly memories: readonly StoredMemory[];
  readonly turns: readonly ConversationTurn[];
  /** Taille réelle du paquet, en caractères. */
  readonly characters: number;
  /** Ce qui a été écarté, et pourquoi. Jamais silencieux. */
  readonly omitted: {
    readonly byPrivacy: number;
    readonly byBudget: number;
    readonly reasons: readonly string[];
  };
}

const PRIVACY_ORDER: Record<PrivacyClass, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function allowed(memory: PrivacyClass, max: PrivacyClass): boolean {
  return PRIVACY_ORDER[memory] <= PRIVACY_ORDER[max];
}

/**
 * Assemble le paquet.
 *
 * Ordre des opérations, et il compte :
 *   1. filtrage de confidentialité  ← sécurité d'abord
 *   2. tri par utilité              ← confiance, puis fraîcheur
 *   3. application du budget        ← ce qui reste dehors est déclaré
 */
export function buildContextPacket(input: PacketInput): Result<ContextPacket> {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const reasons: string[] = [];

  /* --- 1. Confidentialité -------------------------------------------- */
  const permitted = input.memories.filter((m) =>
    allowed(m.privacyClass, input.maxPrivacyClass),
  );
  const byPrivacy = input.memories.length - permitted.length;
  if (byPrivacy > 0) {
    reasons.push(
      `${String(byPrivacy)} mémoire(s) écartée(s) : classe supérieure à ` +
        `${input.maxPrivacyClass} pour cette destination.`,
    );
  }

  /* --- 2. Tri par utilité --------------------------------------------- */
  // Une affirmation externe non vérifiée ne doit pas remonter devant un fait
  // confirmé, même si elle est textuellement plus proche de la requête.
  const KIND_WEIGHT = { FACT: 1, INFERENCE: 0.8, HYPOTHESIS: 0.6, EXTERNAL_CLAIM: 0.4 };
  const sorted = [...permitted].sort((a, b) => {
    const scoreA = a.confidence * KIND_WEIGHT[a.kind];
    const scoreB = b.confidence * KIND_WEIGHT[b.kind];
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.createdAt.localeCompare(a.createdAt);
  });

  /* --- 3. Budget ------------------------------------------------------- */
  const turns = input.turns.slice(-budget.maxTurns);
  let characters = input.query.length;
  for (const turn of turns) characters += turn.content.length;
  for (const entity of input.entities) characters += entity.displayName.length;

  const kept: StoredMemory[] = [];
  let byBudget = 0;

  for (const memory of sorted) {
    if (kept.length >= budget.maxMemories) {
      byBudget += 1;
      continue;
    }
    if (characters + memory.content.length > budget.maxCharacters) {
      byBudget += 1;
      continue;
    }
    kept.push(memory);
    characters += memory.content.length;
  }

  if (byBudget > 0) {
    reasons.push(
      `${String(byBudget)} mémoire(s) écartée(s) par le budget ` +
        `(${String(budget.maxCharacters)} caractères, ${String(budget.maxMemories)} mémoires).`,
    );
  }

  const droppedTurns = input.turns.length - turns.length;
  if (droppedTurns > 0) {
    reasons.push(`${String(droppedTurns)} tour(s) de conversation plus ancien(s) écarté(s).`);
  }

  return ok({
    query: input.query,
    entities: input.entities,
    memories: kept,
    turns,
    characters,
    omitted: { byPrivacy, byBudget, reasons },
  });
}
