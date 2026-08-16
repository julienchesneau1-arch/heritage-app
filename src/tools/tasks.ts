/**
 * Outils tâches : `task_create`, `task_list`, `task_complete`.
 *
 * `task_create` illustre la vérification `READ_BACK` dans sa forme la plus
 * simple : on relit la ligne créée et on compare le titre à l'attendu. « L'API
 * a répondu » ne suffit pas, même quand l'API, c'est notre propre base.
 *
 * `task_complete` est le premier outil du dépôt qui MODIFIE une ligne
 * existante, et c'est là que la capture d'annulation cesse d'être une
 * formalité : créer se défait en supprimant, mais modifier ne se défait qu'en
 * restaurant **ce qui était là**. Voir ADR-042.
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

/* -------------------------------------------------------------------------- */

const TaskCompleteInput = z.object({
  taskId: z.string().uuid(),
});

interface CompletedRow {
  id: string;
  title: string;
  state: string;
  prior_state: string;
}

/**
 * `task_complete` — premier outil de MODIFICATION du dépôt.
 *
 * Tout ce qui suit découle d'une seule observation : **créer se défait en
 * supprimant, modifier ne se défait qu'en restaurant ce qui était là.** Une
 * suppression n'a besoin de rien savoir du passé ; une restauration n'est
 * correcte que si l'état antérieur a été LU, et lu au bon instant.
 */
export function taskCompleteTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'task_complete',
      version: '1.0.0',
      description: 'Marquer une tâche comme terminée.',
      /* L2, comme `task_create` : c'est une mutation. Le fait qu'elle soit
         petite et réversible ne la sort pas de la cérémonie — sinon chaque
         mutation trouverait une raison d'être l'exception. */
      autonomy: 'L2',
      privacyClass: 'ORANGE',
      reversible: true,
      networkRequired: false,
      parameters: [{ name: 'taskId', sensitive: false }],
      /* `OPERATION_KEY`, ET C'EST LE VALIDATEUR DE CONTRAT QUI A EU RAISON.

         J'avais écrit `NATURALLY_IDEMPOTENT` : l'état final ne dépend pas du
         nombre d'exécutions, terminer deux fois laisse `DONE`. Refusé —
         « une mutation exige une clé d'opération (invariant S6) ».

         L'objection est juste, et plus profonde que la règle qui la porte :
         l'idempotence vaut ici pour l'ÉTAT, pas pour la CAPTURE. Une seconde
         exécution observerait `DONE` et enregistrerait `priorState: 'DONE'`,
         écrasant la capture de la première. L'état serait inchangé et
         l'action serait devenue irréversible — un effet invisible dans la
         seule chose qu'on regardait.

         Autrement dit : une mutation n'est jamais « naturellement »
         idempotente tant qu'elle traîne un effet de bord qui, lui, ne l'est
         pas. La clé d'opération est ce qui permet de RECONNAÎTRE le rejeu au
         lieu de le subir. */
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'TASK_COMPLETED',
      requiredSecrets: [],
      rollback: "Restaurer l'état antérieur CAPTURÉ (STATE_RESTORE) — jamais un état supposé.",
      /* `NONE`, et pas seulement par défaut d'outillage.
     
         Un rejeu serait ici plus dangereux qu'un doublon : la seconde
         exécution observerait `DONE` et capturerait `priorState: 'DONE'`,
         écrasant la capture de la première. L'action deviendrait
         irréversible — silencieusement, et précisément parce qu'on aurait
         voulu bien faire en la rejouant.
     
         Déclarer `NONE` fait conclure la reprise à `UNKNOWN` et lui interdit
         le rejeu (ADR-027). C'est le bon arbitrage : une tâche dont on ignore
         l'état se demande, elle ne se devine pas. */
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
    },
    inputSchema: TaskCompleteInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* LA MUTATION ET LA CAPTURE SONT LA MÊME INSTRUCTION.
     
         `FROM tasks AS prior` lit l'instantané pris au DÉBUT de la commande :
         `prior.state` est donc l'état d'avant, rendu par la requête qui le
         remplace. Un `SELECT` suivi d'un `UPDATE` ouvrirait entre les deux une
         fenêtre où l'état peut changer — et la capture décrirait alors un
         passé qui n'a jamais existé.
     
         C'est le motif « l'observateur redéfinit le passé » (`docs/26 §3`)
         dans sa forme la plus coûteuse : ici l'observation N'EST PAS un
         rapport, c'est la seule chose qui rendra l'annulation possible. */
      const updated = await ctx.db.query<CompletedRow>(
        `UPDATE tasks AS t
            SET state = 'DONE', updated_at = now()
           FROM tasks AS prior
          WHERE t.id = $1
            AND prior.id = t.id
            AND prior.state <> 'CANCELLED'
        RETURNING t.id, t.title, t.state, prior.state AS prior_state`,
        [input.taskId],
      );
      if (!updated.ok) return updated;

      const row = updated.value.rows[0];
      if (row === undefined) {
        /* Zéro ligne : soit la tâche n'existe pas, soit elle est annulée. La
           relecture qui suit ne sert QU'À NOMMER un refus déjà prononcé —
           elle ne peut transformer un refus en succès, donc une course y est
           sans conséquence. */
        const state = await ctx.db.query<{ state: string }>(
          'SELECT state FROM tasks WHERE id = $1',
          [input.taskId],
        );
        if (!state.ok) return state;
        const found = state.value.rows[0];
        if (found === undefined) {
          return err(jarvisError('NOT_FOUND', `Tâche ${input.taskId} introuvable.`));
        }
        /* Refus explicite plutôt que conversion silencieuse. Faire passer une
           tâche ANNULÉE à TERMINÉE effacerait une décision de l'utilisateur du
           seul état qu'il consulte — le journal la garderait, mais personne ne
           lit le journal pour savoir où en est sa liste. */
        return err(
          jarvisError(
            'CONFLICT',
            `Tâche ${input.taskId} annulée : la terminer effacerait cette décision. `
              + 'La rouvrir d\'abord, si c\'est bien l\'intention.',
          ),
        );
      }

      return ok({
        output: {
          taskId: row.id,
          title: row.title,
          state: row.state,
          priorState: row.prior_state,
          /* Rendu explicitement : « c'était déjà fait » et « je viens de le
             faire » sont deux réponses différentes, et la seconde ne doit pas
             être annoncée à la place de la première. */
          changed: row.prior_state !== 'DONE',
        },
        resource: { kind: 'task', id: row.id },
        undo: {
          kind: 'STATE_RESTORE',
          priorState: { taskId: row.id, state: row.prior_state },
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
            observed: `La tâche ${execution.resource.id} est introuvable après complétion.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      if (row.state !== 'DONE') {
        /* NI `CONFIRMED` NI `FAILED`, et c'est le point.
       
           L'`UPDATE` a rendu une ligne : l'écriture a eu lieu. Observer autre
           chose que `DONE` ensuite ne prouve pas qu'elle a échoué — cela
           prouve qu'un AUTRE écrivain est passé après le commit. Annoncer
           `FAILED` serait un échec inventé, et l'utilisateur agirait dessus.
       
           « Externe » signifie ici extérieur à CETTE exécution, pas extérieur
           à la machine. */
        return ok(
          verificationOutcome.unknown(
            `État observé « ${row.state} » après une écriture qui a rendu une ligne : `
              + 'un autre écrivain est intervenu depuis le commit.',
            'EXTERNAL_STATE',
          ),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `tâche « ${row.title} » relue à l'état ${row.state}`,
        }),
      );
    },
  });
}
