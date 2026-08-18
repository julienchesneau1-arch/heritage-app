/**
 * Magasin de mémoires.
 *
 * `insertVerified` porte ce nom pour une raison : il ne doit être appelé que
 * par le Memory Guard, après classification. Toute autre voie d'écriture
 * contournerait 03 §11 et rouvrirait l'empoisonnement de mémoire.
 */
import type { Db } from '../db/client.js';
import type {
  DataCategory,
  MemoryKind,
  PrivacyClass,
  Provenance,
  SourceType,
} from '../types/domain.js';
import { createDerivativeRegistry, type Derivative } from './derivatives.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { MemoryState, MemoryType, StoredMemory } from './types.js';

export interface VerifiedMemory {
  readonly kind: MemoryKind;
  readonly memoryType: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly sourceType: SourceType;
  readonly dataCategory: DataCategory;
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
  source_type: string;
  data_category: string;
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
    sourceType: row.source_type as SourceType,
    dataCategory: row.data_category as DataCategory,
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
  id, kind, memory_type, content, confidence, source, source_type,
  data_category, provenance, privacy_class, state, subject_entity_id,
  created_at, last_verified_at, expires_at, (embedding IS NOT NULL) AS has_embedding
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
  /**
   * EFFACER POUR DE BON — `docs/05 §C3`, ADR-065.
   *
   * Un `DELETE`, pas un `state = 'DELETED'`. L'effacement doux laisserait
   * `content` dans la ligne : annoncer « oublié » serait alors une fausse
   * confirmation portant sur une promesse de confidentialité.
   *
   * L'embedding est une COLONNE de `memories` et `memory_derivatives` porte
   * `ON DELETE CASCADE` : la ligne emporte l'un et l'autre. Ce qui ne part pas
   * ainsi — export, sauvegarde, cache externe — est justement ce que
   * `derivativesRequiringManualDeletion` sert à nommer AVANT.
   *
   * Rend `true` si une ligne a été supprimée, `false` s'il n'y avait rien.
   * L'appelant a besoin de la différence : effacer ce qui n'existait pas n'est
   * pas un oubli, c'est un non-événement, et l'annoncer comme un succès serait
   * revendiquer un acte qui n'a pas eu lieu.
   */
  deleteForever(id: string): Promise<Result<boolean>>;
  /** Dérivés qu'aucune cascade n'emporte — la liste à traiter à la main. */
  derivativesRequiringManualDeletion(
    id: string,
  ): Promise<Result<readonly Derivative[]>>;
}

export function createMemoryStore(db: Db): MemoryStore {
  // Le registre des dérivés est interne au magasin : tout artefact dérivé doit
  // être enregistré au moment où il est créé, pas dans un second temps que
  // quelqu'un pourrait oublier (09 §2.1).
  const derivatives = createDerivativeRegistry(db);

  return {
    async insertVerified(memory: VerifiedMemory): Promise<Result<StoredMemory>> {
      const inserted = await db.query<MemoryRow>(
        `INSERT INTO memories (
           kind, memory_type, content, confidence, source, source_type,
           data_category, provenance, privacy_class, subject_entity_id,
           expires_at, content_digest, last_verified_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${SELECT_COLUMNS}`,
        [
          memory.kind,
          memory.memoryType,
          memory.content,
          memory.confidence,
          memory.source,
          memory.sourceType,
          memory.dataCategory,
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

      // L'embedding vit aujourd'hui sur la même ligne que la mémoire, donc il
      // disparaît en cascade. On l'enregistre malgré tout : le jour où un
      // index externe apparaîtra, la garantie de suppression ne dépendra pas
      // de la mémoire qu'aura quelqu'un de cette particularité.
      const registered = await derivatives.register(
        id,
        'EMBEDDING',
        `memories.embedding (${model})`,
        true,
      );
      if (!registered.ok) return registered;

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

    async derivativesRequiringManualDeletion(
      id: string,
    ): Promise<Result<readonly Derivative[]>> {
      return derivatives.requiringManualDeletion(id);
    },

    async deleteForever(id: string): Promise<Result<boolean>> {
      /* `RETURNING id` PLUTÔT QUE `rowCount`. On veut distinguer « j'ai effacé »
         de « il n'y avait rien », et le second ne doit jamais s'annoncer comme
         un oubli réussi : revendiquer un acte qui n'a pas eu lieu est la faute
         que ce dépôt traque partout ailleurs. */
      const supprime = await db.query<{ id: string }>(
        'DELETE FROM memories WHERE id = $1 RETURNING id',
        [id],
      );
      if (!supprime.ok) return supprime;
      return ok(supprime.value.rows.length > 0);
    },
  };
}
