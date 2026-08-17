/**
 * `reminder_create` — Phase 3, point 8 de `docs/02`.
 *
 * L'ARBITRAGE QUI PRÉCÈDE CET OUTIL
 * ----------------------------------
 * Mesuré avant d'écrire : **il n'existe dans le dépôt ni ordonnanceur, ni
 * minuterie applicative, ni canal de notification.** Rien ne peut faire sonner
 * quoi que ce soit à une heure donnée.
 *
 * Un « rappel » qui ne sonne pas est un mensonge porté par son nom — la
 * règle 3 (« jamais de succès non vérifié ») appliquée non pas à un effet, mais
 * à une **promesse**. Et c'est la forme la plus difficile à repérer : rien
 * n'échoue, rien ne s'affiche en rouge, la déception arrive des heures plus
 * tard.
 *
 * L'outil existe quand même, pour une raison qui se mesure : `briefing_generate`
 * existe. Un rappel dont l'échéance tombe aujourd'hui **apparaît** quand on
 * demande « prépare ma journée ».
 *
 *   > Il ne sonne pas. Il se présente.
 *
 * Et il le dit avec ces mots — `delivery: 'NONE'`, `surfacedIn:
 * ['briefing_generate']` — plutôt que de laisser croire au contraire. Voir
 * ADR-048.
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

const ReminderCreateInput = z.object({
  text: z.string().min(1).max(500),
  remindAt: z.string().datetime(),
});

interface ReminderRow {
  id: string;
  text: string;
  remind_at: Date;
  state: string;
}

export function reminderCreateTool(): RegisteredTool {
  return defineTool<z.infer<typeof ReminderCreateInput>>({
    definition: {
      id: 'reminder_create',
      version: '1.0.0',
      description: 'Créer un rappel, restitué dans le briefing du jour.',
      /* L2, comme les autres mutations locales. Le fait qu'un rappel soit
         anodin ne le sort pas de la cérémonie. */
      autonomy: 'L2',
      privacyClass: 'ORANGE',
      /* un rappel est une tâche datée du point de vue de la classification. */
      dataCategory: 'TASK',
      reversible: true,
      networkRequired: false,
      parameters: [
        { name: 'text', sensitive: true },
        /* Une heure de rappel dit quelque chose de la journée de
           l'utilisateur. Même traitement que `dueAt` sur `task_create`. */
        { name: 'remindAt', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5_000,
      maxRetries: 1,
      auditEvent: 'REMINDER_CREATED',
      requiredSecrets: [],
      rollback: 'Passer le rappel à CANCELLED via reminder_cancel.',
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: ReminderCreateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* « EST-CE DANS LE PASSÉ ? » EST TRANCHÉ PAR LA BASE.

         Leçon d'ADR-037, et elle compte doublement ici : l'échéance sera
         relue par le briefing, qui interroge lui aussi l'horloge de la base.
         Comparer à `Date.now()` ici créerait deux horloges pour un même fait —
         un rappel accepté comme futur par l'outil et déjà dépassé pour le
         briefing.

         Le refus est explicite plutôt que silencieux : puisque rien ne sonne,
         un rappel créé dans le passé n'aurait aucune chance de servir, et
         l'accepter donnerait l'impression du contraire. */
      const passe = await ctx.db.query<{ depasse: boolean }>(
        'SELECT $1::timestamptz <= clock_timestamp() AS depasse',
        [input.remindAt],
      );
      if (!passe.ok) return passe;
      if (passe.value.rows[0]?.depasse === true) {
        return err(
          jarvisError(
            'VALIDATION',
            "L'échéance est déjà passée. Rien ne déclenche un rappel dans ce "
              + "dépôt : créé dans le passé, il ne servirait jamais.",
          ),
        );
      }

      const inserted = await ctx.db.query<ReminderRow>(
        `INSERT INTO reminders (text, remind_at, operation_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING id, text, remind_at, state`,
        [input.text, input.remindAt, ctx.operationId],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        const existing = await ctx.db.query<ReminderRow>(
          'SELECT id, text, remind_at, state FROM reminders WHERE operation_id = $1',
          [ctx.operationId],
        );
        if (!existing.ok) return existing;
        const found = existing.value.rows[0];
        if (found === undefined) {
          return err(
            jarvisError('INTERNAL', "Conflit d'opération puis rappel introuvable"),
          );
        }
        return ok({
          output: { reminderId: found.id, alreadyExisted: true },
          resource: { kind: 'reminder', id: found.id },
        });
      }

      return ok({
        output: {
          reminderId: row.id,
          text: row.text,
          remindAt: row.remind_at.toISOString(),
          /* LES DEUX CHAMPS QUI EMPÊCHENT LA PROMESSE DE MENTIR.

             Sans eux, l'utilisateur entend « rappel créé » et attend une
             sonnerie qui n'arrivera pas. L'outil ne peut pas livrer la
             notification ; il peut refuser de laisser croire qu'il le fera. */
          delivery: 'NONE',
          deliveryDetail:
            "aucun ordonnanceur n'existe : ce rappel ne sonnera pas, il "
            + 'apparaîtra dans le briefing du jour de son échéance',
          surfacedIn: ['briefing_generate'],
        },
        resource: { kind: 'reminder', id: row.id },
        undo: {
          kind: 'INVERSE_OPERATION',
          inverseToolId: 'reminder_cancel',
          inverseInput: { reminderId: row.id },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(
          verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'),
        );
      }
      const found = await ctx.db.query<ReminderRow>(
        'SELECT id, text, remind_at, state FROM reminders WHERE id = $1',
        [execution.resource.id],
      );
      if (!found.ok) return found;

      const row = found.value.rows[0];
      if (row === undefined) {
        return ok(
          verificationOutcome.failed({
            observed: `Le rappel ${execution.resource.id} est introuvable après création.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `rappel « ${row.text} » présent, échéance ${row.remind_at.toISOString()}`,
        }),
      );
    },
  });
}
