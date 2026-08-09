/**
 * Recherche hybride — trois voies, fusion RRF.
 *
 * Référence : ADR-002.
 *
 *   « Quelle est la référence de mon carrelage ? »  → voie STRUCTURÉE
 *   « Qu'avait-on décidé pour la déco ? »           → voies LEXICALE + SÉMANTIQUE
 *
 * La voie structurée est toujours tentée en premier et ses résultats ne
 * passent pas par la fusion : une réponse exacte n'a pas à être départagée par
 * un score de similarité.
 *
 * DÉGRADATION GRACIEUSE — la voie sémantique est la seule à dépendre d'un
 * modèle. Quand ce modèle est indisponible (réseau coupé, service arrêté), les
 * deux autres voies continuent et le résultat le signale. C'est ce qui rend
 * vraie l'exigence « recherche mémoire fonctionnelle réseau coupé » (02,
 * Phase 1) au lieu de la supposer.
 */
import type { Db } from '../db/client.js';
import type { EmbeddingProvider } from '../../providers/contract.js';
import { ok, type Result } from '../types/result.js';
import { toStoredMemory, type MemoryRow } from './store.js';
import type { MemoryType, StoredMemory } from './types.js';

export type Lane = 'STRUCTURED' | 'LEXICAL' | 'SEMANTIC';

export interface LaneHit {
  readonly memory: StoredMemory;
  /** Score propre à la voie. Non comparable entre voies — d'où RRF. */
  readonly score: number;
  readonly rank: number;
}

export interface LaneResult {
  readonly lane: Lane;
  readonly available: boolean;
  readonly hits: readonly LaneHit[];
  readonly elapsedMs: number;
  /** Renseigné quand `available` est faux. */
  readonly unavailableReason?: string;
}

export interface HybridResult {
  /** Résultat fusionné, prêt à être présenté. */
  readonly merged: readonly { memory: StoredMemory; rrfScore: number; lanes: readonly Lane[] }[];
  /** Chaque voie séparément — exigé par la porte de sortie Phase 1. */
  readonly lanes: readonly LaneResult[];
  readonly degraded: boolean;
}

export interface MemoryQuery {
  readonly text: string;
  /** Restreint la voie structurée à des entités précises. */
  readonly entityIds?: readonly string[];
  readonly memoryTypes?: readonly MemoryType[];
  readonly limit?: number;
}

const SELECT_COLUMNS = `
  m.id, m.kind, m.memory_type, m.content, m.confidence, m.source, m.provenance,
  m.privacy_class, m.state, m.subject_entity_id, m.created_at,
  m.last_verified_at, m.expires_at, (m.embedding IS NOT NULL) AS has_embedding
`;

/**
 * Constante de Reciprocal Rank Fusion.
 *
 * 60 est la valeur de la littérature d'origine. Elle amortit l'écart entre les
 * premiers rangs : un document premier sur une voie et absent de l'autre ne
 * doit pas écraser un document deuxième partout.
 */
const RRF_K = 60;

export interface HybridSearch {
  search(query: MemoryQuery): Promise<Result<HybridResult>>;
}

