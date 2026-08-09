/**
 * Memory Guard.
 *
 * Référence : 03 §11, 09 §2.1, invariant S1, scénarios 05/A10 et 05/B8.
 *
 * > « Le modèle n'écrit jamais directement en mémoire permanente. »
 *
 *   le LLM propose
 *      ↓ validation de schéma
 *      ↓ classification         ← attribue le CRÉDIT, pas le proposant
 *      ↓ plafonds de confiance  ← deux plafonds : crédit ET origine
 *      ↓ classification de confidentialité
 *      ↓ déduplication
 *      ↓ file d'attente OU stockage
 *
 * Ce module est le seul chemin d'écriture vers `memories`. C'est ce qui rend
 * la défense contre l'empoisonnement de mémoire structurelle plutôt que
 * comportementale : il n'existe pas d'autre porte à surveiller.
 */
import {
  provenanceOf,
  requiresRed,
  type MemoryKind,
  type PrivacyClass,
  type SourceType,
} from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { MemoryInbox } from './inbox.js';
import type { MemoryStore } from './store.js';
import {
  CONFIDENCE_CEILING,
  contentDigest,
  MemoryProposal,
  SOURCE_CEILING,
  type MemoryCandidate,
  type MemoryType,
  type StoredMemory,
} from './types.js';

export interface GuardContext {
  /**
   * L'utilisateur a-t-il explicitement confirmé cette mémoire ?
   *
   * Exigé pour toute PREFERENCE ou RULE : « une préférence naît d'une
   * confirmation, pas d'une lecture » (03 §11).
   */
  readonly userConfirmed: boolean;
}

/**
 * Ce que le Guard a décidé.
 *
 * Trois issues, et la troisième est nouvelle : une proposition non confirmée
 * n'est plus perdue, elle attend dans l'Inbox (09 §2.1).
 */
export type GuardVerdict =
  | {
      readonly outcome: 'STORED';
      readonly memory: StoredMemory;
      readonly adjustments: readonly string[];
    }
  | {
      readonly outcome: 'DEDUPLICATED';
      readonly memory: StoredMemory;
      readonly adjustments: readonly string[];
    }
  | {
      readonly outcome: 'QUEUED';
      readonly candidate: MemoryCandidate;
      readonly adjustments: readonly string[];
    };

/**
 * Attribue le crédit accordé à une proposition, depuis son origine.
 *
 * L'ordre des règles compte : la source externe l'emporte sur tout le reste,
 * y compris sur une confirmation utilisateur mal placée.
 */
