/**
 * Memory Inbox.
 *
 * Référence : 09 §2.1, proposition n°9.
 *
 * Avant : une préférence non confirmée était refusée, donc **perdue**. Jarvis
 * ne pouvait jamais dire « j'ai remarqué ceci, dois-je le retenir ? ».
 *
 * Maintenant : elle attend. C'est la différence entre un système qui apprend
 * ce qu'on lui confirme et un système qui apprend n'importe quelle phrase
 * ponctuelle — sans jamais rien apprendre du tout entre les deux.
 *
 * L'interface de confirmation n'existe pas encore ; la FILE, si. C'est elle
 * qui ne se rattrape pas : chaque observation non capturée avant l'ajout de
 * l'Inbox est définitivement perdue.
 */
import type { Db } from '../db/client.js';
import type {
  DataCategory,
  PrivacyClass,
  SourceType,
} from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import { contentDigest, type MemoryCandidate, type MemoryType } from './types.js';

/**
 * Durée de vie d'un candidat non traité.
 *
 * Une Inbox qui gonfle indéfiniment cesse d'être consultée, donc cesse de
 * servir. Trente jours : assez pour qu'une observation reste pertinente, assez
 * court pour que la file reste lisible.
 */
export const CANDIDATE_TTL_DAYS = 30;

export interface CandidateProposal {
  readonly content: string;
  readonly memoryType: MemoryType;
  readonly sourceType: SourceType;
  readonly source: string;
  readonly dataCategory: DataCategory;
  readonly privacyClass: PrivacyClass;
  readonly suggestedConfidence: number;
  readonly subjectEntityId: string | null;
  readonly provenance: string;
}

interface CandidateRow {
  id: string;
  content: string;
  memory_type: string;
  source_type: string;
  source: string;
  data_category: string;
  privacy_class: string;
  suggested_confidence: number;
  subject_entity_id: string | null;
  state: string;
  created_at: Date;
  expires_at: Date;
  resulting_memory_id: string | null;
}

function toCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    content: row.content,
    memoryType: row.memory_type as MemoryType,
    sourceType: row.source_type as SourceType,
    source: row.source,
    dataCategory: row.data_category as DataCategory,
    privacyClass: row.privacy_class as PrivacyClass,
    suggestedConfidence: row.suggested_confidence,
    subjectEntityId: row.subject_entity_id,
    state: row.state as MemoryCandidate['state'],
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    resultingMemoryId: row.resulting_memory_id,
  };
}

const SELECT_COLUMNS = `
  id, content, memory_type, source_type, source, data_category, privacy_class,
  suggested_confidence, subject_entity_id, state, created_at, expires_at,
  resulting_memory_id
`;

export interface MemoryInbox {
  /** Dépose un candidat. Idempotent : une observation répétée n'en crée qu'un. */
  enqueue(proposal: CandidateProposal): Promise<Result<MemoryCandidate>>;
  pending(limit?: number): Promise<Result<readonly MemoryCandidate[]>>;
  /**
   * COMBIEN il y en a — pas combien on en a lu. ADR-064.
   *
   * `diagnosticReport` répondait « combien de candidats en attente ? » par
   * `pending(1000).length`. Au-delà de mille, il aurait répondu « 1000 » sans
   * le dire : un plafond de lecture rendu comme un décompte.
   *
   * Le compte se fait donc en SQL, où il ne dépend d'aucune limite de lignes.
   * Même geste que `Ledger.dayTally` — on ne signale pas la troncature, on la
   * rend impossible.
   */
  pendingCount(): Promise<Result<number>>;
  get(id: string): Promise<Result<MemoryCandidate | null>>;
  /** Marque un candidat confirmé et le relie à la mémoire créée. */
  confirm(id: string, memoryId: string): Promise<Result<void>>;
  reject(id: string): Promise<Result<void>>;
  /** Passe les candidats échus à EXPIRED. Renvoie le nombre traité. */
  expireStale(): Promise<Result<number>>;
}

