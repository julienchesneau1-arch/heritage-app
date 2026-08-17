/**
 * Outil note : `note_create`.
 *
 * Le plus simple des cinq, et donc celui qui montre le mieux le coût minimal
 * d'un outil conforme : contrat complet, idempotence, relecture, capture
 * d'annulation, événement d'audit. Rien de tout cela n'est optionnel.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
  type VerificationOutcome,
} from '../core/tools/contract.js';
import { verificationOutcome } from '../core/verification/engine.js';
import { PrivacyClass } from '../core/types/domain.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';

const NoteCreateInput = z.object({
  content: z.string().min(1).max(10_000),
  privacyClass: PrivacyClass.default('ORANGE'),
});

interface NoteRow {
  id: string;
  content: string;
  privacy_class: string;
}

export function noteCreateTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'note_create',
      version: '1.0.0',
      description: 'Créer une note.',
      autonomy: 'L2',
      privacyClass: 'ORANGE',
      /* une note écrite PAR l'utilisateur, pas un DOCUMENT reçu d'un tiers — la distinction porte le plancher de PERSONAL à SENSITIVE. */
      dataCategory: 'PERSONAL_MEMORY',
      reversible: true,
      networkRequired: false,
      parameters: [
        { name: 'content', sensitive: false },
        { name: 'privacyClass', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'NOTE_CREATED',
      requiredSecrets: [],
      rollback: 'Supprimer la note via note_delete.',
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
    inputSchema: NoteCreateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      const inserted = await ctx.db.query<NoteRow>(
        `INSERT INTO notes (content, privacy_class, operation_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING id, content, privacy_class`,
        [input.content, input.privacyClass, ctx.operationId],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        const existing = await ctx.db.query<NoteRow>(
          'SELECT id, content, privacy_class FROM notes WHERE operation_id = $1',
          [ctx.operationId],
        );
        if (!existing.ok) return existing;
        const found = existing.value.rows[0];
        if (found === undefined) {
          return err(
            jarvisError('INTERNAL', 'Conflit d\'opération puis note introuvable'),
          );
        }
        return ok({
          output: { noteId: found.id, alreadyExisted: true },
          resource: { kind: 'note', id: found.id },
        });
      }

      return ok({
        output: { noteId: row.id },
        resource: { kind: 'note', id: row.id },
        undo: {
          kind: 'INVERSE_OPERATION',
          inverseToolId: 'note_delete',
          inverseInput: { noteId: row.id },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'));
      }
      const found = await ctx.db.query<NoteRow>(
        'SELECT id, content, privacy_class FROM notes WHERE id = $1',
        [execution.resource.id],
      );
      if (!found.ok) return found;

      const row = found.value.rows[0];
      if (row === undefined) {
        return ok(
          verificationOutcome.failed({
            observed: `La note ${execution.resource.id} est introuvable après création.`,
            // La fenêtre d'observation est FERMÉE : `notes` est dans la même
            // base que le journal d'intention, et la lecture suit le commit.
            // Rien ne peut apparaître après coup (ADR-030).
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `note ${row.id} présente (${String(row.content.length)} caractères)`,
        }),
      );
    },
  });
}
