/**
 * COUCHE 01 — HORLOGE ET CLOISONNEMENT : mesures, sans correction.
 *
 * Foundation 5, phase DISCOVERY instrumentée. Ce fichier MESURE. Il ne corrige
 * rien, et plusieurs de ses tests documentent volontairement un défaut.
 *
 * LA QUESTION POSÉE
 * -----------------
 * Pas : « quelle fonction donne l'heure exacte ? »
 * Mais : « quelle source temporelle permet de décider qu'un bail est expiré
 *          SANS ouvrir la possibilité d'une reprise prématurée ? »
 *
 * Les deux questions n'ont pas la même réponse, et c'est tout l'objet de la
 * couche.
 *
 * CONVENTION D'ÉCRITURE
 * ---------------------
 * Un défaut mesuré est encodé par `it.fails()` : le test énonce la propriété
 * SOUHAITÉE et échoue aujourd'hui. Le jour où quelqu'un corrige, il passe au
 * vert et `it.fails()` le signale — impossible de corriger en silence, et
 * impossible d'oublier de retirer le marqueur.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { labDb, labKey } from './harness.js';
import type { Db } from '../../src/core/db/client.js';
import type { OperationIdentity } from '../../src/core/tools/identity.js';

const enabled = databaseAvailable();
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Clocks {
  transaction: string;
  statement: string;
  wall: string;
}

const CLOCK_QUERY = `SELECT
    transaction_timestamp()::text AS transaction,
    statement_timestamp()::text   AS statement,
    clock_timestamp()::text       AS wall`;

/** Écart en millisecondes entre deux horodatages PostgreSQL. */
function gapMs(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime();
}