export function createMemoryInbox(db: Db): MemoryInbox {
  return {
    async enqueue(
      proposal: CandidateProposal,
    ): Promise<Result<MemoryCandidate>> {
      const digest = contentDigest(proposal.memoryType, proposal.content);
      /* Frappée par la base, jamais par le processus — ADR-037. Même défaut
         que pour les instantanés : l'échéance était écrite avec l'horloge
         applicative et relue avec celle de la base (ligne 163). */

      // `ON CONFLICT DO NOTHING` sur l'index partiel des candidats PENDING :
      // la même observation répétée dix fois ne remplit pas la file de dix
      // cartes identiques.
      const inserted = await db.query<CandidateRow>(
        `INSERT INTO memory_candidates (
           content, memory_type, source_type, source, provenance,
           privacy_class, data_category, suggested_confidence,
           subject_entity_id, content_digest, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   clock_timestamp() + ($11 || ' days')::interval)
         ON CONFLICT (content_digest, memory_type)
           WHERE state = 'PENDING' DO NOTHING
         RETURNING ${SELECT_COLUMNS}`,
        [
          proposal.content,
          proposal.memoryType,
          proposal.sourceType,
          proposal.source,
          proposal.provenance,
          proposal.privacyClass,
          proposal.dataCategory,
          proposal.suggestedConfidence,
          proposal.subjectEntityId,
          digest,
          String(CANDIDATE_TTL_DAYS),
        ],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row !== undefined) return ok(toCandidate(row));

      // Conflit : le candidat existait déjà. On renvoie l'existant plutôt
      // qu'une erreur — déposer deux fois la même observation n'est pas un
      // échec du point de vue de l'appelant.
      const existing = await db.query<CandidateRow>(
        `SELECT ${SELECT_COLUMNS} FROM memory_candidates
          WHERE content_digest = $1 AND memory_type = $2 AND state = 'PENDING'
          LIMIT 1`,
        [digest, proposal.memoryType],
      );
      if (!existing.ok) return existing;

      const found = existing.value.rows[0];
      if (found === undefined) {
        return err(
          jarvisError('INTERNAL', 'Candidat en conflit puis introuvable'),
        );
      }
      return ok(toCandidate(found));
    },

    async pending(limit = 20): Promise<Result<readonly MemoryCandidate[]>> {
      const rows = await db.query<CandidateRow>(
        `SELECT ${SELECT_COLUMNS} FROM memory_candidates
          WHERE state = 'PENDING' AND expires_at > now()
          ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      if (!rows.ok) return rows;
      return ok(rows.value.rows.map(toCandidate));
    },

    async pendingCount(): Promise<Result<number>> {
      /* MÊME PRÉDICAT QUE `pending`, MOT POUR MOT — `state = 'PENDING'` et
         `expires_at > now()`. Deux définitions de « en attente » finiraient par
         diverger, et le jour où elles divergent aucune ne fait autorité
         (ADR-041) : la liste montrerait des candidats que le compte ignore. */
      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM memory_candidates
          WHERE state = 'PENDING' AND expires_at > now()`,
      );
      if (!rows.ok) return rows;
      const ligne = rows.value.rows[0];
      if (ligne === undefined) {
        return err(jarvisError('INTERNAL', 'Décompte sans ligne rendue'));
      }
      return ok(Number(ligne.n));
    },

    async get(id: string): Promise<Result<MemoryCandidate | null>> {
      const rows = await db.query<CandidateRow>(
        `SELECT ${SELECT_COLUMNS} FROM memory_candidates WHERE id = $1`,
        [id],
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      return ok(row === undefined ? null : toCandidate(row));
    },

    async confirm(id: string, memoryId: string): Promise<Result<void>> {
      const updated = await db.query(
        `UPDATE memory_candidates
            SET state = 'CONFIRMED', decided_at = now(), resulting_memory_id = $2
          WHERE id = $1 AND state = 'PENDING'`,
        [id, memoryId],
      );
      if (!updated.ok) return updated;
      if (updated.value.rowCount === 0) {
        return err(
          jarvisError(
            'CONFLICT',
            'Candidat introuvable ou déjà décidé.',
            { candidateId: id },
          ),
        );
      }
      return ok(undefined);
    },

    async reject(id: string): Promise<Result<void>> {
      const updated = await db.query(
        `UPDATE memory_candidates
            SET state = 'REJECTED', decided_at = now()
          WHERE id = $1 AND state = 'PENDING'`,
        [id],
      );
      if (!updated.ok) return updated;
      if (updated.value.rowCount === 0) {
        return err(
          jarvisError('CONFLICT', 'Candidat introuvable ou déjà décidé.', {
            candidateId: id,
          }),
        );
      }
      return ok(undefined);
    },

    async expireStale(): Promise<Result<number>> {
      const updated = await db.query(
        `UPDATE memory_candidates
            SET state = 'EXPIRED', decided_at = now()
          WHERE state = 'PENDING' AND expires_at <= now()`,
      );
      if (!updated.ok) return updated;
      return ok(updated.value.rowCount ?? 0);
    },
  };
}