export function createHybridSearch(
  db: Db,
  embeddings: EmbeddingProvider | null,
): HybridSearch {
  /* ---------------------------------------------------------------------- */
  /* Voie 1 — structurée                                                    */
  /* ---------------------------------------------------------------------- */
  async function structuredLane(query: MemoryQuery): Promise<LaneResult> {
    const started = Date.now();
    const entityIds = query.entityIds ?? [];

    if (entityIds.length === 0 && query.memoryTypes === undefined) {
      return {
        lane: 'STRUCTURED',
        available: true,
        hits: [],
        elapsedMs: Date.now() - started,
      };
    }

    const rows = await db.query<MemoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM memories m
        WHERE m.state = 'ACTIVE'
          AND ($1::uuid[] = '{}' OR m.subject_entity_id = ANY($1::uuid[]))
          AND ($2::text[] IS NULL OR m.memory_type = ANY($2::text[]))
        ORDER BY m.confidence DESC, m.created_at DESC
        LIMIT $3`,
      [
        entityIds,
        query.memoryTypes === undefined ? null : [...query.memoryTypes],
        query.limit ?? 10,
      ],
    );

    if (!rows.ok) {
      return {
        lane: 'STRUCTURED',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason: rows.error.message,
      };
    }

    return {
      lane: 'STRUCTURED',
      available: true,
      hits: rows.value.rows.map((row, index) => ({
        memory: toStoredMemory(row),
        score: row.confidence,
        rank: index + 1,
      })),
      elapsedMs: Date.now() - started,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Voie 2 — lexicale                                                      */
  /* ---------------------------------------------------------------------- */
  async function lexicalLane(query: MemoryQuery): Promise<LaneResult> {
    const started = Date.now();

    // `websearch_to_tsquery` tolère une saisie naturelle (guillemets, OR, -)
    // sans lever d'erreur de syntaxe, contrairement à `to_tsquery`. Sur une
    // entrée utilisateur, c'est la seule variante utilisable.
    const rows = await db.query<MemoryRow & { rank: number }>(
      `SELECT ${SELECT_COLUMNS},
              ts_rank(m.search_vector, websearch_to_tsquery('french', $1)) AS rank
         FROM memories m
        WHERE m.state = 'ACTIVE'
          AND m.search_vector @@ websearch_to_tsquery('french', $1)
        ORDER BY rank DESC, m.confidence DESC
        LIMIT $2`,
      [query.text, query.limit ?? 10],
    );

    if (!rows.ok) {
      return {
        lane: 'LEXICAL',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason: rows.error.message,
      };
    }

    return {
      lane: 'LEXICAL',
      available: true,
      hits: rows.value.rows.map((row, index) => ({
        memory: toStoredMemory(row),
        score: row.rank,
        rank: index + 1,
      })),
      elapsedMs: Date.now() - started,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Voie 3 — sémantique                                                    */
  /* ---------------------------------------------------------------------- */
  async function semanticLane(query: MemoryQuery): Promise<LaneResult> {
    const started = Date.now();

    if (embeddings === null) {
      return {
        lane: 'SEMANTIC',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason:
          'Aucun fournisseur d\'embeddings configuré. Les voies structurée et ' +
          'lexicale restent opérationnelles.',
      };
    }

    const vector = await embeddings.embed([query.text]);
    if (!vector.ok) {
      return {
        lane: 'SEMANTIC',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason: `Fournisseur d'embeddings indisponible : ${vector.error.message}`,
      };
    }

    const first = vector.value[0];
    if (first === undefined) {
      return {
        lane: 'SEMANTIC',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason: 'Le fournisseur d\'embeddings n\'a rien renvoyé.',
      };
    }

    const literal = `[${first.join(',')}]`;
    const rows = await db.query<MemoryRow & { distance: number }>(
      `SELECT ${SELECT_COLUMNS},
              (m.embedding <=> $1::vector) AS distance
         FROM memories m
        WHERE m.state = 'ACTIVE'
          AND m.embedding IS NOT NULL
          AND m.embedding_model = $2
        ORDER BY m.embedding <=> $1::vector
        LIMIT $3`,
      [literal, embeddings.model, query.limit ?? 10],
    );

    if (!rows.ok) {
      return {
        lane: 'SEMANTIC',
        available: false,
        hits: [],
        elapsedMs: Date.now() - started,
        unavailableReason: rows.error.message,
      };
    }

    return {
      lane: 'SEMANTIC',
      available: true,
      hits: rows.value.rows.map((row, index) => ({
        memory: toStoredMemory(row),
        score: 1 - row.distance, // distance cosinus → similarité
        rank: index + 1,
      })),
      elapsedMs: Date.now() - started,
    };
  }

  return {
    async search(query: MemoryQuery): Promise<Result<HybridResult>> {
      const [structured, lexical, semantic] = await Promise.all([
        structuredLane(query),
        lexicalLane(query),
        semanticLane(query),
      ]);

      /* --- Fusion ------------------------------------------------------- */
      // Seules les voies lexicale et sémantique sont fusionnées (ADR-002).
      // RRF ne s'appuie que sur le RANG, jamais sur le score absolu : c'est ce
      // qui rend tolérable la faiblesse connue de `ts_rank` face à BM25.
      const scores = new Map<
        string,
        { memory: StoredMemory; rrfScore: number; lanes: Lane[] }
      >();

      for (const lane of [lexical, semantic]) {
        if (!lane.available) continue;
        for (const hit of lane.hits) {
          const entry = scores.get(hit.memory.id) ?? {
            memory: hit.memory,
            rrfScore: 0,
            lanes: [],
          };
          entry.rrfScore += 1 / (RRF_K + hit.rank);
          entry.lanes.push(lane.lane);
          scores.set(hit.memory.id, entry);
        }
      }

      const fused = [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);

      // La voie structurée passe devant : une réponse exacte n'est pas
      // départagée par une similarité.
      const structuredIds = new Set(structured.hits.map((h) => h.memory.id));
      const merged = [
        ...structured.hits.map((h) => ({
          memory: h.memory,
          rrfScore: Number.POSITIVE_INFINITY,
          lanes: ['STRUCTURED'] as Lane[],
        })),
        ...fused.filter((f) => !structuredIds.has(f.memory.id)),
      ].slice(0, query.limit ?? 10);

      return ok({
        merged,
        lanes: [structured, lexical, semantic],
        degraded: !semantic.available,
      });
    },
  };
}