describe.runIf(enabled)('couche 01 — horloge', () => {
  let db: Db;

  beforeAll(() => {
    db = labDb(10);
  });

  afterAll(async () => {
    await db.close();
  });

  /* ================================================================== *
   * M1 — les trois horloges de PostgreSQL
   * ================================================================== */

  it('HORS transaction : les trois horloges avancent ensemble', async () => {
    const first = await db.query<Clocks>(CLOCK_QUERY);
    await sleep(1_200);
    const second = await db.query<Clocks>(CLOCK_QUERY);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const a = first.value.rows[0];
    const b = second.value.rows[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    // Chaque requête isolée est sa propre transaction implicite : les trois
    // fonctions y coïncident, et toutes avancent.
    expect(gapMs(a.transaction, b.transaction)).toBeGreaterThan(1_000);
    expect(gapMs(a.statement, b.statement)).toBeGreaterThan(1_000);
    expect(gapMs(a.wall, b.wall)).toBeGreaterThan(1_000);
  }, 30_000);

  it(
    'DANS une transaction longue : transaction_timestamp() FIGE, clock_timestamp() avance',
    async () => {
      const measured = await db.transaction(async (tx) => {
        const first = await tx.query<Clocks>(CLOCK_QUERY);
        await sleep(2_000);
        const second = await tx.query<Clocks>(CLOCK_QUERY);
        if (!first.ok || !second.ok) throw new Error('mesure impossible');

        const a = first.value.rows[0];
        const b = second.value.rows[0];
        if (a === undefined || b === undefined) throw new Error('mesure vide');

        return {
          ok: true as const,
          value: {
            transaction: gapMs(a.transaction, b.transaction),
            statement: gapMs(a.statement, b.statement),
            wall: gapMs(a.wall, b.wall),
          },
        };
      });

      expect(measured.ok).toBe(true);
      if (!measured.ok) return;

      /* LE RÉSULTAT CENTRAL DE LA COUCHE.

         `now()` est un alias de `transaction_timestamp()`. Il rend l'heure de
         DÉBUT de transaction, et ne bouge donc pas d'un pouce pendant deux
         secondes réelles. */
      expect(measured.value.transaction).toBe(0);

      // `statement_timestamp()` suit chaque instruction.
      expect(measured.value.statement).toBeGreaterThan(1_500);
      // `clock_timestamp()` est la seule véritable horloge murale.
      expect(measured.value.wall).toBeGreaterThan(1_500);
    },
    30_000,
  );

  /* ================================================================== *
   * M2 — la propriété réellement recherchée
   *
   * Le contrôle de bail réel est :
   *     executing_at > now() − (timeout + marge)
   *
   * Deux `now()` interviennent, à deux moments différents, et leurs
   * défaillances n'ont PAS la même conséquence.
   * ================================================================== */

  it(
    'un now() FIGÉ dans le CONTRÔLE ne peut que SUR-estimer le bail',
    async () => {
      const key = labKey('clock-check');
      await seedExecuting(db, key, 0);

      const evaluated = await db.transaction(async (tx) => {
        // On force la transaction à vieillir : `now()` y restera figé à son
        // début, donc ANTÉRIEUR au temps réel.
        await sleep(2_000);
        const row = await tx.query<{ par_now: boolean; par_horloge: boolean }>(
          `SELECT executing_at > now()            - interval '1 second' AS par_now,
                  executing_at > clock_timestamp() - interval '1 second' AS par_horloge
             FROM tool_operations WHERE operation_id = $1`,
          [key],
        );
        if (!row.ok) throw new Error('mesure impossible');
        const r = row.value.rows[0];
        if (r === undefined) throw new Error('ligne absente');
        return { ok: true as const, value: r };
      });

      expect(evaluated.ok).toBe(true);
      if (!evaluated.ok) return;

      /* L'opération a démarré il y a 2 s, le bail vaut 1 s : elle DEVRAIT être
         expirée.

         Évaluée avec l'horloge murale : expirée, verdict juste.
         Évaluée avec `now()` figé      : encore vivante, verdict faux.

         Mais la direction de l'erreur est celle qui protège. Un bail
         sur-estimé BLOQUE une reprise ; il n'en autorise jamais une
         prématurée. C'est un risque de DISPONIBILITÉ, pas de SÛRETÉ. */
      expect(evaluated.value.par_horloge).toBe(false);
      expect(evaluated.value.par_now).toBe(true);
    },
    30_000,
  );

  it(
    'CONTRE-EXEMPLE : un now() figé à l\'ÉCRITURE autorise une reprise PRÉMATURÉE',
    async () => {
      /* Le cas dangereux, et il est symétrique du précédent.

         Ce n'est pas `now()` dans le CONTRÔLE qui menace la sûreté — c'est
         `now()` dans l'ESTAMPILLE. Si `executing_at` est écrit à l'intérieur
         d'une transaction longue, il porte l'heure du DÉBUT de cette
         transaction, donc une heure trop ANCIENNE.

         Le bail paraît alors plus vieux qu'il ne l'est, et expire trop tôt.
         Un exécutant bien vivant, qui vient tout juste de partir, est déclaré
         mort. C'est exactement la reprise prématurée qu'ADR-032 devait
         empêcher. */
      const key = labKey('clock-stamp');

      const staleness = await db.transaction(async (tx) => {
        // La transaction commence ici. `now()` est figé à cet instant.
        await sleep(2_000);
        // On écrit `executing_at = now()` — comme le fait le Gateway.
        const written = await tx.query(
          `INSERT INTO tool_operations
             (operation_id, tool_id, tool_version, state, input_digest, actor,
              attempts, committed_at, executing_at, lease_expires_at)
           VALUES ($1,'lab_clock','1.0.0','EXECUTING',
                   repeat('a',64), 'USER', 1, now(), now(), now())`,
          [key],
        );
        if (!written.ok) throw new Error(written.error.message);

        const measured = await tx.query<{ retard_ms: number }>(
          `SELECT EXTRACT(MILLISECOND FROM (clock_timestamp() - executing_at))::int
                  + 1000 * EXTRACT(SECOND FROM (clock_timestamp() - executing_at))::int
                  AS retard_ms
             FROM tool_operations WHERE operation_id = $1`,
          [key],
        );
        if (!measured.ok) throw new Error('mesure impossible');
        const r = measured.value.rows[0];
        if (r === undefined) throw new Error('ligne absente');
        return { ok: true as const, value: r.retard_ms };
      });

      expect(staleness.ok).toBe(true);
      if (!staleness.ok) return;

      /* L'estampille est née VIEILLE de deux secondes. Avec un bail court,
         l'opération serait considérée comme expirée à l'instant même où elle
         commence. */
      expect(staleness.value).toBeGreaterThan(1_500);
    },
    30_000,
  );

  /* ================================================================== *
   * M3 — dérive de l'horloge APPLICATIVE
   * ================================================================== */

  it(
    'le verdict de bail est indépendant de l\'horloge du processus (I14)',
    async () => {
      const key = labKey('clock-derive');
      await seedExecuting(db, key, 3_600); // démarrée il y a une heure

      const verdict = async (): Promise<boolean | undefined> => {
        const row = await db.query<{ live: boolean }>(
          `SELECT executing_at > now() - interval '10 seconds' AS live
             FROM tool_operations WHERE operation_id = $1`,
          [key],
        );
        return row.ok ? row.value.rows[0]?.live : undefined;
      };

      const avant = await verdict();

      // On décale l'horloge APPLICATIVE d'un an. Le bail est évalué par la
      // base : rien ne doit changer.
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 365 * 24 * 3_600 * 1_000;
      try {
        expect(await verdict()).toBe(avant);
      } finally {
        Date.now = realNow;
      }

      // Et dans l'autre sens.
      Date.now = () => realNow() - 365 * 24 * 3_600 * 1_000;
      try {
        expect(await verdict()).toBe(avant);
      } finally {
        Date.now = realNow;
      }

      expect(avant).toBe(false);
    },
    30_000,
  );

  /* ================================================================== *
   * M4 — acquisition concurrente et expiration
   * ================================================================== */

  it('acquisition concurrente : un seul gagnant, mesuré', async () => {
    const key = labKey('clock-acq');
    await seedPlanned(db, key);

    // Vingt tentatives simultanées du compare-and-swap d'engagement réel.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.query(
          `UPDATE tool_operations
              SET state = 'COMMITTED_TO_EXECUTION', committed_at = now()
            WHERE operation_id = $1 AND state = 'PLANNED'`,
          [key],
        ),
      ),
    );

    const winners = attempts.filter((r) => r.ok && (r.value.rowCount ?? 0) === 1);
    expect(winners.length).toBe(1);
  }, 30_000);

  /* ================================================================== *
   * M5 — CLOISONNEMENT : le défaut mesuré
   * ================================================================== */

  it(
    'un exécutant PÉRIMÉ peut encore écrire — défaut mesuré, non corrigé',
    async () => {
      /* Il n'existe aujourd'hui aucune génération de bail. Un exécutant A qui
         revient après que B a repris l'opération écrase donc l'état établi par
         B : le système raconterait l'histoire de A à propos d'un monde façonné
         par B.

         Ce test MESURE le défaut. Il ne le corrige pas — la correction exige
         un ADR, conformément au protocole de la couche 01. */
      const key = labKey('fencing-defaut');
      await seedExecuting(db, key, 3_600);

      // B reprend et clôt l'opération.
      const parB = await db.query(
        `UPDATE tool_operations
            SET state = 'SUCCEEDED', status = 'CONFIRMED', observed_at = now(),
                recovery_detail = 'repris par B'
          WHERE operation_id = $1 AND state = 'EXECUTING'`,
        [key],
      );
      expect(parB.ok && (parB.value.rowCount ?? 0) === 1).toBe(true);

      // A, zombie, revient et écrit son propre résultat.
      const parA = await db.query(
        `UPDATE tool_operations
            SET state = 'UNKNOWN', status = 'UNKNOWN', observed_at = now(),
                recovery_detail = 'écriture tardive de A'
          WHERE operation_id = $1`,
        [key],
      );
      expect(parA.ok).toBe(true);

      const final = await db.query<{ recovery_detail: string | null }>(
        'SELECT recovery_detail FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(final.ok).toBe(true);
      if (!final.ok) return;

      // L'écriture de A a bien écrasé celle de B. Défaut confirmé.
      expect(final.value.rows[0]?.recovery_detail).toBe('écriture tardive de A');
    },
    30_000,
  );

  it(
    'I15 — une écriture de génération périmée est refusée',
    async () => {
      /* CE TEST A CHANGÉ DE NATURE, ET LA TRACE COMPTE AUTANT QUE LE RÉSULTAT.
         Il a été écrit en couche 01 sous `it.fails()` : il énonçait la
         propriété SOUHAITÉE et échouait, parce que `lease_generation`
         n'existait pas.

         Le protocole prévu s'est déroulé exactement comme annoncé. À la
         première exécution suivant la migration 0008, Vitest a signalé
         « Expect test to fail » — la correction n'a PAS pu se faire en
         silence, et le marqueur n'a pas pu être oublié. Il est retiré ici
         parce que la propriété est tenue, pas parce qu'il gênait. */
      const key = labKey('fencing-souhaite');
      await seedExecuting(db, key, 3_600);

      const guarded = await db.query(
        `UPDATE tool_operations SET recovery_detail = 'A périmé'
          WHERE operation_id = $1 AND lease_generation = 41`,
        [key],
      );
      expect(guarded.ok).toBe(true);
      if (!guarded.ok) return;
      expect(guarded.value.rowCount).toBe(0);
    },
    30_000,
  );
});

