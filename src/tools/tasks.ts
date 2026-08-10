/**
 * Outils tâches : `task_create` et `task_list`.
 *
 * `task_create` illustre la vérification `READ_BACK` dans sa forme la plus
 * simple : on relit la ligne créée et on compare le titre à l'attendu. « L'API
 * a répondu » ne suffit pas, même quand l'API, c'est notre propre base.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
  type VerificationOutcome,
} from '../core/tools/contract.js';
import { verificationOutcome } from '../core/verification/engine.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';

const TaskCreateInput = z.object({
  title: z.string().min(1).max(500),
  dueAt: z.string().nullable().default(null),
});

interface TaskRow {
  id: string;
  title: string;
  state: string;
  due_at: Date | null;
}

export function taskCreateTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'task_create',
      version: '1.0.0',
      description: 'Créer une tâche.',
      autonomy: 'L2',
      privacyClass: 'ORANGE',
      reversible: true,
      networkRequired: false,
      parameters: [
        { name: 'title', sensitive: false },
        { name: 'dueAt', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'TASK_CREATED',
      requiredSecrets: [],
      rollback: 'Passer la tâche à CANCELLED via task_cancel.',
      // Aucun de ces outils ne sait dire après coup si une tentative a eu un
      // effet : ils n'écrivent pas la clé d'opération dans la ressource créée.
      // La reprise conclura donc UNKNOWN, et refusera de rejouer (ADR-027).
      attemptVerification: 'NONE',
      // Écrit dans la même base que le journal d'intention : une erreur
      // signifie un rollback, donc l'absence d'effet (ADR-029).
      effect: 'LOCAL_TRANSACTIONAL',
      // PostgreSQL ferme la fenêtre d'observation : une relecture qui ne
      // trouve rien PROUVE l'absence (ADR-030).
      verifiability: 'VERIFIABLE',
    },
    inputSchema: TaskCreateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      // La clé d'opération est portée jusqu'en base : la contrainte d'unicité
      // est la dernière barrière contre le doublon, après celle du Gateway.
      const inserted = await ctx.db.query<TaskRow>(
        `INSERT INTO tasks (title, due_at, operation_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING id, title, state, due_at`,
        [input.title, input.dueAt, ctx.operationId],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        // Conflit : la tâche existe déjà pour cette opération.
        const existing = await ctx.db.query<TaskRow>(
          'SELECT id, title, state, due_at FROM tasks WHERE operation_id = $1',
          [ctx.operationId],
        );
        if (!existing.ok) return existing;
        const found = existing.value.rows[0];
        if (found === undefined) {
          return err(
            jarvisError('INTERNAL', 'Conflit d\'opération puis tâche introuvable'),
          );
        }
        return ok({
          output: { taskId: found.id, alreadyExisted: true },
          resource: { kind: 'task', id: found.id },
        });
      }

      return ok({
        output: { taskId: row.id, title: row.title, state: row.state },
        resource: { kind: 'task', id: row.id },
        undo: {
          kind: 'INVERSE_OPERATION',
          inverseToolId: 'task_cancel',
          inverseInput: { taskId: row.id },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'));
      }
      const found = await ctx.db.query<TaskRow>(
        'SELECT id, title, state, due_at FROM tasks WHERE id = $1',
        [execution.resource.id],
      );
      if (!found.ok) return found;

      const row = found.value.rows[0];
      if (row === undefined) {
        return ok(
          verificationOutcome.failed({
            observed: `La tâche ${execution.resource.id} est introuvable après création.`,
            // La fenêtre d'observation est FERMÉE : `tasks` est dans la même
            // base que le journal d'intention, et la lecture suit le commit.
            // Rien ne peut apparaître après coup (ADR-030).
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `tâche « ${row.title} » présente, état ${row.state}`,
        }),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */

const TaskListInput = z.object({
  state: z.enum(['OPEN', 'DONE', 'CANCELLED']).default('OPEN'),
  limit: z.number().int().min(1).max(100).default(20),
});

export function taskListTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'task_list',
      version: '1.0.0',
      description: 'Lister les tâches.',
      autonomy: 'L1',
      privacyClass: 'ORANGE',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'state', sensitive: false }],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 5000,
      maxRetries: 2,
      auditEvent: 'TASK_LISTED',
      requiredSecrets: [],
      rollback: null,
      // Aucun de ces outils ne sait dire après coup si une tentative a eu un
      // effet : ils n'écrivent pas la clé d'opération dans la ressource créée.
      // La reprise conclura donc UNKNOWN, et refusera de rejouer (ADR-027).
      attemptVerification: 'NONE',
      // Écrit dans la même base que le journal d'intention : une erreur
      // signifie un rollback, donc l'absence d'effet (ADR-029).
      effect: 'LOCAL_TRANSACTIONAL',
      // PostgreSQL ferme la fenêtre d'observation : une relecture qui ne
      // trouve rien PROUVE l'absence (ADR-030).
      verifiability: 'VERIFIABLE',
    },
    inputSchema: TaskListInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      const rows = await ctx.db.query<TaskRow>(
        `SELECT id, title, state, due_at FROM tasks
          WHERE state = $1 ORDER BY created_at DESC LIMIT $2`,
        [input.state, input.limit],
      );
      if (!rows.ok) return rows;

      return ok({
        output: {
          tasks: rows.value.rows.map((r) => ({
            id: r.id,
            title: r.title,
            state: r.state,
            dueAt: r.due_at?.toISOString() ?? null,
          })),
        },
      });
    },
  });
}
