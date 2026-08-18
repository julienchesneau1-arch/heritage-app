/**
 * « QU'AS-TU FAIT AUJOURD'HUI ? » — et la réponse doit être ENTIÈRE.
 *
 * `docs/05 §A9` en fait une capacité nommée. C'est aussi la seule question par
 * laquelle l'utilisateur peut prendre Jarvis en défaut : un audit est la
 * contrepartie de l'autonomie. Un audit incomplet qui se présente comme complet
 * ne coûte pas seulement une information — il RASSURE à tort.
 *
 * DEUX DÉFAUTS, TROUVÉS EN RE-MESURANT PLUTÔT QU'EN SE SOUVENANT — ADR-064
 * ---------------------------------------------------------------------------
 * J'avais écrit, une itération plus tôt, que les exports non testés de
 * `src/apps/` « ne portent aucune décision de sûreté — des constantes, du
 * balisage statique ». En relançant le balayage plutôt qu'en citant ma propre
 * conclusion, `reports.ts` est apparu. **L'affirmation était fausse.**
 *
 * **1. La fenêtre était calculée par le PROCESSUS.**
 * `new Date().toISOString().slice(0, 10)` puis `occurredAt.startsWith(day)`.
 * ADR-036 et ADR-037 ont tranché l'inverse : la borne appartient à la base. Un
 * processus dont l'horloge dérive voyait « aujourd'hui » ailleurs qu'aujourd'hui.
 *
 * **2. Le décompte était SILENCIEUSEMENT plafonné à 200.**
 * `recent(200)` puis filtrage. Au-delà de deux cents événements dans la
 * journée, la réponse en omettait sans le dire. Le journal enregistre chaque
 * opération d'outil et chaque décision de politique : deux cents, c'est une
 * journée ordinaire, pas un cas limite.
 *
 * ET LE PLUS INSTRUCTIF : IL Y AVAIT DÉJÀ UNE BONNE RÉPONSE
 * ---------------------------------------------------------
 * L'outil `audit_query` (`src/tools/audit.ts`) borne par
 * `date_trunc('day', clock_timestamp())` depuis toujours. Deux registres du
 * même fait, exactement ce qu'ADR-041 interdit — sauf que cette fois le
 * registre JUSTE était celui que personne n'affichait, et le registre FAUX
 * était la surface produit : CLI et passerelle web appellent `auditReport`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedger, type Ledger } from '../../src/core/ledger/ledger.js';
import { digestPayload } from '../../src/core/ledger/event.js';
import { ok } from '../../src/core/types/result.js';
import type pg from 'pg';
import type { Db } from '../../src/core/db/client.js';
import {
  appDb,
  databaseAvailable,
  superuserDb,
  withLedgerExclusive,
} from '../helpers/db.js';

const skip = !databaseAvailable();

describe.skipIf(skip)('le décompte du jour est complet et borné par la base', () => {
  let app: Db;
  let root: Db;
  let ledger: Ledger;

  beforeAll(() => {
    app = appDb();
    /* IL FAUT LE SUPERUTILISATEUR POUR DATER UN ÉVÉNEMENT D'HIER, ET C'EST UNE
       BONNE NOUVELLE. La première version de ce test antidatait avec le rôle
       applicatif ; l'`UPDATE` a été REFUSÉ. Le journal est immuable pour
       l'application — c'est la barrière de `ledger-immutability.test.ts` qui a
       fait son travail sur mon propre test. */
    root = superuserDb();
    ledger = createLedger(app);
  });

  afterAll(async () => {
    await app.close();
    await root.close();
  });

  /* ==================================================================== *
   * DÉFAUT 1 — LA TRONCATURE SILENCIEUSE
   * ==================================================================== */

  it('AU-DELÀ DE 200 ÉVÉNEMENTS, aucun ne disparaît', async () => {
    /* LE DÉFAUT DU JOUR, PAS UN PIÈGE POUR PLUS TARD. `recent(200)` rendait les
       deux cents DERNIERS événements du journal — tous types confondus — puis
       filtrait sur la journée. Sur une journée chargée, la réponse à « qu'as-tu
       fait aujourd'hui ? » perdait le début de la journée en silence.

       On en écrit 250 d'un type qui n'existe nulle part ailleurs, pour compter
       une population dont on connaît la taille exacte. */
    const marqueur = `TALLY_VOLUME_${String(Date.now())}`;

    await withLedgerExclusive(app, async () => {
      for (let i = 0; i < 250; i += 1) {
        const ecrit = await ledger.append({
          actor: 'JARVIS',
          eventType: marqueur,
          status: 'CONFIRMED',
          payloadDigest: digestPayload({ i }),
        });
        expect(ecrit.ok).toBe(true);
      }
    });

    const tally = await ledger.dayTally();
    expect(tally.ok).toBe(true);
    if (!tally.ok) return;

    const ligne = tally.value.entries.find((e) => e.eventType === marqueur);
    // 250, pas 200 : c'est tout l'enjeu. Un `toBeGreaterThan(200)` laisserait
    // passer un plafond à 249.
    expect(ligne?.count).toBe(250);

    // Et le total ne dépend d'aucune limite de lignes : il englobe au moins
    // ces 250-là.
    expect(tally.value.total).toBeGreaterThanOrEqual(250);
  });

  /* ==================================================================== *
   * DÉFAUT 2 — LA FENÊTRE CALCULÉE PAR LE PROCESSUS
   * ==================================================================== */

  it('le JOUR rendu est celui de la BASE, pas celui du processus', async () => {
    /* ADR-037 : *l'échéance est bien fixée une fois — mais par la mauvaise
       horloge.* On demande donc à la base sa propre date et on exige l'égalité.
       Si le rapport recalculait en JavaScript, ce test resterait vert tant que
       les deux horloges coïncident — d'où le contrôle négatif plus bas, qui
       vérifie que la borne est bien APPLIQUÉE, pas seulement affichée. */
    const dit = await ledger.dayTally();
    expect(dit.ok).toBe(true);

    const base = await app.query<{ day: string }>(
      `SELECT to_char(date_trunc('day', clock_timestamp()), 'YYYY-MM-DD') AS day`,
    );
    expect(base.ok).toBe(true);
    if (!dit.ok || !base.ok) return;

    expect(dit.value.day).toBe(base.value.rows[0]?.day);
    expect(dit.value.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('un événement d’HIER n’est pas compté dans aujourd’hui', async () => {
    /* LE CONTRÔLE NÉGATIF DE LA BORNE. Sans lui, une requête sans clause
       `WHERE` passerait les deux tests précédents : elle compterait tout, donc
       au moins 250, et afficherait la date de la base.

       On date l'événement d'hier directement en base — `occurred_at` est écrit
       par le processus à l'insertion, donc c'est la seule façon d'obtenir un
       événement d'hier sans attendre demain. Le chaînage n'est pas touché :
       `occurred_at` entre dans le hash, on remet donc la valeur d'origine. */
    const marqueur = `TALLY_HIER_${String(Date.now())}`;

    const ecrit = await ledger.append({
      actor: 'JARVIS',
      eventType: marqueur,
      status: 'CONFIRMED',
      payloadDigest: digestPayload({ marqueur }),
    });
    expect(ecrit.ok).toBe(true);
    if (!ecrit.ok) return;

    const avant = await ledger.dayTally();
    expect(avant.ok && avant.value.entries.some((e) => e.eventType === marqueur)).toBe(
      true,
    );

    /* FENÊTRE D'ANTIDATAGE — accès exclusif obligatoire. Pendant qu'elle est
       ouverte, `occurred_at` ne correspond plus au hash : un lecteur concurrent
       verrait la chaîne rompue, à juste titre. Même discipline que
       `ledger-chain.test.ts`. */
    await withLedgerExclusive(root, async () => {
      const disable = await root.query(
        'ALTER TABLE event_ledger DISABLE TRIGGER USER',
      );
      expect(disable.ok).toBe(true);
      try {
        const recule = await root.query(
          `UPDATE event_ledger
              SET occurred_at = occurred_at - interval '1 day'
            WHERE event_id = $1`,
          [ecrit.value.eventId],
        );
        expect(recule.ok).toBe(true);

        const apres = await ledger.dayTally();
        expect(apres.ok).toBe(true);
        if (apres.ok) {
          // L'ÉVÉNEMENT A DISPARU DU JOUR — c'est ce qui prouve que la borne
          // s'APPLIQUE, et pas seulement qu'une date s'affiche.
          expect(apres.value.entries.some((e) => e.eventType === marqueur)).toBe(
            false,
          );
        }
      } finally {
        /* On rend sa date d'origine AVANT de réarmer : `occurred_at` entre dans
           le hash, et un test qui laisse la chaîne fausse casse tous les
           suivants. C'est la leçon déjà payée une fois dans ce dépôt. */
        await root.query(
          `UPDATE event_ledger SET occurred_at = $2 WHERE event_id = $1`,
          [ecrit.value.eventId, ecrit.value.occurredAt],
        );
        await root.query('ALTER TABLE event_ledger ENABLE TRIGGER USER');
      }
    });

    const chaine = await ledger.verifyChain();
    expect(chaine.ok && chaine.value.valid).toBe(true);
  });

  /* ==================================================================== *
   * LE CAS LIMITE QUI RAMÈNE LE DÉFAUT PAR LA PORTE DE DERRIÈRE
   * ==================================================================== */

  it('le jour est rendu MÊME quand la journée est vide', async () => {
    /* LE CAS LIMITE PAR LEQUEL LE DÉFAUT POUVAIT REVENIR.
       Une agrégation sans ligne ne rend aucune ligne — donc aucune date. La
       tentation est de retomber sur `new Date()` là, et seulement là : le
       défaut ne se verrait qu'un jour sans activité, c'est-à-dire jamais en
       test et un jour en production.

       DOUBLURE PLUTÔT QUE VRAIE BASE, ET C'EST ASSUMÉ. Vider `event_ledger`
       pour éprouver ce cas exigerait de désarmer la barrière d'immuabilité sur
       la table ENTIÈRE — un risque disproportionné pour vérifier une branche de
       repli. La doublure rend exactement ce que PostgreSQL rend sur une
       agrégation vide (`rows: []`), et les trois tests précédents, eux,
       s'exécutent sur la vraie base. */
    const questions: string[] = [];
    const doublure: Db = {
      query: <T extends pg.QueryResultRow>(text: string) => {
        questions.push(text);
        const agregation = text.includes('FROM event_ledger');
        const rows = agregation ? [] : [{ day: '2031-03-04' } as unknown as T];
        return Promise.resolve(
          ok<pg.QueryResult<T>>({
            rows,
            rowCount: rows.length,
            command: 'SELECT',
            oid: 0,
            fields: [],
          }),
        );
      },
      transaction: app.transaction.bind(app),
      health: app.health.bind(app),
      close: () => Promise.resolve(),
    };

    const tally = await createLedger(doublure).dayTally();
    expect(tally.ok).toBe(true);
    if (!tally.ok) return;

    expect(tally.value.total).toBe(0);
    expect(tally.value.entries).toEqual([]);
    // LA DATE VIENT DE LA BASE, pas de l'horloge du processus — une valeur que
    // `new Date()` ne peut pas produire aujourd'hui.
    expect(tally.value.day).toBe('2031-03-04');

    // CONTRÔLE NÉGATIF : le repli a bien posé une SECONDE question. Sans elle,
    // la date ne pourrait venir que du processus.
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain('clock_timestamp()');
  });
});
