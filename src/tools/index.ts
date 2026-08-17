/**
 * Assemblage des outils du noyau.
 *
 * Référence : 02 Phase 2, `00 §6` (« pas de 50 outils au départ »).
 *
 * Cinq outils, délibérément. La contrainte n'est pas une étape vers cinquante :
 * c'est la surface qu'on peut tenir fiable, vérifier entièrement et auditer
 * sans y passer plus de temps qu'à s'en servir.
 */
import type { ToolGateway } from '../core/tools/gateway.js';
import type { Ledger } from '../core/ledger/ledger.js';
import type { MemoryGuard } from '../core/memory/guard.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { HybridSearch } from '../core/memory/search.js';
import type { CalendarProvider } from '../providers/contract.js';
import { ok, type Result } from '../core/types/result.js';
import { memoryAddTool, memorySearchTool } from './memory.js';
import { taskCreateTool, taskListTool, taskCompleteTool } from './tasks.js';
import { noteCreateTool } from './notes.js';
import { createAuditQueryTool } from './audit.js';
import { fileSearchTool } from './files.js';
import { briefingGenerateTool } from './briefing.js';
import { reminderCreateTool } from './reminders.js';
import { systemStatusTool } from './status.js';
import {
  calendarCreateTool,
  calendarReadTool,
  calendarUpdateTool,
} from './calendar.js';

export interface ToolDeps {
  /** Le journal, pour que `system_status` puisse en vérifier la chaîne. */
  readonly ledger: Ledger;
  readonly guard: MemoryGuard;
  readonly store: MemoryStore;
  readonly search: HybridSearch;
  /**
   * La confirmation utilisateur est fournie par l'appelant, pas devinée par
   * l'outil : c'est une propriété de la conversation, pas de l'appel.
   */
  readonly isUserConfirmed: () => boolean;
  /**
   * Fournisseur d'agenda, ou `null`.
   *
   * `null` est un état NORMAL et déclaré, pas une panne : aucun adaptateur
   * n'existe encore, et le choix du backend (CalDAV local, autre) est une
   * décision de dépendance au sens de `docs/04`. L'outil s'enregistre quand
   * même — il rend alors `PROVIDER_UNAVAILABLE`, ce qui est une réponse, là
   * où l'absence d'outil n'en serait pas une.
   */
  readonly calendar?: CalendarProvider | null;
  /**
   * Racines de fichiers explicitement autorisées.
   *
   * Vide par défaut, et c'est l'état normal : `CLAUDE.md` interdit un accès
   * non contraint, donc il n'y a pas de racine « raisonnable » à supposer.
   * Sans racine, `file_search` REFUSE — il ne cherche pas dans le vide.
   */
  readonly fileRoots?: readonly string[];
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
    /* Phase 3, point 1 de `docs/02`. Premier outil qui MODIFIE une ligne :
       la capture d'annulation y devient une restauration, pas une
       suppression — ADR-042. */
    taskCompleteTool(),
    noteCreateTool(),
    /* Premier outil de Phase 3, et celui qui tient la promesse de `docs/12` :
       le journal devient interrogeable par un humain. Il ne dépend d'aucune
       autre dépendance — il lit `event_ledger` par le contexte d'outil. */
    createAuditQueryTool(),
    /* Phase 3, point 2. Premier outil qui parle à un FOURNISSEUR : un agenda
       vide et un agenda inaccessible se ressemblent, et se racontent
       différemment — ADR-043. */
    calendarReadTool(deps.calendar ?? null),
    /* Phase 3, point 3. PREMIER EFFET EXTERNE du dépôt : toute la machinerie
       de contrats d'effet existait pour ce cas sans qu'aucun code de
       production ne l'exerce — ADR-044. */
    calendarCreateTool(deps.calendar ?? null),
    /* Phase 3, point 4. ADR-042 appliqué là où l'état antérieur vit chez
       quelqu'un d'autre — ADR-045. */
    calendarUpdateTool(deps.calendar ?? null),
    /* Phase 3, point 5. Premier outil qui touche le disque : une racine
       explicitement autorisée, ou rien — ADR-046. */
    fileSearchTool(deps.fileRoots ?? []),
    /* Phase 3, point 7 — scénario doré A7. Agrège trois sources, et dit
       laquelle manque : un briefing partiel doit se déclarer partiel
       (ADR-047). */
    briefingGenerateTool(deps.calendar ?? null),
    /* Phase 3, point 8. Rien ne sonne dans ce dépôt : le rappel se présente
       dans le briefing, et l'outil le DIT (ADR-048). */
    reminderCreateTool(),
    /* Phase 3, point 9 — le dernier des dix accessibles. Un état qui ne peut
       pas dire « ça ne va pas » ne dit rien quand ça va (ADR-049). */
    systemStatusTool(deps.ledger),
  ];

  for (const tool of tools) {
    const registered = gateway.register(tool);
    if (!registered.ok) return registered;
  }
  return ok(undefined);
}

export {
  memoryAddTool,
  memorySearchTool,
  taskCreateTool,
  taskListTool,
  taskCompleteTool,
  noteCreateTool,
  calendarReadTool,
  calendarCreateTool,
  calendarUpdateTool,
  fileSearchTool,
  briefingGenerateTool,
  reminderCreateTool,
  systemStatusTool,
};