export function classify(
  sourceType: SourceType,
  suggestedConfidence: number,
): MemoryKind {
  switch (sourceType) {
    // Règle absolue : ce qui vient d'une source externe est une affirmation
    // externe. Aucune combinaison d'autres facteurs ne peut la promouvoir.
    case 'EXTERNAL_SOURCE':
      return 'EXTERNAL_CLAIM';

    // Déclaré ET confirmé par l'utilisateur. Le seul chemin vers FACT par la
    // parole — l'autre étant la vérification par un outil.
    case 'USER_EXPLICIT':
      return 'FACT';

    // Constaté contre l'état réel : c'est la définition d'un fait.
    case 'TOOL_VERIFIED':
      return 'FACT';

    // Déduit des propos de l'utilisateur, sans confirmation.
    case 'USER_INFERRED':
      return 'HYPOTHESIS';

    case 'MODEL_INFERRED':
      return suggestedConfidence >= 0.6 ? 'INFERENCE' : 'HYPOTHESIS';

    case 'SYSTEM':
      return 'INFERENCE';
  }
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

export function createMemoryGuard(
  store: MemoryStore,
  inbox: MemoryInbox,
): MemoryGuard {
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

      /* --- 2. L'origine déclarée n'est pas prise pour argent comptant -----
         Un proposant ne peut pas s'auto-décerner l'explicitness : sans
         confirmation, USER_EXPLICIT redevient USER_INFERRED. C'est le même
         principe que le plafond de confiance, appliqué à l'origine. */
      let sourceType: SourceType = p.sourceType;
      if (sourceType === 'USER_EXPLICIT' && !context.userConfirmed) {
        sourceType = 'USER_INFERRED';
        adjustments.push(
          'Origine ramenée de USER_EXPLICIT à USER_INFERRED : aucune ' +
            'confirmation de l\'utilisateur n\'accompagne cette proposition.',
        );
      }

      /* --- 3. Classification --------------------------------------------- */
      const kind = classify(sourceType, p.suggestedConfidence);

      /* --- 4. Coercition du type quand le crédit ne le permet pas ---------
         Cœur de 05/B8. Un email disant « Julien aime X » propose un contenu de
         nature préférence ; il devient un fait SÉMANTIQUE marqué
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

      /* --- 5. Plafonds de confiance ---------------------------------------
         Deux plafonds indépendants : le crédit et l'origine. On applique le
         plus bas. Une INFERENCE d'origine EXTERNAL_SOURCE ne doit pas
         bénéficier du plafond des inférences. */
      const ceiling = Math.min(
        CONFIDENCE_CEILING[kind],
        SOURCE_CEILING[sourceType],
      );
      const confidence = Math.min(p.suggestedConfidence, ceiling);
      if (confidence < p.suggestedConfidence) {
        adjustments.push(
          `Confiance ramenée de ${p.suggestedConfidence.toFixed(2)} à ` +
            `${confidence.toFixed(2)} : plafond du crédit ${kind} croisé avec ` +
            `celui de l'origine ${sourceType}.`,
        );
      }

      /* --- 6. Classification de confidentialité ---------------------------
         Certaines catégories ne peuvent pas être classées autrement que RED.
         On corrige plutôt que d'échouer : une mauvaise classification proposée
         ne doit pas empêcher la mémorisation, mais elle ne doit surtout pas
         être conservée telle quelle. */
      let privacyClass: PrivacyClass = p.privacyClass;
      if (requiresRed(p.dataCategory) && privacyClass !== 'RED') {
        adjustments.push(
          `Confidentialité relevée de ${privacyClass} à RED : la catégorie ` +
            `${p.dataCategory} ne peut jamais quitter la machine.`,
        );
        privacyClass = 'RED';
      }

      /* --- 7. Confirmation exigée → file d'attente ------------------------
         Avant : refus, et la proposition était perdue. Maintenant : elle
         attend, et Jarvis pourra demander « j'ai remarqué ceci, dois-je le
         retenir ? » (09 §2.1). */
      if (REQUIRES_CONFIRMATION.has(memoryType) && !context.userConfirmed) {
        const queued = await inbox.enqueue({
          content: p.content,
          memoryType,
          sourceType,
          source: p.source,
          dataCategory: p.dataCategory,
          privacyClass,
          suggestedConfidence: confidence,
          subjectEntityId: p.subjectEntityId,
          provenance: provenanceOf(sourceType),
        });
        if (!queued.ok) return queued;

        return ok({
          outcome: 'QUEUED',
          candidate: queued.value,
          adjustments: [
            ...adjustments,
            `Une mémoire de type ${memoryType} exige une confirmation. ` +
              'Déposée dans le Memory Inbox plutôt que perdue.',
          ],
        });
      }

      /* --- 8. Déduplication ------------------------------------------------ */
      const digest = contentDigest(memoryType, p.content);
      const existing = await store.findByDigest(digest, memoryType);
      if (!existing.ok) return existing;

      if (existing.value !== null) {
        return ok({
          outcome: 'DEDUPLICATED',
          memory: existing.value,
          adjustments: [
            ...adjustments,
            'Mémoire équivalente déjà présente : aucune écriture, pas de doublon.',
          ],
        });
      }

      /* --- 9. Stockage ------------------------------------------------------ */
      const stored = await store.insertVerified({
        kind,
        memoryType,
        content: p.content,
        confidence,
        source: p.source,
        sourceType,
        dataCategory: p.dataCategory,
        provenance: provenanceOf(sourceType),
        privacyClass,
        subjectEntityId: p.subjectEntityId,
        expiresAt: p.expiresAt,
        contentDigest: digest,
        // Une affirmation externe ne peut pas naître vérifiée : la contrainte
        // `external_claim_never_verified` du schéma le garantit aussi en base.
        lastVerifiedAt: kind === 'FACT' ? new Date().toISOString() : null,
      });
      if (!stored.ok) return stored;

      return ok({ outcome: 'STORED', memory: stored.value, adjustments });
    },
  };
}
