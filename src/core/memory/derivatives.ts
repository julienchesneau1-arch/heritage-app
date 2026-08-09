/**
 * Registre des dérivés d'une mémoire.
 *
 * Référence : 09 §2.1, proposition n°11, 03 §12.
 *
 * « Oublie ça » doit réellement tout supprimer : mémoire, embedding, entrées
 * d'index, caches, exports.
 *
 * POURQUOI CE REGISTRE EXISTE AVANT D'ÊTRE UTILE
 * ----------------------------------------------
 * Aujourd'hui l'embedding vit sur la même ligne que la mémoire : il disparaît
 * en cascade, et ce registre ne fait que le constater. Ce ne sera plus vrai au
 * premier index externe, au premier cache, au premier export.
 *
 * Le registre existe donc maintenant pour que la garantie de suppression reste
 * vraie quand l'architecture s'étendra — plutôt que de découvrir à ce
 * moment-là qu'on ne sait plus où sont les copies. Un dérivé créé sans être
 * enregistré est un dérivé qu'on ne saura pas retrouver.
 */
import type { Db } from '../db/client.js';
import { ok, type Result } from '../types/result.js';

export type DerivativeKind =
  | 'EMBEDDING'
  | 'INDEX_ENTRY'
  | 'CACHE'
  | 'EXPORT'
  | 'BACKUP';

export interface Derivative {
  readonly id: string;
  readonly memoryId: string;
  readonly kind: DerivativeKind;
  /** Où le trouver : « memories.embedding », un chemin, une clé de cache. */
  readonly locator: string;
  /** Faux = une action explicite est nécessaire pour le supprimer. */
  readonly cascades: boolean;
}

interface DerivativeRow {
  id: string;
  memory_id: string;
  derivative_kind: string;
  locator: string;
  cascades: boolean;
}

function toDerivative(row: DerivativeRow): Derivative {
  return {
    id: row.id,
    memoryId: row.memory_id,
    kind: row.derivative_kind as DerivativeKind,
    locator: row.locator,
    cascades: row.cascades,
  };
}

export interface DerivativeRegistry {
  register(
    memoryId: string,
    kind: DerivativeKind,
    locator: string,
    cascades: boolean,
  ): Promise<Result<void>>;

  listFor(memoryId: string): Promise<Result<readonly Derivative[]>>;

  /**
   * Dérivés exigeant une suppression explicite.
   *
   * C'est la liste que devra traiter le futur Data Lifecycle Manager avant de
   * pouvoir affirmer qu'une mémoire est réellement oubliée.
   */
  requiringManualDeletion(
    memoryId: string,
  ): Promise<Result<readonly Derivative[]>>;
}

export function createDerivativeRegistry(db: Db): DerivativeRegistry {
  return {
    async register(
      memoryId: string,
      kind: DerivativeKind,
      locator: string,
      cascades: boolean,
    ): Promise<Result<void>> {
      const inserted = await db.query(
        `INSERT INTO memory_derivatives (memory_id, derivative_kind, locator, cascades)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (memory_id, derivative_kind, locator) DO NOTHING`,
        [memoryId, kind, locator, cascades],
      );
      if (!inserted.ok) return inserted;
      return ok(undefined);
    },

    async listFor(memoryId: string): Promise<Result<readonly Derivative[]>> {
      const rows = await db.query<DerivativeRow>(
        `SELECT id, memory_id, derivative_kind, locator, cascades
           FROM memory_derivatives WHERE memory_id = $1
          ORDER BY created_at ASC`,
        [memoryId],
      );
      if (!rows.ok) return rows;
      return ok(rows.value.rows.map(toDerivative));
    },

    async requiringManualDeletion(
      memoryId: string,
    ): Promise<Result<readonly Derivative[]>> {
      const rows = await db.query<DerivativeRow>(
        `SELECT id, memory_id, derivative_kind, locator, cascades
           FROM memory_derivatives
          WHERE memory_id = $1 AND cascades = false
          ORDER BY created_at ASC`,
        [memoryId],
      );
      if (!rows.ok) return rows;
      return ok(rows.value.rows.map(toDerivative));
    },
  };
}
