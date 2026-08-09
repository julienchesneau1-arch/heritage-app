/**
 * Intégrité de la chaîne — la troisième barrière.
 *
 * Les permissions et le trigger empêchent l'altération (voir
 * `ledger-immutability.test.ts`). Le chaînage par hash répond à une question
 * différente : **et si ces deux barrières tombaient ?**
 *
 * Un attaquant disposant d'un accès superutilisateur peut désactiver les
 * triggers. Il ne peut pas, en revanche, réécrire la chaîne sans recalculer
 * tous les hash suivants. Ce fichier le démontre en simulant précisément ce
 * scénario, plutôt qu'en le supposant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedger, type Ledger } from '../../src/core/ledger/ledger.js';
import {
  computeHash,
  digestPayload,
  GENESIS_HASH,
} from '../../src/core/ledger/event.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable, superuserDb } from '../helpers/db.js';

const skip = !databaseAvailable();

/* -------------------------------------------------------------------------- */
/* Propriétés de la fonction de hachage — sans base                           */
/* -------------------------------------------------------------------------- */

describe('computeHash', () => {
  const base = {
    eventId: '11111111-1111-4111-8111-111111111111',
    occurredAt: '2026-08-09T12:00:00.000Z',
    actor: 'JARVIS' as const,
    eventType: 'EMAIL_SENT',
    intent: null,
    tool: 'messaging',
    policyDecision: null,
    autonomyLevel: null,
    status: 'CONFIRMED' as const,
    proof: 'msg-42',
    model: null,
    costEur: 0,
    operationId: null,
    payloadDigest: digestPayload({ to: 'jean' }),
  };

  it('est déterministe', () => {
    expect(computeHash(base, GENESIS_HASH)).toBe(computeHash(base, GENESIS_HASH));
  });

  it('change si le statut change', () => {
    expect(computeHash({ ...base, status: 'FAILED' }, GENESIS_HASH)).not.toBe(
      computeHash(base, GENESIS_HASH),
    );
  });

  it('change si la preuve change', () => {
    expect(computeHash({ ...base, proof: 'msg-43' }, GENESIS_HASH)).not.toBe(
      computeHash(base, GENESIS_HASH),
    );
  });

  it('change si le maillon précédent change', () => {
    expect(computeHash(base, 'f'.repeat(64))).not.toBe(
      computeHash(base, GENESIS_HASH),
    );
  });

  /**
   * Résistance à l'ambiguïté de sérialisation.
   *
   * Un encodage par simple concaténation permettrait de forger deux événements
   * distincts partageant le même hash, en déplaçant le contenu d'un champ vers
   * le suivant. L'échappement JSON l'interdit.
   */
  it('distingue deux répartitions de champs qui se concaténeraient pareil', () => {
    const a = { ...base, tool: 'mess', eventType: 'agingEMAIL_SENT' };
    const b = { ...base, tool: 'messaging', eventType: 'EMAIL_SENT' };
    expect(computeHash(a, GENESIS_HASH)).not.toBe(computeHash(b, GENESIS_HASH));
  });
});

/* -------------------------------------------------------------------------- */
/* Détection d'altération — avec base                                         */
/* -------------------------------------------------------------------------- */

describe.skipIf(skip)('détection d\'altération du journal', () => {
  let app: Db;
  let root: Db;
  let ledger: Ledger;

  beforeAll(async () => {
    app = appDb();
    root = superuserDb();
    ledger = createLedger(app);

    for (let i = 0; i < 3; i += 1) {
      const appended = await ledger.append({
        actor: 'JARVIS',
        eventType: 'CHAIN_TEST',
        status: 'CONFIRMED',
        payloadDigest: digestPayload({ i }),
      });
      expect(appended.ok).toBe(true);
    }
  });

  afterAll(async () => {
    await app.close();
    await root.close();
  });

  it('une chaîne intacte est déclarée valide', async () => {
    const report = await ledger.verifyChain();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.valid).toBe(true);
      expect(report.value.checked).toBeGreaterThan(0);
    }
  });

  it('une modification de contenu est détectée, triggers désactivés', async () => {
    // On simule la chute des deux premières barrières.
    const disable = await root.query(
      'ALTER TABLE event_ledger DISABLE TRIGGER USER',
    );
    expect(disable.ok).toBe(true);

    try {
      // L'attaquant réécrit un statut : « échec » devient « confirmé ».
      // C'est exactement le scénario 05/B5, mais au niveau du stockage.
      const tampered = await root.query(
        `UPDATE event_ledger SET status = 'FAILED'
          WHERE seq = (SELECT seq FROM event_ledger
                        WHERE event_type = 'CHAIN_TEST' ORDER BY seq ASC LIMIT 1)`,
      );
      expect(tampered.ok).toBe(true);

      const report = await ledger.verifyChain();
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(report.value.valid).toBe(false);
        expect(report.value.brokenAt?.reason).toMatch(/altéré/i);
      }
    } finally {
      // Restaurer l'état, quoi qu'il arrive : un test qui laisse la protection
      // désactivée est pire que pas de test du tout.
      await root.query('ALTER TABLE event_ledger ENABLE TRIGGER USER');
    }
  });

  it('les triggers sont bien réactivés après le test', async () => {
    const result = await root.query(
      "UPDATE event_ledger SET proof = 'x' WHERE event_type = 'CHAIN_TEST'",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only/i);
  });

  it('une suppression de maillon est détectée', async () => {
    const disable = await root.query(
      'ALTER TABLE event_ledger DISABLE TRIGGER USER',
    );
    expect(disable.ok).toBe(true);

    try {
      // On répare d'abord le maillon altéré par le test précédent, pour
      // isoler ce que ce test-ci démontre.
      await root.query(
        `UPDATE event_ledger SET status = 'CONFIRMED'
          WHERE event_type = 'CHAIN_TEST'
            AND seq = (SELECT min(seq) FROM event_ledger WHERE event_type = 'CHAIN_TEST')`,
      );

      // Suppression d'un maillon intermédiaire : le suivant pointe désormais
      // vers un hash absent de la chaîne.
      await root.query(
        `DELETE FROM event_ledger
          WHERE seq = (SELECT seq FROM event_ledger
                        WHERE event_type = 'CHAIN_TEST' ORDER BY seq ASC OFFSET 1 LIMIT 1)`,
      );

      const report = await ledger.verifyChain();
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(report.value.valid).toBe(false);
        expect(report.value.brokenAt?.reason).toMatch(/chaînage rompu/i);
      }
    } finally {
      await root.query('ALTER TABLE event_ledger ENABLE TRIGGER USER');
    }
  });
});
