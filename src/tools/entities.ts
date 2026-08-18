/**
 * Outils d'entité : `entity_create` et `entity_delete`.
 *
 * POURQUOI CET OUTIL EXISTE — ADR-071
 * ---------------------------------------------------------------------------
 * `docs/26 §4.12` a établi que le Context Engine n'est **pas atteignable** :
 * `resolver.ts` sait résoudre une mention et un référent anaphorique, mais
 * `entities` n'est peuplée par **aucun `INSERT` de `src/`**. Un résolveur sans
 * rien à résoudre.
 *
 * L'ADR correspondante concluait qu'il fallait une reconnaissance d'entités
 * dans du texte libre — donc un modèle, donc un Tier 1. Et elle écrivait sa
 * propre condition de révision :
 *
 * > *Si un jour la reconnaissance d'entités arrive par un chemin non prévu —
 * > un outil qui crée explicitement une entité **sur demande de
 * > l'utilisateur**, sans modèle — alors A2 se débloquerait sans Tier 1.*
 *
 * C'est ce chemin. **Zéro modèle, zéro euro, zéro dépendance.**
 *
 * CE QUE CET OUTIL NE FAIT PAS, ET C'EST LE POINT
 * -----------------------------------------------
 * Il n'EXTRAIT rien. Il ne devine aucune entité dans une phrase. L'utilisateur
 * nomme ce qu'il veut voir exister, et Jarvis l'enregistre — la déclaration
 * vient de l'humain, jamais d'une inférence.
 *
 * C'est exactement ce qui rend l'outil compatible avec `Tier 0` : la
 * reconnaissance d'entités reste hors de portée, mais la RÉSOLUTION cesse
 * d'être un moteur qui tourne à vide.
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

/**
 * Les genres d'entité, RECOPIÉS DE LA BASE — et vérifiés par un test.
 *
 * La contrainte `CHECK` de `entities.kind` fait autorité. Ce miroir existe pour
 * refuser une valeur invalide AVANT la base, avec un message utile ; le test
 * `entities.test.ts` compare les deux listes, sinon ce serait un second
 * registre du même fait (ADR-041).
 */
export const EntityKind = z.enum([
  'PERSON',
  'ORGANIZATION',
  'PROJECT',
  'PLACE',
  'PRODUCT',
  'DOCUMENT',
  'EVENT',
  'TASK',
  'OBJECT',
  'DEVICE',
  'ACCOUNT',
]);
export type EntityKind = z.infer<typeof EntityKind>;

const EntityCreateInput = z.object({
  displayName: z.string().min(1).max(200),
  kind: EntityKind,
});

interface EntityRow {
  id: string;
  kind: string;
  display_name: string;
}

export function entityCreateTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'entity_create',
      version: '1.0.0',
      description: 'Enregistrer une entité nommée par l’utilisateur.',
      /* `L2` : une ligne locale, réversible, sans effet externe. Le même
         niveau que `note_create` et `task_create`, pour la même raison. */
      autonomy: 'L2',
      privacyClass: 'ORANGE',
      /* Un nom de personne ou d'organisation est une donnée de contact au sens
         de `docs/14` — c'est le plancher qui compte, pas la vocation. */
      dataCategory: 'CONTACT',
      reversible: true,
      networkRequired: false,
      parameters: [
        // Le nom EST la donnée sensible : « Pierre Dupont » en dit plus que le
        // fait qu'une entité existe.
        { name: 'displayName', sensitive: true },
        { name: 'kind', sensitive: false },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'ENTITY_CREATED',
      requiredSecrets: [],
      rollback: 'Supprimer l’entité via entity_delete.',
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: EntityCreateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      const inserted = await ctx.db.query<EntityRow>(
        `INSERT INTO entities (kind, display_name)
         VALUES ($1, $2)
         RETURNING id, kind, display_name`,
        [input.kind, input.displayName],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        return err(jarvisError('INTERNAL', 'Insertion sans ligne retournée'));
      }

      return ok({
        output: { entityId: row.id, kind: row.kind, displayName: row.display_name },
        resource: { kind: 'entity', id: row.id },
        undo: {
          kind: 'INVERSE_OPERATION',
          /* L'inverse est ÉCRIT, pas seulement déclaré. Annoncer un défaire qui
             n'existe pas est la faute qu'ADR-067 vient de corriger cinq fois ;
             la répéter le jour même n'aurait aucune excuse. */
          inverseToolId: 'entity_delete',
          inverseInput: { entityId: row.id },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(
          verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'),
        );
      }
      const found = await ctx.db.query<EntityRow>(
        'SELECT id, kind, display_name FROM entities WHERE id = $1',
        [execution.resource.id],
      );
      if (!found.ok) return found;

      const row = found.value.rows[0];
      if (row === undefined) {
        return ok(
          verificationOutcome.failed({
            observed: `Entité ${execution.resource.id} introuvable après création.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `entité « ${row.display_name} » (${row.kind}) présente`,
        }),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */
/* entity_delete — l'inverse, écrit en même temps                             */
/* -------------------------------------------------------------------------- */

const EntityDeleteInput = z.object({
  entityId: z.uuid(),
});

/**
 * Supprimer une entité.
 *
 * `L4` comme `note_delete` et `memory_forget` : `docs/03` range la suppression
 * irréversible à ce niveau, et la cascade porte loin — `relations` et
 * `entity_aliases` référencent `entities` en `ON DELETE CASCADE`.
 *
 * **Supprimer une entité efface donc aussi ce qu'on savait d'elle.** C'est
 * précisément le genre d'effet qui justifie une confirmation forte.
 */
export function entityDeleteTool(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'entity_delete',
      version: '1.0.0',
      description: 'Supprimer définitivement une entité et ses relations.',
      autonomy: 'L4',
      privacyClass: 'ORANGE',
      dataCategory: 'CONTACT',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'entityId', sensitive: true }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'ENTITY_DELETED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: EntityDeleteInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      const supprime = await ctx.db.query<{ id: string }>(
        'DELETE FROM entities WHERE id = $1 RETURNING id',
        [input.entityId],
      );
      if (!supprime.ok) return supprime;

      return ok({
        output: {
          entityId: input.entityId,
          existait: supprime.value.rows.length > 0,
        },
        resource: { kind: 'entity', id: input.entityId },
        undo: { kind: 'NOT_UNDOABLE' },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      const sortie = execution.output as { entityId: string; existait: boolean };

      if (!sortie.existait) {
        return ok(
          verificationOutcome.notAttempted(
            `Aucune entité ${sortie.entityId} : il n'y avait rien à supprimer.`,
          ),
        );
      }

      const reste = await ctx.db.query<{ id: string }>(
        'SELECT id FROM entities WHERE id = $1',
        [sortie.entityId],
      );
      if (!reste.ok) return reste;

      if (reste.value.rows.length > 0) {
        return ok(
          verificationOutcome.failed({
            observed: `L'entité ${sortie.entityId} est TOUJOURS présente.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }

      return ok(
        verificationOutcome.erased({
          observed: `entité ${sortie.entityId} absente`,
          conclusiveBecause:
            'lecture transactionnelle après commit, aucun effet différé possible',
        }),
      );
    },
  });
}
