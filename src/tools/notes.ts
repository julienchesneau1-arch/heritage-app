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
      outputProvenance: 'TOOL_OUTPUT',
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

/* -------------------------------------------------------------------------- */
/* note_delete — l'inverse déclaré de `note_create`                           */
/* -------------------------------------------------------------------------- */

const NoteDeleteInput = z.object({
  noteId: z.uuid(),
});

/**
 * SUPPRIMER UNE NOTE — deuxième outil inverse écrit. ADR-067.
 *
 * `note_create` annonce `rollback: 'Supprimer la note via note_delete.'` depuis
 * le premier jour. L'outil n'existait pas : l'annulation d'une note était une
 * phrase, pas une capacité.
 *
 * POURQUOI `L4` ALORS QUE `note_create` EST `L2`
 * ---------------------------------------------------------------------------
 * `docs/03` ne laisse pas le choix : `L4` = *« Paiement, **suppression**,
 * données sensibles, **irréversible** »*. Une note supprimée ne revient pas.
 *
 * **Et c'est une asymétrie voulue avec `task_cancel` et `reminder_cancel`,
 * restés `L2`** : ceux-là font passer un état à `CANCELLED`, la ligne survit,
 * le contenu aussi. *Annuler n'est pas supprimer* — les deux mots désignent
 * ici deux gestes de gravité différente, et le niveau d'autonomie est l'endroit
 * où la différence se paie.
 *
 * > ⚠ Le risque de ce choix est nommé plutôt que masqué : à trop classer `L4`,
 * > la confirmation forte devient un réflexe et cesse de protéger ce qui
 * > compte. Condition de révision dans ADR-067.
 */
export function noteDeleteTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'note_delete',
      version: '1.0.0',
      description: 'Supprimer définitivement une note.',
      autonomy: 'L4',
      privacyClass: 'ORANGE',
      dataCategory: 'PERSONAL_MEMORY',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'noteId', sensitive: true }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'NOTE_DELETED',
      requiredSecrets: [],
      // Rien ne défait une suppression. Annoncer un rollback inexistant
      // promettrait une réversibilité que `reversible: false` nie déjà.
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: NoteDeleteInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* `RETURNING id` PLUTÔT QUE `rowCount` — même raison que `memory_forget`
         (ADR-065) : il faut distinguer « j'ai supprimé » de « il n'y avait
         rien », et le second ne doit jamais s'annoncer comme un succès. */
      const supprime = await ctx.db.query<{ id: string }>(
        'DELETE FROM notes WHERE id = $1 RETURNING id',
        [input.noteId],
      );
      if (!supprime.ok) return supprime;

      return ok({
        output: {
          noteId: input.noteId,
          existait: supprime.value.rows.length > 0,
        },
        resource: { kind: 'note', id: input.noteId },
        // Voir `memory_forget` : la capture existe et ne garde rien. Recopier
        // le contenu ici reviendrait à ne pas supprimer.
        undo: { kind: 'NOT_UNDOABLE' },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      const sortie = execution.output as { noteId: string; existait: boolean };

      if (!sortie.existait) {
        return ok(
          verificationOutcome.notAttempted(
            `Aucune note ${sortie.noteId} : il n'y avait rien à supprimer.`,
          ),
        );
      }

      const reste = await ctx.db.query<{ id: string }>(
        'SELECT id FROM notes WHERE id = $1',
        [sortie.noteId],
      );
      if (!reste.ok) return reste;

      if (reste.value.rows.length > 0) {
        return ok(
          verificationOutcome.failed({
            observed: `La note ${sortie.noteId} est TOUJOURS présente après suppression.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }

      /* `erased` ET NON `confirmed` : ici le succès EST une absence, et la
         preuve qui l'établit est `POSITIVE_ABSENCE` (ADR-065). */
      return ok(
        verificationOutcome.erased({
          observed: `note ${sortie.noteId} absente`,
          conclusiveBecause:
            'lecture transactionnelle après commit, aucun effet différé possible',
        }),
      );
    },
  });
}
