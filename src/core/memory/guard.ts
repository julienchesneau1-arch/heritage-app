/**
 * Memory Guard.
 *
 * Référence : 03 §11, invariant S1, scénarios 05/A10 et 05/B8.
 *
 * > « Le modèle n'écrit jamais directement en mémoire permanente. »
 *
 *   le LLM propose
 *      ↓ validation de schéma
 *      ↓ classification    ← attribue le CRÉDIT, pas le proposant
 *      ↓ plafond de confiance
 *      ↓ déduplication
 *      ↓ confirmation utilisateur si nécessaire
 *      ↓ stockage
 *
 * Ce module est le seul chemin d'écriture vers `memories`. C'est ce qui rend
 * la défense contre l'empoisonnement de mémoire structurelle plutôt que
 * comportementale : il n'existe pas d'autre porte à surveiller.
 */
import type { MemoryKind } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import {
  CONFIDENCE_CEILING,
  contentDigest,
  MemoryProposal,
  type MemoryType,
  type StoredMemory,
} from './types.js';
import type { MemoryStore } from './store.js';

export interface GuardContext {
  /**
   * L'utilisateur a-t-il explicitement confirmé cette mémoire ?
   *
   * Exigé pour toute PREFERENCE ou RULE : « une préférence naît d'une
   * confirmation, pas d'une lecture » (03 §11).
   */
  readonly userConfirmed: boolean;
}

export interface GuardVerdict {
  readonly memory: StoredMemory;
  /**
   * Ce que le Guard a modifié par rapport à la proposition. Alimente la
   * réponse à « qu'as-tu retenu, et pourquoi ainsi ? ».
   */
  readonly adjustments: readonly string[];
  /** Vrai si une mémoire équivalente existait déjà. */
  readonly deduplicated: boolean;
}

/**
 * Attribue le crédit accordé à une proposition.
 *
 * L'ordre des règles compte : la provenance externe l'emporte sur tout le
 * reste, y compris sur une confirmation utilisateur mal placée.
 */
export function classify(
  provenance: MemoryProposal['provenance'],
  userConfirmed: boolean,
  suggestedConfidence: number,
): MemoryKind {
  // Règle absolue : ce qui vient d'une source non fiable est une affirmation
  // externe. Aucune combinaison d'autres facteurs ne peut la promouvoir.
  if (provenance === 'EXTERNAL_UNTRUSTED') return 'EXTERNAL_CLAIM';

  if (provenance === 'USER') return userConfirmed ? 'FACT' : 'HYPOTHESIS';

  // Sortie d'outil ou déduction système : jamais un fait, jamais une
  // affirmation externe.
  if (provenance === 'TOOL_OUTPUT' || provenance === 'SYSTEM') {
    return suggestedConfidence >= 0.6 ? 'INFERENCE' : 'HYPOTHESIS';
  }

  // Relecture de la mémoire : le crédit ne se recrée pas, il se conserve.
  return 'INFERENCE';
}

/** Types de mémoire qui engagent durablement le comportement de Jarvis. */
const REQUIRES_CONFIRMATION: ReadonlySet<MemoryType> = new Set<MemoryType>([
  'PREFERENCE',
  'RULE',
]);

export interface MemoryGuard {
  /** `proposal` est typé `unknown` : c'est une frontière. */
  propose(proposal: unknown, context: GuardContext): Promise<Result<GuardVerdict>>;
}

export function createMemoryGuard(store: MemoryStore): MemoryGuard {
  return {
    async propose(
      proposal: unknown,
      context: GuardContext,
    ): Promise<Result<GuardVerdict>> {
      /* --- 1. Validation ------------------------------------------------- */
      const parsed = MemoryProposal.safeParse(proposal);
      if (!parsed.success) {
        return err(
          jarvisError('VALIDATION', 'Proposition de mémoire invalide', {
            issues: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(' | '),
          }),
        );
      }
      const p = parsed.data;
      const adjustments: string[] = [];

      /* --- 2. Classification --------------------------------------------- */
      const kind = classify(p.provenance, context.userConfirmed, p.suggestedConfidence);

      /* --- 3. Coercition du type quand le crédit ne le permet pas --------
         C'est le cœur de 05/B8. Un email disant « Julien aime X » propose un
         contenu de nature préférence ; il devient un fait SÉMANTIQUE marqué
         EXTERNAL_CLAIM, jamais une PREFERENCE. Une préférence dicte le
         comportement futur de Jarvis : elle ne peut pas naître d'une lecture. */
      let memoryType: MemoryType = p.memoryType;
      if (kind === 'EXTERNAL_CLAIM' && REQUIRES_CONFIRMATION.has(memoryType)) {
        adjustments.push(
          `Type ramené de ${memoryType} à SEMANTIC : une source externe ne peut pas ` +
            `créer de ${memoryType.toLowerCase()}. Conservé comme affirmation externe, ` +
            `à confirmer avec l'utilisateur avant d'en faire une règle de comportement.`,
        );
        memoryType = 'SEMANTIC';
      }

      /* --- 4. Confirmation exigée ---------------------------------------- */
      if (REQUIRES_CONFIRMATION.has(memoryType) && !context.userConfirmed) {
        return err(
          jarvisError(
            'CONFIRMATION_REQUIRED',
            `Une mémoire de type ${memoryType} exige une confirmation explicite.`,
            { memoryType, proposed: p.content.slice(0, 120) },
          ),
        );
      }

      /* --- 5. Plafond de confiance --------------------------------------- */
      const ceiling = CONFIDENCE_CEILING[kind];
      const confidence = Math.min(p.suggestedConfidence, ceiling);
      if (confidence < p.suggestedConfidence) {
        adjustments.push(
          `Confiance ramenée de ${p.suggestedConfidence.toFixed(2)} à ` +
            `${confidence.toFixed(2)} : plafond du crédit ${kind}.`,
        );
      }

      /* --- 6. Déduplication ---------------------------------------------- */
      const digest = contentDigest(memoryType, p.content);
      const existing = await store.findByDigest(digest, memoryType);
      if (!existing.ok) return existing;

      if (existing.value !== null) {
        return ok({
          memory: existing.value,
          adjustments: [
            ...adjustments,
            'Mémoire équivalente déjà présente : aucune écriture, pas de doublon.',
          ],
          deduplicated: true,
        });
      }

      /* --- 7. Stockage ---------------------------------------------------- */
      const stored = await store.insertVerified({
        kind,
        memoryType,
        content: p.content,
        confidence,
        source: p.source,
        provenance: p.provenance,
        privacyClass: p.privacyClass,
        subjectEntityId: p.subjectEntityId,
        expiresAt: p.expiresAt,
        contentDigest: digest,
        // Une affirmation externe ne peut pas naître vérifiée : la contrainte
        // `external_claim_never_verified` du schéma le garantit aussi en base.
        lastVerifiedAt: kind === 'FACT' ? new Date().toISOString() : null,
      });
      if (!stored.ok) return stored;

      return ok({ memory: stored.value, adjustments, deduplicated: false });
    },
  };
}
