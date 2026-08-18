/**
 * Memory Inbox — une proposition non confirmée attend, elle n'est plus perdue.
 *
 * Référence : 09 §2.1, proposition n°9.
 *
 * Ce que ces tests protègent : sans file d'attente, chaque observation non
 * confirmée disparaît. Les mois d'usage avant l'ajout de l'Inbox seraient des
 * mois d'apprentissage non rattrapables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryInbox, type MemoryInbox } from '../../src/core/memory/inbox.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';

const skip = !databaseAvailable();

function proposal(content: string) {
  return {
    content,
    memoryType: 'PREFERENCE' as const,
    sourceType: 'USER_INFERRED' as const,
    source: 'conversation',
    dataCategory: 'PERSONAL_MEMORY' as const,
    privacyClass: 'ORANGE' as const,
    suggestedConfidence: 0.6,
    subjectEntityId: null,
    provenance: 'USER',
  };
}

describe.skipIf(skip)('Memory Inbox', () => {
  let db: Db;
  let inbox: MemoryInbox;

  beforeAll(() => {
    db = appDb();
    inbox = createMemoryInbox(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('dépose un candidat en attente', async () => {
    const queued = await inbox.enqueue(proposal('Préfère les trains de nuit'));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.state).toBe('PENDING');
    expect(queued.value.resultingMemoryId).toBeNull();
  });

  it('déposer deux fois la même observation ne crée qu\'un candidat', async () => {
    const content = 'Préfère les chambres calmes';
    const first = await inbox.enqueue(proposal(content));
    const second = await inbox.enqueue(proposal(content));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
  });

  it('liste les candidats en attente, du plus récent au plus ancien', async () => {
    const pending = await inbox.pending();
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.length).toBeGreaterThan(0);
    for (const candidate of pending.value) {
      expect(candidate.state).toBe('PENDING');
    }
  });

  it('confirmer relie le candidat à la mémoire créée', async () => {
    const queued = await inbox.enqueue(proposal('Préfère les vols du matin'));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    // Une mémoire réelle est nécessaire : la contrainte `confirmed_has_memory`
    // interdit un candidat confirmé sans mémoire résultante.
    const memory = await db.query<{ id: string }>(
      `INSERT INTO memories (
         kind, memory_type, content, confidence, source, source_type,
         data_category, provenance, privacy_class
       ) VALUES ('FACT','PREFERENCE','Préfère les vols du matin',1,
                 'conversation','USER_EXPLICIT','PERSONAL_MEMORY','USER','ORANGE')
       RETURNING id`,
    );
    expect(memory.ok).toBe(true);
    if (!memory.ok) return;
    const memoryId = memory.value.rows[0]?.id ?? '';

    const confirmed = await inbox.confirm(queued.value.id, memoryId);
    expect(confirmed.ok).toBe(true);

    const reread = await inbox.get(queued.value.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok || reread.value === null) return;
    expect(reread.value.state).toBe('CONFIRMED');
    expect(reread.value.resultingMemoryId).toBe(memoryId);
  });

  it('rejeter marque le candidat sans créer de mémoire', async () => {
    const queued = await inbox.enqueue(proposal('Préfère les hôtels bruyants'));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const rejected = await inbox.reject(queued.value.id);
    expect(rejected.ok).toBe(true);

    const reread = await inbox.get(queued.value.id);
    if (!reread.ok || reread.value === null) return;
    expect(reread.value.state).toBe('REJECTED');
    expect(reread.value.resultingMemoryId).toBeNull();
  });

  it('une décision déjà prise ne se rejoue pas', async () => {
    const queued = await inbox.enqueue(proposal('Préfère la montagne'));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    expect((await inbox.reject(queued.value.id)).ok).toBe(true);
    const again = await inbox.reject(queued.value.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe('CONFLICT');
  });

  it('un candidat rejeté libère l\'empreinte pour une nouvelle proposition', async () => {
    // L'index d'unicité ne porte que sur les candidats PENDING : après un
    // rejet, la même observation peut être reproposée plus tard — le contexte
    // aura peut-être changé.
    const content = 'Préfère les restaurants japonais';
    const first = await inbox.enqueue(proposal(content));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect((await inbox.reject(first.value.id)).ok).toBe(true);

    const second = await inbox.enqueue(proposal(content));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).not.toBe(first.value.id);
    expect(second.value.state).toBe('PENDING');
  });

  it('les candidats échus passent à EXPIRED', async () => {
    const queued = await inbox.enqueue(proposal('Préfère les auberges'));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    // On force l'échéance dans le passé : une Inbox qui gonfle indéfiniment
    // cesse d'être consultée, donc cesse de servir.
    const aged = await db.query(
      "UPDATE memory_candidates SET expires_at = now() - interval '1 day' WHERE id = $1",
      [queued.value.id],
    );
    expect(aged.ok).toBe(true);

    const expired = await inbox.expireStale();
    expect(expired.ok).toBe(true);
    if (expired.ok) expect(expired.value).toBeGreaterThan(0);

    const reread = await inbox.get(queued.value.id);
    if (reread.ok && reread.value !== null) {
      expect(reread.value.state).toBe('EXPIRED');
    }
  });

  it('un candidat échu ne figure plus dans la file', async () => {
    const pending = await inbox.pending(100);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    for (const candidate of pending.value) {
      expect(new Date(candidate.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
  });
});

/* ====================================================================== *
 * LE DÉCOMPTE — combien il y en a, pas combien on en a lu (ADR-064)
 * ====================================================================== */

