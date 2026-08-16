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

  /* ══════════════════════════════════════════════════════════════════════
     LE SECOND MONDE — `docs/22 §4`.

     `lab_world_effects` dit que LE MONDE A CHANGÉ. Cette table-ci dit ce que
     LE FOURNISSEUR A VÉCU, instant par instant.

         JARVIS                          LE BANC
       ─────────────────           ──────────────────────
       requête émise               request_received_at
       réponse │ timeout           effect_started_at
       HTTP 500 │ 429              effect_committed_at
       connexion coupée            response_sent_at · réponse réellement émise

     Jarvis n'a JAMAIS accès à la colonne de droite. Le banc, si — et c'est ce
     qui lui permet de juger l'HONNÊTETÉ de Jarvis plutôt que sa conformité à
     un scénario. Sans elle, « requête jamais reçue » et « effet produit,
     réponse perdue » sont indiscernables Y COMPRIS POUR LE BANC, qui perdrait
     alors toute capacité de trancher.

     La propriété que seule cette table permet d'énoncer :

       > Jarvis avait RAISON de dire UNKNOWN alors que l'effet avait
       > réellement eu lieu.
     ══════════════════════════════════════════════════════════════════════ */
  const timeline = await db.query(`
    CREATE TABLE IF NOT EXISTS lab_provider_requests (
      id                  BIGSERIAL PRIMARY KEY,
      operation_key       TEXT NOT NULL,
      provider_id         TEXT NOT NULL,
      target              TEXT NOT NULL DEFAULT '-',

      -- LES CINQ INSTANTS de \`docs/22 §6\`. Chacun peut manquer, et c'est
      -- exactement ce qui rend la matrice de pannes ÉNUMÉRABLE plutôt
      -- qu'anecdotique.
      --   t0  requête émise par Jarvis        (côté Jarvis, non enregistré ici)
      --   t1  requête reçue par le fournisseur
      --   t2  effet commencé
      --   t3  effet validé
      --   t4  réponse émise par le fournisseur
      request_received_at TIMESTAMPTZ,
      effect_started_at   TIMESTAMPTZ,
      effect_committed_at TIMESTAMPTZ,
      response_sent_at    TIMESTAMPTZ,

      -- Ce que le fournisseur a RÉELLEMENT répondu, y compris quand Jarvis
      -- ne l'a jamais reçu. C'est la différence entre « il n'a rien dit » et
      -- « je n'ai rien entendu ».
      response_claim      TEXT,
      -- La réponse est-elle parvenue à Jarvis ? \`false\` = perdue en vol.
      response_delivered  BOOLEAN NOT NULL DEFAULT true,

      created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);
  if (!timeline.ok) throw new Error(timeline.error.message);

  const timelineIndex = await db.query(`
    CREATE INDEX IF NOT EXISTS lab_provider_requests_key_idx
      ON lab_provider_requests (operation_key)
  `);
  if (!timelineIndex.ok) throw new Error(timelineIndex.error.message);
}

/** Efface les DEUX mondes. Entre deux scénarios, jamais pendant. */
export async function resetWorld(db: Db): Promise<void> {
  const cleared = await db.query('TRUNCATE lab_world_effects, lab_provider_requests');
  if (!cleared.ok) throw new Error(cleared.error.message);
}

/* -------------------------------------------------------------------------- *
 * LE SECOND MONDE — ce que le banc sait et que Jarvis ne verra jamais
 * -------------------------------------------------------------------------- */

/** Les cinq instants d'une requête, tels que le FOURNISSEUR les a vécus. */
export interface ProviderTimeline {
  readonly operationKey: string;
  readonly providerId: string;
  readonly target: string;
  readonly requestReceivedAt: string | null;
  readonly effectStartedAt: string | null;
  readonly effectCommittedAt: string | null;
  readonly responseSentAt: string | null;
  readonly responseClaim: string | null;
  readonly responseDelivered: boolean;
}

/** Ouvre une ligne de chronologie : le fournisseur a REÇU la demande. */
export async function providerReceived(
  db: Db,
  entry: { operationKey: string; providerId: string; target?: string },
): Promise<number> {
  const opened = await db.query<{ id: string }>(
    `INSERT INTO lab_provider_requests
       (operation_key, provider_id, target, request_received_at)
     VALUES ($1, $2, $3, clock_timestamp())
     RETURNING id`,
    [entry.operationKey, entry.providerId, entry.target ?? '-'],
  );
  if (!opened.ok) throw new Error(opened.error.message);
  const id = opened.value.rows[0]?.id;
  if (id === undefined) throw new Error('chronologie non ouverte');
  return Number(id);
}

/** Marque un instant de la chronologie. Jamais deux fois le même. */
export async function providerMark(
  db: Db,
  id: number,
  instant: 'effect_started_at' | 'effect_committed_at' | 'response_sent_at',
  claim?: { responseClaim?: string; responseDelivered?: boolean },
): Promise<void> {
  /* Le nom de colonne est un LITTÉRAL choisi dans une union fermée, jamais
     une chaîne d'appelant : c'est la seule interpolation SQL du banc, et elle
     est bornée par le typage. */
  const marked = await db.query(
    `UPDATE lab_provider_requests
        SET ${instant} = clock_timestamp(),
            response_claim = COALESCE($2, response_claim),
            response_delivered = COALESCE($3, response_delivered)
      WHERE id = $1`,
    [
      String(id),
      claim?.responseClaim ?? null,
      claim?.responseDelivered ?? null,
    ],
  );
  if (!marked.ok) throw new Error(marked.error.message);
}

/** Ce que LE BANC sait d'une opération — jamais accessible à Jarvis. */
export async function providerTimeline(
  db: Db,
  operationKey: string,
): Promise<readonly ProviderTimeline[]> {
  const rows = await db.query<{
    operation_key: string;
    provider_id: string;
    target: string;
    request_received_at: Date | null;
    effect_started_at: Date | null;
    effect_committed_at: Date | null;
    response_sent_at: Date | null;
    response_claim: string | null;
    response_delivered: boolean;
  }>(
    `SELECT * FROM lab_provider_requests
      WHERE operation_key = $1 ORDER BY id`,
    [operationKey],
  );
  if (!rows.ok) throw new Error(rows.error.message);

  return rows.value.rows.map((r) => ({
    operationKey: r.operation_key,
    providerId: r.provider_id,
    target: r.target,
    requestReceivedAt: r.request_received_at?.toISOString() ?? null,
    effectStartedAt: r.effect_started_at?.toISOString() ?? null,
    effectCommittedAt: r.effect_committed_at?.toISOString() ?? null,
    responseSentAt: r.response_sent_at?.toISOString() ?? null,
    responseClaim: r.response_claim,
    responseDelivered: r.response_delivered,
  }));
}

/**
 * LA VÉRITÉ DU BANC, en une phrase.
 *
 * Ce que Jarvis ne peut pas savoir et que le banc, lui, sait avec certitude.
 * C'est cette fonction qui permet d'écrire « Jarvis avait raison de dire
 * UNKNOWN » — une phrase qu'aucun test unitaire ne peut exprimer.
 */
export async function groundTruth(
  db: Db,
  operationKey: string,
): Promise<{
  readonly requestsReceived: number;
  readonly effectsCommitted: number;
  readonly responsesSent: number;
  readonly responsesDelivered: number;
}> {
  const timeline = await providerTimeline(db, operationKey);
  return {
    requestsReceived: timeline.filter((t) => t.requestReceivedAt !== null).length,
    effectsCommitted: timeline.filter((t) => t.effectCommittedAt !== null).length,
    responsesSent: timeline.filter((t) => t.responseSentAt !== null).length,
    responsesDelivered: timeline.filter(
      (t) => t.responseSentAt !== null && t.responseDelivered,
    ).length,
  };
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

/**
 * LE PLUS GRAND NOMBRE D'EFFETS SUR UNE MÊME CIBLE.
 *
 * L'inégalité fondamentale se lit PAR CIBLE (ADR-031) : une opération à cinq
 * destinataires produit légitimement cinq effets. Ce qui ne doit jamais
 * arriver, c'est DEUX effets pour LA MÊME cible.
 *
 * Compter sans distinguer les cibles confondrait un succès partiel parfaitement
 * légitime avec une rupture de contrat — l'erreur que `docs/22 §9` désigne
 * comme la limite de classe D.
 */
export async function maxEffectsPerTarget(
  db: Db,
  operationKey: string,
): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lab_world_effects
      WHERE operation_key = $1
      GROUP BY target ORDER BY count(*) DESC LIMIT 1`,
    [operationKey],
  );
  if (!rows.ok) throw new Error(rows.error.message);
  return Number(rows.value.rows[0]?.n ?? '0');
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
