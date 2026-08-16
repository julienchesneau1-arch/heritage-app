/**
 * Assemblage des cinq premiers outils.
 *
 * Référence : 02 Phase 2, `00 §6` (« pas de 50 outils au départ »).
 *
 * Cinq outils, délibérément. La contrainte n'est pas une étape vers cinquante :
 * c'est la surface qu'on peut tenir fiable, vérifier entièrement et auditer
 * sans y passer plus de temps qu'à s'en servir.
 */
import type { ToolGateway } from '../core/tools/gateway.js';
import type { MemoryGuard } from '../core/memory/guard.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { HybridSearch } from '../core/memory/search.js';
import { ok, type Result } from '../core/types/result.js';
import { memoryAddTool, memorySearchTool } from './memory.js';
import { taskCreateTool, taskListTool } from './tasks.js';
import { noteCreateTool } from './notes.js';
import { createAuditQueryTool } from './audit.js';

export interface ToolDeps {
  readonly guard: MemoryGuard;
  readonly store: MemoryStore;
  readonly search: HybridSearch;
  /**
   * La confirmation utilisateur est fournie par l'appelant, pas devinée par
   * l'outil : c'est une propriété de la conversation, pas de l'appel.
   */
  readonly isUserConfirmed: () => boolean;
}

/**
 * Enregistre les cinq outils.
 *
 * Un contrat incohérent fait échouer l'enregistrement, donc le démarrage —
 * plutôt que de produire une surprise au premier appel.
 */
export function registerCoreTools(
  gateway: ToolGateway,
  deps: ToolDeps,
): Result<void> {
  const tools = [
    memoryAddTool(deps.guard, deps.store, deps.isUserConfirmed),
    memorySearchTool(deps.search),
    taskCreateTool(),
    taskListTool(),
    noteCreateTool(),
    /* Premier outil de Phase 3, et celui qui tient la promesse de `docs/12` :
       le journal devient interrogeable par un humain. Il ne dépend d'aucune
       autre dépendance — il lit `event_ledger` par le contexte d'outil. */
    createAuditQueryTool(),
  ];

  for (const tool of tools) {
    const registered = gateway.register(tool);
    if (!registered.ok) return registered;
  }
  return ok(undefined);
}

export { memoryAddTool, memorySearchTool, taskCreateTool, taskListTool, noteCreateTool };