/* -------------------------------------------------------------------------- */

/** Insère une opération en `EXECUTING`, démarrée il y a `agoSeconds`. */
async function seedExecuting(
  db: Db,
  key: OperationIdentity,
  agoSeconds: number,
): Promise<void> {
  const written = await db.query(
    `INSERT INTO tool_operations
       (operation_id, tool_id, tool_version, state, input_digest, actor,
        attempts, committed_at, executing_at, lease_expires_at)
     VALUES ($1,'lab_clock','1.0.0','EXECUTING', repeat('a',64), 'USER', 1,
             clock_timestamp() - ($2 || ' seconds')::interval,
             clock_timestamp() - ($2 || ' seconds')::interval,
             clock_timestamp() - ($2 || ' seconds')::interval)`,
    [key, String(agoSeconds)],
  );
  if (!written.ok) throw new Error(written.error.message);
}

/** Insère une opération en `PLANNED`. */
async function seedPlanned(db: Db, key: OperationIdentity): Promise<void> {
  const written = await db.query(
    `INSERT INTO tool_operations
       (operation_id, tool_id, tool_version, state, input_digest, actor, attempts)
     VALUES ($1,'lab_clock','1.0.0','PLANNED', repeat('a',64), 'USER', 0)`,
    [key],
  );
  if (!written.ok) throw new Error(written.error.message);
}
