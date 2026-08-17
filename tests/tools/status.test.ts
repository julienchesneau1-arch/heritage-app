/**
 * `system_status` — Phase 3, point 9 de `docs/02`. Dernier des dix.
 *
 *   > Un état qui ne peut pas dire « ça ne va pas » ne dit rien quand ça va.
 *
 * Un « tout va bien » est la réponse la plus facile à écrire et la plus facile
 * à rendre fausse : il suffit de ne pas regarder, ou de regarder ce qui ne
 * risque rien. Ce fichier éprouve donc surtout la capacité à ALERTER — et
 * garde un contrôle négatif pour que l'alerte ne soit pas permanente.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable, withLedgerExclusive } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

interface Controle {
  verdict: string;
  detail: string;
}
interface Sortie {
  controles: { journal: Controle; operations: Controle; annulations: Controle };
  verdict: string;
  controlesEffectues: number;
}

describe.runIf(enabled)('system_status — Phase 3 point 9', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  async function etat(): Promise<Sortie> {
    const result = await stack.gateway.invoke({
      toolId: 'system_status',
      input: {},
      parameterProvenance: {},
      operationId: op('stat'),
      actor: 'USER',
      context: callContext(),
    });
    if (!result.ok) throw new Error(`refusé : ${result.error.message}`);
    return result.value.output as Sortie;
  }

  /* ================================================================== *
   * IL SAIT DIRE « ÇA NE VA PAS »
   * ================================================================== */

  it("ALERTE sur une opération sans issue", async () => {
    /* Le contrôle qui compte au quotidien : une opération `UNKNOWN` ne se
       résout pas toute seule, et rien d'autre ne la remonte. */
    const opId = op('stat-suspendue');
    const insere = await db.query(
      /* `observed_at` est OBLIGATOIRE pour un état terminal — la base le
         refuse autrement (`terminal_states_are_observed`, migration 0007).
         La contrainte a fait échouer la première rédaction de ce test, et
         elle avait raison : un `UNKNOWN` non observé n'a pas de sens. */
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor, observed_at)
       VALUES ($1, 'test_tool', '1.0.0', 'UNKNOWN', repeat('a', 64), 'USER',
               clock_timestamp())`,
      [opId],
    );
    expect(insere.ok).toBe(true);

    try {
      const sortie = await etat();
      expect(sortie.controles.operations.verdict).toBe('ATTENTION');
      expect(sortie.controles.operations.detail).toContain('sans issue');
      // Et le verdict global suit le PIRE, pas une moyenne.
      expect(sortie.verdict).toBe('ATTENTION');
    } finally {
      await db.query('DELETE FROM tool_operations WHERE operation_id = $1', [opId]);
    }
  }, 30_000);

  it("ALERTE sur un instantané d'annulation qui expire sous 24 h", async () => {
    /* Un instantané n'est pas un archivage : il vit sept jours (ADR-019).
       Passé ce délai l'action devient définitivement non annulable — et rien
       ne le signale au moment où ça arrive. C'est précisément le genre de
       dégradation silencieuse qu'un état doit rendre visible. */
    const insere = await db.query(
      `INSERT INTO action_snapshots
         (operation_id, resource_kind, resource_id, undo_kind, inverse_tool_id,
          inverse_input, privacy_class, expires_at)
       VALUES ($1, 'task', 'x', 'INVERSE_OPERATION', 'task_cancel',
               '{}'::jsonb, 'ORANGE', clock_timestamp() + interval '2 hours')`,
      [op('stat-expire')],
    );
    expect(insere.ok).toBe(true);

    try {
      const sortie = await etat();
      expect(sortie.controles.annulations.verdict).toBe('ATTENTION');
      expect(sortie.controles.annulations.detail).toContain('non annulables');
      expect(sortie.verdict).toBe('ATTENTION');
    } finally {
      await db.query(
        "DELETE FROM action_snapshots WHERE operation_id LIKE 'stat-expire%'",
      );
    }
  }, 30_000);

  /* ================================================================== *
   * CONTRÔLE NÉGATIF — l'alerte n'est pas permanente
   * ================================================================== */

  it("rend OK quand rien ne cloche — sinon les alertes ne prouveraient rien", async () => {
    /* Sans lui, les deux tests précédents seraient verts en alertant
       TOUJOURS : il suffirait de ne jamais rien déclarer sain. */
    await db.query(
      "DELETE FROM tool_operations WHERE state IN ('UNKNOWN','COMMITTED_TO_EXECUTION','EXECUTING')",
    );
    await db.query(
      `DELETE FROM action_snapshots
        WHERE undone_at IS NULL
          AND expires_at < clock_timestamp() + interval '24 hours'`,
    );

    /* ACCÈS EXCLUSIF : `system_status` vérifie la chaîne, et
       `ledger-chain.test.ts` la corrompt volontairement — sur le même journal
       partagé. Voir `withLedgerExclusive`. */
    const sortie = await withLedgerExclusive(db, () => etat());
    expect(sortie.controles.operations.verdict).toBe('OK');
    expect(sortie.controles.annulations.verdict).toBe('OK');
    expect(sortie.controles.journal.verdict).toBe('OK');
    expect(sortie.verdict).toBe('OK');
  }, 30_000);

  /* ================================================================== *
   * Ce que le verdict global n'a pas le droit de faire
   * ================================================================== */

  it("le verdict global est le PIRE des contrôles, jamais une moyenne", async () => {
    /* Deux contrôles verts et un rouge ne font pas « globalement bon ». Le
       test précédent établit que trois verts donnent `OK` ; celui-ci que la
       présence d'un seul `ATTENTION` suffit à basculer l'ensemble. */
    const opId = op('stat-pire');
    await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor, observed_at)
       VALUES ($1, 'test_tool', '1.0.0', 'UNKNOWN', repeat('b', 64), 'USER',
               clock_timestamp())`,
      [opId],
    );
    try {
      const sortie = await etat();
      const verdicts = Object.values(sortie.controles).map((c) => c.verdict);
      expect(verdicts).toContain('ATTENTION');
      expect(verdicts).toContain('OK'); // tous ne sont PAS en alerte
      expect(sortie.verdict).toBe('ATTENTION');
    } finally {
      await db.query('DELETE FROM tool_operations WHERE operation_id = $1', [opId]);
    }
  }, 30_000);

  it('rend les TROIS contrôles annoncés — aucun ne disparaît en silence', async () => {
    /* Le mode de panne d'un outil d'état : un contrôle retiré « parce qu'il
       était bruyant » ne laisse aucune trace, et le « tout va bien » qui suit
       est plus faux qu'avant. Le compte est rendu explicitement. */
    const sortie = await etat();
    expect(sortie.controlesEffectues).toBe(3);
    expect(Object.keys(sortie.controles).sort()).toEqual([
      'annulations',
      'journal',
      'operations',
    ]);
    for (const controle of Object.values(sortie.controles)) {
      expect(['OK', 'ATTENTION', 'INCONNU']).toContain(controle.verdict);
      expect(controle.detail.length).toBeGreaterThan(5);
    }
  }, 30_000);

  it("ne se déclare sain sur rien qu'il n'a pas pu mesurer", async () => {
    /* `INCONNU` est un troisième verdict, distinct d'`OK`. Ne pas avoir pu
       regarder n'est pas avoir regardé — et fondre les deux est exactement ce
       qui rend un tableau de bord rassurant et inutile. */
    const sortie = await etat();
    for (const controle of Object.values(sortie.controles)) {
      if (controle.verdict === 'INCONNU') {
        expect(controle.detail).toContain('impossible');
      }
    }
    // Le type `INCONNU` existe bien dans le domaine du verdict global.
    expect(['OK', 'ATTENTION', 'INCONNU']).toContain(sortie.verdict);
  }, 30_000);

  it('déclare un contrat de lecture pure', () => {
    const tool = stack.gateway.list().find((t) => t.definition.id === 'system_status');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.effect).toBe('NO_EXTERNAL_EFFECT');
    expect(d.autonomy).toBe('L1');
    expect(d.networkRequired).toBe(false);
    expect(d.requiredSecrets).toEqual([]);
    expect(d.reversible).toBe(false);
  });

  /* ================================================================== *
   * L'OBSERVATEUR NE SE COMPTE PAS LUI-MÊME
   * ================================================================== */

  it("ne compte PAS une opération en vol dont le bail est VIVANT", async () => {
    /* CE TEST EXISTE PARCE QUE LA PREMIÈRE RÉDACTION ÉTAIT FAUSSE.

       Le contrôle comptait `state IN ('UNKNOWN','COMMITTED_TO_EXECUTION',
       'EXECUTING')`. Or **`system_status` est lui-même `EXECUTING` pendant
       qu'il compte** : l'observateur se comptait dans ce qu'il observait, et
       le tableau de bord signalait une opération en suspens en permanence.

       Une alerte toujours allumée est une alerte éteinte.

       La correction ne consiste pas à s'exclure par identifiant — ce serait un
       emplâtre qui laisserait passer toute AUTRE opération en cours. Elle
       consiste à distinguer EN VOL d'ABANDONNÉ, et le bail porte déjà cette
       information. On le vérifie ici avec une opération tierce, bail encore
       vivant : elle ne doit pas apparaître. */
    const opId = op('stat-en-vol');
    const insere = await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor,
          lease_expires_at, lease_generation)
       VALUES ($1, 'test_tool', '1.0.0', 'EXECUTING', repeat('c', 64), 'USER',
               clock_timestamp() + interval '5 minutes', 1)`,
      [opId],
    );
    expect(insere.ok).toBe(true);

    try {
      const sortie = await etat();
      // Bail vivant : quelqu'un travaille, il n'y a rien à signaler.
      expect(sortie.controles.operations.verdict).toBe('OK');
    } finally {
      await db.query('DELETE FROM tool_operations WHERE operation_id = $1', [opId]);
    }
  }, 30_000);

  it('ALERTE en revanche sur la même opération une fois le bail EXPIRÉ', async () => {
    /* Le contrôle négatif du précédent : sans lui, il suffirait de ne jamais
       compter les opérations en vol pour que les deux passent. La seule
       différence entre les deux tests est l'échéance du bail. */
    const opId = op('stat-abandon');
    await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, input_digest, actor,
          lease_expires_at, lease_generation)
       VALUES ($1, 'test_tool', '1.0.0', 'EXECUTING', repeat('d', 64), 'USER',
               clock_timestamp() - interval '5 minutes', 1)`,
      [opId],
    );
    try {
      const sortie = await etat();
      expect(sortie.controles.operations.verdict).toBe('ATTENTION');
      expect(sortie.controles.operations.detail).toContain('abandonnées');
    } finally {
      await db.query('DELETE FROM tool_operations WHERE operation_id = $1', [opId]);
    }
  }, 30_000);
});
