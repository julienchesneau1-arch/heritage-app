/**
 * Magasin de mémoires.
 *
 * `insertVerified` porte ce nom pour une raison : il ne doit être appelé que
 * par le Memory Guard, après classification. Toute autre voie d'écriture
 * contournerait 03 §11 et rouvrirait l'empoisonnement de mémoire.
 */
import type { Db } from '../db/client.js';
import type { MemoryKind, PrivacyClass, Provenance } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { MemoryState, MemoryType, StoredMemory } from './types.js';

export interface VerifiedMemory {
  readonly kind: MemoryKind;
  readonly memoryType: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly provenance: Provenance;
  readonly privacyClass: PrivacyClass;
  readonly subjectEntityId: string | null;
  readonly expiresAt: string | null;
  readonly contentDigest: string;
  readonly lastVerifiedAt: string | null;
}

export interface MemoryRow {
  id: string;
  kind: string;
  memory_type: string;
  content: string;
  confidence: number;
  source: string;
  provenance: string;
  privacy_class: string;
  state: string;
  subject_entity_id: string | null;
  created_at: Date;
  last_verified_at: Date | null;
  expires_at: Date | null;
  has_embedding: boolean;
}

export function toStoredMemory(row: MemoryRow): StoredMemory {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    memoryType: row.memory_type as MemoryType,
    content: row.content,
    confidence: row.confidence,
    source: row.source,
    provenance: row.provenance as Provenance,
    privacyClass: row.privacy_class as PrivacyClass,
    state: row.state as MemoryState,
    subjectEntityId: row.subject_entity_id,
    createdAt: row.created_at.toISOString(),
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    hasEmbedding: row.has_embedding,
  };
}

const SELECT_COLUMNS = `
  id, kind, memory_type, content, confidence, source, provenance,
  privacy_class, state, subject_entity_id, created_at, last_verified_at,
  expires_at, (embedding IS NOT NULL) AS has_embedding
`;

export interface MemoryStore {
  insertVerified(memory: VerifiedMemory): Promise<Result<StoredMemory>>;
  findByDigest(
    digest: string,
    memoryType: MemoryType,
  ): Promise<Result<StoredMemory | null>>;
  getById(id: string): Promise<Result<StoredMemory | null>>;
  attachEmbedding(
    id: string,
    embedding: readonly number[],
    model: string,
  ): Promise<Result<void>>;
  setState(id: string, state: MemoryState): Promise<Result<void>>;
  /** Mémoires sans embedding : la file d'attente de la voie sémantique. */
  pendingEmbeddings(limit: number): Promise<Result<readonly StoredMemory[]>>;
}

export function createMemoryStore(db: Db): MemoryStore {
  return {
    async insertVerified(memory: VerifiedMemory): Promise<Result<StoredMemory>> {
      const inserted = await db.query<MemoryRow>(
        `INSERT INTO memories (
           kind, memory_type, content, confidence, source, provenance,
           privacy_class, subject_entity_id, expires_at, content_digest,
           last_verified_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${SELECT_COLUMNS}`,
        [
          memory.kind,
          memory.memoryType,
          memory.content,
          memory.confidence,
          memory.source,
          memory.provenance,
          memory.privacyClass,
          memory.subjectEntityId,
          memory.expiresAt,
          memory.contentDigest,
          memory.lastVerifiedAt,
        ],
      );
      if (!inserted.ok) return inserted;

      const row = inserted.value.rows[0];
      if (row === undefined) {
        return err(jarvisError('INTERNAL', 'Insertion sans ligne retournée'));
      }
      return ok(toStoredMemory(row));
    },

    async findByDigest(
      digest: string,
      memoryType: MemoryType,
    ): Promise<Result<StoredMemory | null>> {
      const rows = await db.query<MemoryRow>(
        `SELECT ${SELECT_COLUMNS} FROM memories
          WHERE content_digest = $1 AND memory_type = $2 AND state <> 'DELETED'
          LIMIT 1`,
        [digest, memoryType],
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      return ok(row === undefined ? null : toStoredMemory(row));
    },

    async getById(id: string): Promise<Result<StoredMemory | null>> {
      const rows = await db.query<MemoryRow>(
        `SELECT ${SELECT_COLUMNS} FROM memories WHERE id = $1`,
        [id],
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      return ok(row === undefined ? null : toStoredMemory(row));
    },

    async attachEmbedding(
      id: string,
      embedding: readonly number[],
      model: string,
    ): Promise<Result<void>> {
      // pgvector accepte la représentation textuelle '[1,2,3]'.
      const literal = `[${embedding.join(',')}]`;
      const updated = await db.query(
        'UPDATE memories SET embedding = $1::vector, embedding_model = $2 WHERE id = $3',
        [literal, model, id],
      );
      if (!updated.ok) return updated;
      return ok(undefined);
    },

    async setState(id: string, state: MemoryState): Promise<Result<void>> {
      const updated = await db.query(
        'UPDATE memories SET state = $1, updated_at = now() WHERE id = $2',
        [state, id],
      );
      if (!updated.ok) return updated;
      return ok(undefined);
    },

    async pendingEmbeddings(
      limit: number,
    ): Promise<Result<readonly StoredMemory[]>> {
      const rows = await db.query<MemoryRow>(
        `SELECT ${SELECT_COLUMNS} FROM memories
          WHERE embedding IS NULL AND state = 'ACTIVE'
          ORDER BY created_at ASC LIMIT $1`,
        [limit],
      );
      if (!rows.ok) return rows;
      return ok(rows.value.rows.map(toStoredMemory));
    },
  };
}