describe.skipIf(skip)('le décompte des candidats en attente', () => {
  let db: Db;
  let inbox: MemoryInbox;

  beforeAll(() => {
    db = appDb();
    inbox = createMemoryInbox(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('COMPTE au-delà de la limite de lecture — 20 lus, tous comptés', async () => {
    /* LE DÉFAUT D'ORIGINE : `diagnosticReport` répondait « combien de candidats
       en attente ? » par `pending(1000).length`, et `inboxReport` montrait les
       vingt premiers sans dire combien il y en avait. Un plafond de LECTURE
       rendu comme un COMPTE.

       On en dépose 25 : la lecture par défaut s'arrête à 20, le compte ne doit
       pas s'y arrêter. */
    const marque = `compte-${String(Date.now())}`;
    for (let i = 0; i < 25; i += 1) {
      const depose = await inbox.enqueue(proposal(`${marque} · candidat ${String(i)}`));
      expect(depose.ok).toBe(true);
    }

    const lus = await inbox.pending();
    expect(lus.ok).toBe(true);
    if (lus.ok) expect(lus.value).toHaveLength(20);

    const compte = await inbox.pendingCount();
    expect(compte.ok).toBe(true);
    if (!compte.ok) return;

    // Le compte dépasse ce que la lecture a rendu : c'est tout l'enjeu.
    expect(compte.value).toBeGreaterThanOrEqual(25);
    expect(compte.value).toBeGreaterThan(20);
  });

  it('le compte et la liste partagent le MÊME prédicat — un confirmé sort des deux', async () => {
    /* ADR-041 appliqué à deux définitions de « en attente ». Si le compte
       comptait aussi les candidats confirmés, la liste montrerait N éléments et
       le total en annoncerait N+1 : l'utilisateur chercherait un candidat qui
       n'existe plus. */
    const avant = await inbox.pendingCount();
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;

    const depose = await inbox.enqueue(proposal(`accord-${String(Date.now())}`));
    expect(depose.ok).toBe(true);
    if (!depose.ok) return;

    const pendant = await inbox.pendingCount();
    expect(pendant.ok && pendant.value).toBe(avant.value + 1);

    const rejete = await inbox.reject(depose.value.id);
    expect(rejete.ok).toBe(true);

    // REVENU À SON POINT DE DÉPART : un candidat sorti de l'attente sort des
    // DEUX registres, pas d'un seul.
    const apres = await inbox.pendingCount();
    expect(apres.ok && apres.value).toBe(avant.value);
  });

  it('CONTRÔLE NÉGATIF — le compte n’est pas une constante', async () => {
    /* Sans lui, un `return ok(0)` ou un `return ok(42)` passerait les tests
       précédents dès lors que la base est assez peuplée. */
    const debut = await inbox.pendingCount();
    const ajout = await inbox.enqueue(proposal(`bouge-${String(Date.now())}`));
    const fin = await inbox.pendingCount();

    expect(debut.ok && ajout.ok && fin.ok).toBe(true);
    if (!debut.ok || !fin.ok) return;
    expect(fin.value).not.toBe(debut.value);
  });
});
