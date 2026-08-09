/**
 * Le journal est-il RÉELLEMENT inaltérable ?
 *
 * Porte de sortie Phase 0 (`02`) : « Le journal est inaltérable : un UPDATE ou
 * DELETE échoue au niveau des permissions PostgreSQL, pas de l'application. »
 *
 * Ce test l'établit sur les deux barrières, séparément :
 *
 *   Barrière 1 — PERMISSIONS : le rôle applicatif n'a jamais reçu UPDATE ni
 *                DELETE. Elle tient même si tout le code applicatif est
 *                compromis.
 *   Barrière 2 — TRIGGER : refuse la modification même au rôle propriétaire,
 *                qui possède pourtant les privilèges DML.
 *
 * Un test qui ne vérifierait que la barrière 2 laisserait croire que la
 * garantie est applicative. Elle ne l'est pas, et c'est le sujet d'ADR-012.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedger, type Ledger } from '../../src/core/ledger/ledger.js';
import { digestPayload } from '../../src/core/ledger/event.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable, ownerDb } from '../helpers/db.js';

const skip = !databaseAvailable();

describe.skipIf(skip)('ADR-012 — journal append-only', () => {
  let app: Db;
  let owner: Db;
  let ledger: Ledger;

  beforeAll(async () => {
    app = appDb();
    owner = ownerDb();
    ledger = createLedger(app);

    const seeded = await ledger.append({
      actor: 'SYSTEM',
      eventType: 'TEST_SEED',
      status: 'CONFIRMED',
      payloadDigest: digestPayload({ test: 'immutability' }),
    });
    expect(seeded.ok).toBe(true);
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Barrière 1 — permissions                                               */
  /* ---------------------------------------------------------------------- */

  it('le rôle applicatif ne peut pas modifier une ligne du journal', async () => {
    const result = await app.query(
      "UPDATE event_ledger SET status = 'CONFIRMED' WHERE event_type = 'TEST_SEED'",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('POLICY_DENIED');
      expect(result.error.details?.['pgCode']).toBe('42501');
    }
  });

  it('le rôle applicatif ne peut pas supprimer une ligne du journal', async () => {
    const result = await app.query('DELETE FROM event_ledger');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.['pgCode']).toBe('42501');
  });

  it('le rôle applicatif ne peut pas vider le journal', async () => {
    const result = await app.query('TRUNCATE event_ledger');
    expect(result.ok).toBe(false);
  });

  it('le refus vient bien des permissions, pas seulement du trigger', async () => {
    // On interroge le catalogue : si le GRANT existait, la barrière 1 serait
    // absente et seule la barrière 2 protégerait le journal.
    const grants = await app.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'event_ledger' AND grantee = 'jarvis_app'`,
    );
    expect(grants.ok).toBe(true);
    if (grants.ok) {
      const privileges = grants.value.rows.map((r) => r.privilege_type).sort();
      expect(privileges).toEqual(['INSERT', 'SELECT']);
      expect(privileges).not.toContain('UPDATE');
      expect(privileges).not.toContain('DELETE');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Barrière 2 — trigger, y compris pour le propriétaire                   */
  /* ---------------------------------------------------------------------- */

  it('même le propriétaire ne peut pas modifier une ligne', async () => {
    const result = await owner.query(
      "UPDATE event_ledger SET proof = 'forge' WHERE event_type = 'TEST_SEED'",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only/i);
  });

  it('même le propriétaire ne peut pas supprimer une ligne', async () => {
    const result = await owner.query(
      "DELETE FROM event_ledger WHERE event_type = 'TEST_SEED'",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/append-only/i);
  });

  /* ---------------------------------------------------------------------- */
  /* Le journal reste utilisable                                            */
  /* ---------------------------------------------------------------------- */

  it('l\'ajout reste possible — append-only, pas read-only', async () => {
    const appended = await ledger.append({
      actor: 'JARVIS',
      eventType: 'TEST_APPEND',
      status: 'PROBABLE',
      payloadDigest: digestPayload({ n: 1 }),
    });
    expect(appended.ok).toBe(true);
  });
});
