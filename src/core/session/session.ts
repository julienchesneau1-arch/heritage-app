/**
 * Mémoire de travail (M1).
 *
 * Référence : `00 §14`, migration 0003.
 *
 * Ce qui se dit dans une conversation n'est PAS une mémoire durable. Les tours
 * vivent ici, séparés de `memories`, et n'y accèdent que par le Memory Guard.
 * Sans cette séparation, chaque phrase prononcée deviendrait un fait personnel.
 *
 * Les tours servent surtout à la résolution de référents : « celui-ci », « le
 * projet », « Pierre » quand trois Pierre sont connus. C'est le contexte récent
 * qui permet de trancher — sur preuve, pas sur heuristique (`03`, 05/A3).
 */
import type { Db } from '../db/client.js';
import type { Mode, Provenance } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { ConversationTurn } from '../context/packet.js';

export interface Session {
  readonly id: string;
  readonly mode: Mode;
}

export interface TurnInput {
  readonly speaker: 'USER' | 'JARVIS';
  readonly content: string;
  /** Provenance du tour : un contenu externe lu à voix haute reste externe. */
  readonly provenance?: Provenance;
  readonly mentionedEntityIds?: readonly string[];
}

export interface SessionStore {
  start(mode?: Mode): Promise<Result<Session>>;
  appendTurn(sessionId: string, turn: TurnInput): Promise<Result<number>>;
  recentTurns(
    sessionId: string,
    limit?: number,
  ): Promise<Result<readonly ConversationTurn[]>>;
  end(sessionId: string): Promise<Result<void>>;
}

export function createSessionStore(db: Db): SessionStore {
  return {
    async start(mode: Mode = 'NORMAL'): Promise<Result<Session>> {
      const inserted = await db.query<{ id: string; mode: string }>(
        'INSERT INTO sessions (mode) VALUES ($1) RETURNING id, mode',
        [mode],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        return err(jarvisError('INTERNAL', 'Session sans ligne retournée'));
      }
      return ok({ id: row.id, mode: row.mode as Mode });
    },

    async appendTurn(
      sessionId: string,
      turn: TurnInput,
    ): Promise<Result<number>> {
      // L'index du tour est calculé en base : deux ajouts concurrents ne
      // peuvent pas produire le même numéro (contrainte d'unicité).
      const inserted = await db.query<{ turn_index: number }>(
        `INSERT INTO session_turns
           (session_id, turn_index, speaker, content, provenance, mentioned_entity_ids)
         VALUES (
           $1,
           (SELECT COALESCE(max(turn_index) + 1, 0) FROM session_turns WHERE session_id = $1),
           $2, $3, $4, $5::uuid[]
         )
         RETURNING turn_index`,
        [
          sessionId,
          turn.speaker,
          turn.content,
          turn.provenance ?? 'USER',
          [...(turn.mentionedEntityIds ?? [])],
        ],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        return err(jarvisError('INTERNAL', 'Tour sans index retourné'));
      }
      return ok(row.turn_index);
    },

    async recentTurns(
      sessionId: string,
      limit = 10,
    ): Promise<Result<readonly ConversationTurn[]>> {
      const rows = await db.query<{
        turn_index: number;
        speaker: string;
        content: string;
      }>(
        `SELECT turn_index, speaker, content FROM session_turns
          WHERE session_id = $1 ORDER BY turn_index DESC LIMIT $2`,
        [sessionId, limit],
      );
      if (!rows.ok) return rows;

      // Rendus dans l'ordre chronologique : le paquet de contexte garde les
      // plus récents, mais les présente dans le sens de la lecture.
      return ok(
        rows.value.rows
          .map((r) => ({
            turnIndex: r.turn_index,
            speaker: r.speaker as 'USER' | 'JARVIS',
            content: r.content,
          }))
          .reverse(),
      );
    },

    async end(sessionId: string): Promise<Result<void>> {
      const updated = await db.query(
        'UPDATE sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL',
        [sessionId],
      );
      if (!updated.ok) return updated;
      return ok(undefined);
    },
  };
}
