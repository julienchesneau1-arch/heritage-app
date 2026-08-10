/**
 * LE MONDE EXTÉRIEUR — banc de défaillance, Foundation 3.
 *
 * Ce module est la SEULE source de vérité sur `external_effect_count`.
 *
 * POURQUOI UNE TABLE SÉPARÉE, ET NON UN COMPTEUR EN MÉMOIRE
 * ---------------------------------------------------------
 * Un compteur en mémoire ne survivrait pas à un `kill -9`, et ne serait pas
 * partagé entre processus. Or les deux scénarios les plus dangereux sont
 * exactement ceux-là : plusieurs processus concurrents, et un processus tué en
 * cours d'appel. Le compteur doit donc vivre là où le monde vit — durablement,
 * en dehors du processus qui agit.
 *
 * POURQUOI HORS DE LA TRANSACTION DE L'OPÉRATION
 * ----------------------------------------------
 * C'est la propriété essentielle du banc, et celle qui le rend honnête.
 *
 * Les cinq outils actuels écrivent dans PostgreSQL, dans la même base que le
 * journal d'intention. PostgreSQL les protège donc gratuitement : un
 * `ROLLBACK` annule l'effet ET la trace ensemble. Aucun fournisseur réel
 * n'offre cela. Un email envoyé ne se `ROLLBACK` pas.
 *
 * Les écritures de ce module utilisent donc une connexion PROPRE, jamais celle
 * de l'opération en cours. Un effet enregistré ici est définitif — comme dans
 * le monde. C'est la seule façon de mesurer ce qu'on prétend mesurer.
 *
 * ⚠ Ce fichier est une INFRASTRUCTURE DE TEST. Il ne doit jamais être importé
 *   depuis `src/`. `tests/lab/lab-isolation.test.ts` le vérifie.
 */
import { createDb, type Db } from '../../src/core/db/client.js';

/**
 * Connexion dédiée au monde extérieur.
 *
 * Séparée du pool applicatif à dessein, et pour deux raisons distinctes :
 *
 *  — le monde n'est pas soumis aux transactions de Jarvis, et ne doit pas non
 *    plus lui prendre ses connexions pendant un test à 1 000 appels ;
 *
 *  — elle utilise un RÔLE DIFFÉRENT. Le rôle applicatif n'a pas le droit de
 *    créer de table, et c'est une propriété qu'on tient à conserver. Un
 *    fournisseur externe n'est de toute façon pas joignable avec les
 *    identifiants de Jarvis : le banc est plus fidèle ainsi.
 */
export function worldDb(poolMax = 30): Db {
  const password = process.env['JARVIS_DB_OWNER_PASSWORD'];
  if (password === undefined || password === '') {
    throw new Error(
      'JARVIS_DB_OWNER_PASSWORD absent : le monde du banc exige le rôle propriétaire.',
    );
  }
  return createDb({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_OWNER_USER'] ?? 'jarvis_owner',
    password,
    poolMax,
  });
}

/**
 * Crée la table du monde si elle n'existe pas.
 *
 * Volontairement PAS une migration : le monde extérieur est un artefact de
 * test. L'introduire dans `infrastructure/db/migrations` reviendrait à livrer
 * en production une table dont l'unique raison d'être est de mesurer nos
 * propres pannes.
 */
export async function createWorld(db: Db): Promise<void> {
  const created = await db.query(`
    CREATE TABLE IF NOT EXISTS lab_world_effects (
      id            BIGSERIAL PRIMARY KEY,
      operation_key TEXT NOT NULL,
      provider_id   TEXT NOT NULL,
      target        TEXT NOT NULL DEFAULT '-',
      payload       TEXT NOT NULL,
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);
  if (!created.ok) throw new Error(created.error.message);

  const indexed = await db.query(`
    CREATE INDEX IF NOT EXISTS lab_world_effects_key_idx
      ON lab_world_effects (operation_key)
  `);
  if (!indexed.ok) throw new Error(indexed.error.message);
}

/** Efface le monde. Entre deux scénarios, jamais pendant. */
export async function resetWorld(db: Db): Promise<void> {
  const cleared = await db.query('TRUNCATE lab_world_effects');
  if (!cleared.ok) throw new Error(cleared.error.message);
}

/**
 * Produit un effet externe IRRÉVERSIBLE.
 *
 * Le seul endroit du banc qui a le droit d'écrire dans le monde. Un effet
 * enregistré ici ne peut plus être défait — c'est le point.
 */
export async function commitEffect(
  db: Db,
  effect: {
    operationKey: string;
    providerId: string;
    payload: string;
    target?: string;
  },
): Promise<void> {
  const written = await db.query(
    `INSERT INTO lab_world_effects (operation_key, provider_id, target, payload)
     VALUES ($1, $2, $3, $4)`,
    [
      effect.operationKey,
      effect.providerId,
      effect.target ?? '-',
      effect.payload,
    ],
  );
  if (!written.ok) throw new Error(written.error.message);
}

/**
 * LA MESURE FONDAMENTALE.
 *
 * Combien de fois le monde a-t-il réellement changé pour cette clé ?
 * Tout le sprint se ramène à ce nombre.
 */
export async function externalEffectCount(
  db: Db,
  operationKey: string,
): Promise<number> {
  const counted = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM lab_world_effects WHERE operation_key = $1',
    [operationKey],
  );
  if (!counted.ok) throw new Error(counted.error.message);
  return Number(counted.value.rows[0]?.n ?? '0');
}

/** Effets d'une clé, dans l'ordre. Sert aux diagnostics quand `≤ 1` est violé. */
export async function effectsFor(
  db: Db,
  operationKey: string,
): Promise<readonly { providerId: string; target: string; payload: string }[]> {
  const rows = await db.query<{
    provider_id: string;
    target: string;
    payload: string;
  }>(
    `SELECT provider_id, target, payload FROM lab_world_effects
      WHERE operation_key = $1 ORDER BY id`,
    [operationKey],
  );
  if (!rows.ok) throw new Error(rows.error.message);
  return rows.value.rows.map((r) => ({
    providerId: r.provider_id,
    target: r.target,
    payload: r.payload,
  }));
}

/** Nombre d'effets produits par un fournisseur donné, toutes clés confondues. */
export async function effectCountByProvider(
  db: Db,
  providerId: string,
): Promise<number> {
  const counted = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM lab_world_effects WHERE provider_id = $1',
    [providerId],
  );
  if (!counted.ok) throw new Error(counted.error.message);
  return Number(counted.value.rows[0]?.n ?? '0');
}
