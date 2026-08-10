/**
 * Outils mémoire : `memory_add` et `memory_search`.
 *
 * Référence : 02 Phase 2, 03 §10.
 *
 * `memory_add` n'écrit PAS en base : il passe par le Memory Guard. Un outil
 * qui contournerait le Guard rouvrirait l'empoisonnement de mémoire (03 §11),
 * et c'est précisément le genre de raccourci que le contrat d'outil existe pour
 * empêcher.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
  type VerificationOutcome,
} from '../core/tools/contract.js';
import { verificationOutcome } from '../core/verification/engine.js';
import type { MemoryGuard } from '../core/memory/guard.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { HybridSearch } from '../core/memory/search.js';
import { DataCategory, SourceType } from '../core/types/domain.js';
import { MemoryType } from '../core/memory/types.js';
import { ok, type Result } from '../core/types/result.js';

/* -------------------------------------------------------------------------- */
/* memory_add                                                                 */
/* -------------------------------------------------------------------------- */

const MemoryAddInput = z.object({
  content: z.string().min(1).max(4000),
  memoryType: MemoryType,
  sourceType: SourceType,
  dataCategory: DataCategory.default('OTHER'),
  source: z.string().min(1).default('conversation'),
  subjectEntityId: z.uuid().nullable().default(null),
  suggestedConfidence: z.number().min(0).max(1).default(0.6),
});

export function memoryAddTool(
  guard: MemoryGuard,
  store: MemoryStore,
  /** Le Gateway ne connaît pas la confirmation métier : elle vient de l'appelant. */
  isUserConfirmed: () => boolean,
): RegisteredTool {
  return defineTool({
    definition: {
      id: 'memory_add',
      version: '1.0.0',
      description: 'Mémoriser une information, via le Memory Guard.',
      autonomy: 'L2', // réversible, faible risque
      privacyClass: 'ORANGE',
      reversible: true,
      networkRequired: false,
      parameters: [
        { name: 'content', sensitive: false },
        { name: 'memoryType', sensitive: true },
        { name: 'sourceType', sensitive: true },
        { name: 'dataCategory', sensitive: true },
        { name: 'subjectEntityId', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'MEMORY_ADDED',
      requiredSecrets: [],
      rollback: 'Marquer la mémoire DELETED via memory_forget.',
    },
    inputSchema: MemoryAddInput,

    async execute(input): Promise<Result<ToolExecution>> {
      const verdict = await guard.propose(
        {
          memoryType: input.memoryType,
          content: input.content,
          sourceType: input.sourceType,
          source: input.source,
          dataCategory: input.dataCategory,
          subjectEntityId: input.subjectEntityId,
          suggestedConfidence: input.suggestedConfidence,
        },
        { userConfirmed: isUserConfirmed() },
      );
      if (!verdict.ok) return verdict;

      // Trois issues possibles du Guard, trois résultats d'outil distincts.
      if (verdict.value.outcome === 'QUEUED') {
        return ok({
          output: {
            outcome: 'QUEUED',
            candidateId: verdict.value.candidate.id,
            adjustments: verdict.value.adjustments,
          },
          // Aucune mémoire créée : rien à relire, rien à annuler.
        });
      }

      const memory = verdict.value.memory;
      return ok({
        output: {
          outcome: verdict.value.outcome,
          memoryId: memory.id,
          kind: memory.kind,
          confidence: memory.confidence,
          adjustments: verdict.value.adjustments,
        },
        resource: { kind: 'memory', id: memory.id },
        undo:
          verdict.value.outcome === 'STORED'
            ? {
                kind: 'INVERSE_OPERATION',
                // `memory_forget` arrivera avec l'Undo Engine. La capture est
                // un enregistrement, pas une exécution (ADR-019).
                inverseToolId: 'memory_forget',
                inverseInput: { memoryId: memory.id },
              }
            : { kind: 'NOT_UNDOABLE' }, // déduplication : rien n'a été créé
      });
    },

    async readBack(execution): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(
          verificationOutcome.confirmed({
            observed: 'aucune mémoire à créer (mise en file ou dédupliquée)',
          }),
        );
      }
      const found = await store.getById(execution.resource.id);
      if (!found.ok) return found;
      if (found.value === null) {
        return ok(
          verificationOutcome.failed(
            `La mémoire ${execution.resource.id} est introuvable après création.`,
          ),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `mémoire ${found.value.id} présente, crédit ${found.value.kind}`,
        }),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */
/* memory_search                                                              */
/* -------------------------------------------------------------------------- */

const MemorySearchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});

export function memorySearchTool(search: HybridSearch): RegisteredTool {
  return defineTool({
    definition: {
      id: 'memory_search',
      version: '1.0.0',
      description: 'Rechercher dans la mémoire personnelle (trois voies).',
      autonomy: 'L1', // lecture seule
      privacyClass: 'ORANGE',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'query', sensitive: false }],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 5000,
      maxRetries: 2,
      auditEvent: 'MEMORY_SEARCHED',
      requiredSecrets: [],
      rollback: null, // une lecture ne se défait pas
    },
    inputSchema: MemorySearchInput,

    async execute(input): Promise<Result<ToolExecution>> {
      const found = await search.search({
        text: input.query,
        limit: input.limit,
      });
      if (!found.ok) return found;

      return ok({
        output: {
          results: found.value.merged.map((m) => ({
            id: m.memory.id,
            content: m.memory.content,
            kind: m.memory.kind,
            confidence: m.memory.confidence,
            lanes: m.lanes,
          })),
          // La dégradation est remontée à l'appelant : Jarvis doit pouvoir
          // dire « j'ai cherché sans la voie sémantique ».
          degraded: found.value.degraded,
          /**
           * OÙ la recherche a réellement eu lieu (HIGH-4).
           *
           * Sans ce champ, une réponse vide était indiscernable d'une
           * recherche web infructueuse. La portée n'est pas une décoration
           * d'interface : c'est une partie du résultat, et toute interface
           * doit l'afficher — y compris quand la recherche a trouvé quelque
           * chose, sinon l'utilisateur ne saura jamais ce qui n'a PAS été
           * consulté.
           */
          scope: 'MEMOIRE_PERSONNELLE',
          scopeLabel:
            'recherche limitée à ta mémoire personnelle — ni web, ni documents',
        },
      });
    },
  });
}
