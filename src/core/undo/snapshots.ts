/**
 * Capture d'état antérieur — fondation de l'Undo Engine.
 *
 * Référence : 09 §2.1, proposition n°6.
 *
 * > « Jarvis, déplace mon rendez-vous de jeudi à vendredi. » → « Déplacé. »
 * > puis, plus tard : « Annule la dernière action. »
 *
 * CE MODULE N'ANNULE RIEN. Il capture de quoi annuler.
 *
 * La distinction est le sujet : l'INTERFACE d'annulation peut arriver dans six
 * mois sans rien coûter, mais une action exécutée sans capture est
 * définitivement non annulable. Chaque jour d'usage sans capture produit des
 * actions irréversibles par construction.
 *
 * DEUX MÉCANIQUES
 * ---------------
 *   INVERSE_OPERATION — création. Annuler = supprimer. On stocke l'appel
 *                       inverse ; aucune donnée métier n'est copiée.
 *   STATE_RESTORE     — modification. Annuler exige les anciennes valeurs :
 *                       là, et seulement là, on les copie.
 *
 * Cette distinction évite de dupliquer le contenu de chaque création dans une
 * table technique — avec les problèmes de confidentialité et de suppression
 * que cela poserait (03 §12).
 */
import type { Db } from '../db/client.js';
import type { PrivacyClass } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

/**
 * Durée de vie d'un instantané.
 *
 * Un instantané n'est pas un archivage. Sans expiration, la table deviendrait
 * une copie permanente et non gouvernée de la base — exactement ce que `03 §12`
 * cherche à éviter.
 */
export const SNAPSHOT_TTL_DAYS = 7;

export type UndoKind = 'INVERSE_OPERATION' | 'STATE_RESTORE' | 'NOT_UNDOABLE';

export interface SnapshotInput {
  readonly operationId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly undoKind: UndoKind;
  /** Pour INVERSE_OPERATION : l'appel qui défait. */
  readonly inverseToolId?: string;
  readonly inverseInput?: unknown;
  /** Pour STATE_RESTORE : les valeurs antérieures. */
  readonly priorState?: unknown;
  readonly privacyClass?: PrivacyClass;
}

export interface Snapshot {
  readonly id: string;
  readonly operationId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly undoKind: UndoKind;
  readonly inverseToolId: string | null;
  readonly inverseInput: unknown;
  readonly priorState: unknown;
  readonly privacyClass: PrivacyClass;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

interface SnapshotRow {
  id: string;
  operation_id: string;
  resource_kind: string;
  resource_id: string;
  undo_kind: string;
  inverse_tool_id: string | null;
  inverse_input: unknown;
  prior_state: unknown;
  privacy_class: string;
  created_at: Date;
  undone_at: Date | null;
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    operationId: row.operation_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    undoKind: row.undo_kind as UndoKind,
    inverseToolId: row.inverse_tool_id,
    inverseInput: row.inverse_input,
    priorState: row.prior_state,
    privacyClass: row.privacy_class as PrivacyClass,
    createdAt: row.created_at.toISOString(),
    undoneAt: row.undone_at?.toISOString() ?? null,
  };
}

const SELECT_COLUMNS = `
  id, operation_id, resource_kind, resource_id, undo_kind, inverse_tool_id,
  inverse_input, prior_state, privacy_class, created_at, undone_at
`;

export interface SnapshotStore {
  capture(input: SnapshotInput): Promise<Result<Snapshot>>;
  /** Le dernier instantané annulable non encore annulé. */
  lastUndoable(): Promise<Result<Snapshot | null>>;
  forOperation(operationId: string): Promise<Result<Snapshot | null>>;
  markUndone(id: string, undoOperationId: string): Promise<Result<void>>;
  /** Supprime les instantanés échus. Renvoie le nombre supprimé. */
  purgeExpired(): Promise<Result<number>>;
}

export function createSnapshotStore(db: Db): SnapshotStore {
  return {
    async capture(input: SnapshotInput): Promise<Result<Snapshot>> {
      // Une capture incomplète est une capture inutilisable. On refuse à
      // l'écriture plutôt que de découvrir le trou au moment d'annuler — la
      // base impose d'ailleurs la même règle.
      if (
        input.undoKind === 'INVERSE_OPERATION' &&
        (input.inverseToolId === undefined || input.inverseInput === undefined)
      ) {
        return err(
          jarvisError(
            'VALIDATION',
            'INVERSE_OPERATION exige inverseToolId et inverseInput.',
            { operationId: input.operationId },
          ),
        );
      }
      if (input.undoKind === 'STATE_RESTORE' && input.priorState === undefined) {
        return err(
          jarvisError(
            'VALIDATION',
            'STATE_RESTORE exige priorState.',
            { operationId: input.operationId },
          ),
        );
      }

      const expiresAt = new Date(
        Date.now() + SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      const inserted = await db.query<SnapshotRow>(
        `INSERT INTO action_snapshots (
           operation_id, resource_kind, resource_id, undo_kind,
           inverse_tool_id, inverse_input, prior_state, privacy_class, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.operationId,
          input.resourceKind,
          input.resourceId,
          input.undoKind,
          input.inverseToolId ?? null,
          input.inverseInput === undefined
            ? null
            : JSON.stringify(input.inverseInput),
          input.priorState === undefined
            ? null
            : JSON.stringify(input.priorState),
          input.privacyClass ?? 'ORANGE',
          expiresAt,
        ],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        return err(jarvisError('INTERNAL', 'Instantané sans ligne retournée'));
      }
      return ok(toSnapshot(row));
    },

    async lastUndoable(): Promise<Result<Snapshot | null>> {
      const rows = await db.query<SnapshotRow>(
        `SELECT ${SELECT_COLUMNS} FROM action_snapshots
          WHERE undone_at IS NULL
            AND undo_kind <> 'NOT_UNDOABLE'
            AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      return ok(row === undefined ? null : toSnapshot(row));
    },

    async forOperation(operationId: string): Promise<Result<Snapshot | null>> {
      const rows = await db.query<SnapshotRow>(
        `SELECT ${SELECT_COLUMNS} FROM action_snapshots WHERE operation_id = $1`,
        [operationId],
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      return ok(row === undefined ? null : toSnapshot(row));
    },

    async markUndone(id: string, undoOperationId: string): Promise<Result<void>> {
      const updated = await db.query(
        `UPDATE action_snapshots
            SET undone_at = now(), undo_operation_id = $2
          WHERE id = $1 AND undone_at IS NULL`,
        [id, undoOperationId],
      );
      if (!updated.ok) return updated;
      if (updated.value.rowCount === 0) {
        return err(
          jarvisError('CONFLICT', 'Instantané introuvable ou déjà annulé.', {
            snapshotId: id,
          }),
        );
      }
      return ok(undefined);
    },

    async purgeExpired(): Promise<Result<number>> {
      const deleted = await db.query(
        'DELETE FROM action_snapshots WHERE expires_at <= now()',
      );
      if (!deleted.ok) return deleted;
      return ok(deleted.value.rowCount ?? 0);
    },
  };
}
