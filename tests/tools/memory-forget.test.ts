/**
 * `memory_forget` — `docs/05 §C3`, DROIT À L'OUBLI (CRITIQUE).
 *
 * Le scénario doré tient en trois lignes, et chacune est éprouvée ici :
 *
 * ```
 * Entrée   : « Oublie cette information. »
 * Attendu  : mémoire + embeddings + relations + cache + dérivés supprimés ;
 *            événement MEMORY_DELETED.
 * Interdit : que le contenu supprimé survive dans le journal.
 * ```
 *
 * PREMIER OUTIL INVERSE ÉCRIT — cinq étaient déclarés, zéro existait. Et c'est
 * celui-là qu'il fallait écrire en premier : `docs/05 §C3` est CRITIQUE, les
 * quatre autres sont du confort.
 *
 * CE QUI REND CE FICHIER DIFFÉRENT DES AUTRES TESTS D'OUTIL
 * ---------------------------------------------------------------------------
 * Partout ailleurs, réussir c'est **faire apparaître** quelque chose, et on le
 * vérifie en le relisant. Ici réussir c'est **faire disparaître**, et une
 * relecture vide est la preuve. Le Verification Engine ne savait pas dire cela :
 * `confirmed()` code en dur `POSITIVE_PRESENCE`, et la seule fabrique rendant
 * `POSITIVE_ABSENCE` était `failed()`. Un outil dont le succès EST une absence
 * ne pouvait donc pas annoncer son succès honnêtement (ADR-065).
 *
 * L'ENJEU DU STATUT PARTIEL
 * -------------------------
 * Une mémoire ne vit pas qu'à un endroit. `memory_derivatives` recense ses
 * copies, et celles marquées `cascades = false` — export, sauvegarde, cache
 * externe — survivent au `DELETE`. Tant qu'il en reste une, **dire « oublié »
 * serait une fausse confirmation portant sur une promesse de
 * confidentialité.** C'est la pire espèce : l'utilisateur cesse de se méfier
 * d'une donnée qui existe encore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createMemoryStore } from '../../src/core/memory/store.js';
import { createDerivativeRegistry } from '../../src/core/memory/derivatives.js';
import { createHash } from 'node:crypto';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe.runIf(enabled)('memory_forget — 05/C3 droit à l’oubli', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Dépose une mémoire par le magasin réel et rend son identifiant. */
  async function souvenir(contenu: string): Promise<string> {
    const store = createMemoryStore(db);
    const insere = await store.insertVerified({
      kind: 'FACT',
      memoryType: 'SEMANTIC',
      content: contenu,
      confidence: 0.9,
      source: 'test',
      sourceType: 'USER_EXPLICIT',
      dataCategory: 'PERSONAL_MEMORY',
      provenance: 'USER',
      privacyClass: 'ORANGE',
      subjectEntityId: null,
      expiresAt: null,
      contentDigest: createHash('sha256').update(contenu).digest('hex'),
      lastVerifiedAt: null,
    });
    if (!insere.ok) throw new Error(`insertion refusée : ${insere.error.message}`);
    return insere.value.id;
  }

  async function oublier(
    memoryId: string,
  ): Promise<{ ok: boolean; status?: string; detail?: string; message?: string }> {
    const result = await stack.gateway.invoke({
      toolId: 'memory_forget',
      input: { memoryId },
      parameterProvenance: { memoryId: 'USER' },
      operationId: operationId(`forget-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) return { ok: false, message: result.error.message };
    return {
      ok: true,
      status: result.value.verification.status,
      detail: result.value.verification.detail,
    };
  }

  /* ==================================================================== *
   * L'ATTENDU — « mémoire + embeddings + … supprimés »
   * ==================================================================== */

  it('05/C3 — la mémoire est RÉELLEMENT supprimée, pas marquée DELETED', async () => {
    /* L'effacement doux était la voie annoncée : `memory_add.rollback` disait
       « marquer la mémoire DELETED ». Une ligne `state = 'DELETED'` garde
       `content` — c'est-à-dire garde exactement ce qu'on a promis d'oublier. */
    const contenu = `secret-a-oublier-${suffixe()}`;
    const id = await souvenir(contenu);

    const oubli = await oublier(id);
    expect(oubli.ok).toBe(true);
    expect(oubli.status).toBe('CONFIRMED');

    const reste = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memories WHERE id = $1',
      [id],
    );
    expect(reste.ok && reste.value.rows[0]?.n).toBe('0');

    // Et le CONTENU n'est plus nulle part dans la table — pas seulement la
    // ligne : un test qui ne cherche que l'identifiant raterait une copie.
    const parContenu = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memories WHERE content = $1',
      [contenu],
    );
    expect(parContenu.ok && parContenu.value.rows[0]?.n).toBe('0');
  });

  it('05/C3 — l’embedding et les dérivés en cascade partent avec elle', async () => {
    const id = await souvenir(`avec-embedding-${suffixe()}`);
    const store = createMemoryStore(db);

    // `attachEmbedding` enregistre aussi le dérivé EMBEDDING (cascades = true).
    const attache = await store.attachEmbedding(id, Array(768).fill(0.01), 'test-model');
    expect(attache.ok).toBe(true);

    const avant = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memory_derivatives WHERE memory_id = $1',
      [id],
    );
    expect(avant.ok && avant.value.rows[0]?.n).not.toBe('0');

    const oubli = await oublier(id);
    expect(oubli.status).toBe('CONFIRMED');

    const apres = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memory_derivatives WHERE memory_id = $1',
      [id],
    );
    expect(apres.ok && apres.value.rows[0]?.n).toBe('0');
  });

  it('05/C3 — l’événement MEMORY_DELETED est journalisé', async () => {
    const id = await souvenir(`journalise-${suffixe()}`);
    await oublier(id);

    const trace = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_ledger
        WHERE event_type = 'MEMORY_DELETED'
          AND occurred_at >= now() - interval '1 minute'`,
    );
    expect(trace.ok && trace.value.rows[0]?.n).not.toBe('0');
  });

  /* ==================================================================== *
   * L'INTERDIT — « que le contenu survive dans le journal »
   * ==================================================================== */

  it('05/C3 — INTERDIT : le contenu ne survit NULLE PART dans le journal', async () => {
    /* LA CLAUSE LA PLUS DURE DU SCÉNARIO, parce que le journal est append-only :
       rien n'en sort jamais. Elle ne peut donc être tenue que si le contenu n'y
       ENTRE PAS. `event_ledger` ne porte qu'un `payload_digest` — « empreinte du
       contenu, jamais le contenu » (`03 §12`).

       On balaie TOUTES les colonnes textuelles, pas seulement celles qu'on
       soupçonne : `intent`, `proof` et `tool` sont du texte libre, et c'est
       précisément par une colonne libre qu'une fuite passerait. */
    const contenu = `phrase-tres-identifiable-${suffixe()}`;
    const id = await souvenir(contenu);
    await oublier(id);

    const fuite = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_ledger
        WHERE coalesce(intent, '')          LIKE '%' || $1 || '%'
           OR coalesce(proof, '')           LIKE '%' || $1 || '%'
           OR coalesce(tool, '')            LIKE '%' || $1 || '%'
           OR coalesce(event_type, '')      LIKE '%' || $1 || '%'
           OR coalesce(operation_id, '')    LIKE '%' || $1 || '%'`,
      [contenu],
    );
    expect(fuite.ok && fuite.value.rows[0]?.n).toBe('0');
  });

  it('05/C3 — INTERDIT : rien n’est recopié dans les instantanés d’annulation', async () => {
    /* ADR-019 veut que toute mutation capture de quoi être annulée. Appliqué
       tel quel ici, cela recopierait le contenu dans `action_snapshots` : on
       n'aurait rien oublié, on aurait déplacé. Le schéma avait prévu la sortie
       — `undo_kind = 'NOT_UNDOABLE'`. La capture EXISTE et ne garde RIEN.

       Un oubli qu'on peut défaire n'est pas un oubli. */
    const contenu = `jamais-en-instantane-${suffixe()}`;
    const id = await souvenir(contenu);
    await oublier(id);

    const copie = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM action_snapshots
        WHERE coalesce(prior_state::text, '') LIKE '%' || $1 || '%'
           OR coalesce(inverse_input::text, '') LIKE '%' || $1 || '%'`,
      [contenu],
    );
    expect(copie.ok && copie.value.rows[0]?.n).toBe('0');

    // Et la capture existe bien — ADR-019 est respecté, pas contourné.
    const capture = await db.query<{ undo_kind: string }>(
      `SELECT undo_kind FROM action_snapshots
        WHERE resource_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(capture.ok && capture.value.rows[0]?.undo_kind).toBe('NOT_UNDOABLE');
  });

  /* ==================================================================== *
   * LE STATUT PARTIEL — une copie survit, donc rien n'est « oublié »
   * ==================================================================== */

  it('05/C3 — un dérivé HORS CASCADE interdit d’annoncer l’oubli', async () => {
    /* LE CŒUR DU FICHIER. Une sauvegarde garde une copie ; la ligne part, la
       donnée non. Annoncer « oublié » ici serait une fausse confirmation sur
       une promesse de confidentialité — l'utilisateur cesserait de se méfier
       d'une donnée qui existe encore.

       Le statut n'est pas choisi par l'outil : il est PROJETÉ par
       `projectStatus` sur deux familles de cibles. `docs/19 §2` l'exigeait —
       *un outil ne peut pas se dire PARTIAL pour éviter de trancher.* */
    const id = await souvenir(`avec-sauvegarde-${suffixe()}`);
    const registry = createDerivativeRegistry(db);
    const pose = await registry.register(id, 'BACKUP', '/sauvegardes/2026-08.tar', false);
    expect(pose.ok).toBe(true);

    const oubli = await oublier(id);
    expect(oubli.ok).toBe(true);

    // NI CONFIRMED — ce serait mentir — NI FAILED : la ligne EST partie.
    expect(oubli.status).toBe('PARTIAL');
    expect(oubli.detail).toContain('BACKUP');
    expect(oubli.detail?.toLowerCase()).toContain('incomplet');

    // La ligne a bien disparu : le PARTIAL porte sur la copie, pas sur un échec.
    const reste = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memories WHERE id = $1',
      [id],
    );
    expect(reste.ok && reste.value.rows[0]?.n).toBe('0');
  });

  /* ==================================================================== *
   * CONTRÔLES NÉGATIFS
   * ==================================================================== */

  it('oublier une mémoire INEXISTANTE n’est pas un succès', async () => {
    /* Revendiquer un acte qui n'a pas eu lieu est la faute que ce dépôt traque
       partout. « J'ai oublié » alors qu'il n'y avait rien à oublier en est
       une : l'utilisateur en conclurait qu'une donnée a été effacée. */
    const oubli = await oublier('00000000-0000-4000-8000-000000000000');
    expect(oubli.ok).toBe(true);
    expect(oubli.status).not.toBe('CONFIRMED');
  });

  it('l’outil est déclaré L4 — « suppression, irréversible »', () => {
    /* `docs/03` nomme le niveau : L4 = confirmation forte, pour « paiement,
       suppression, données sensibles, irréversible ». Un `memory_forget` en L2
       s'exécuterait sans que personne ne dise oui. */
    const tool = stack.gateway.list().find((t) => t.definition.id === 'memory_forget');
    expect(tool?.definition.autonomy).toBe('L4');
    expect(tool?.definition.reversible).toBe(false);
    // Et il n'annonce aucun rollback : il n'y en a pas, et en promettre un
    // serait promettre la réversibilité que §C3 interdit d'avoir.
    expect(tool?.definition.rollback).toBeNull();
  });
});
