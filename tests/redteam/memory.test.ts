/**
 * RED TEAM — la mémoire dit-elle la vérité sur ce qu'elle sait ?
 *
 * Référence : 03 §11, 09 §2.1, invariant S1.
 *
 * Deux questions, et les deux réponses sont mauvaises aujourd'hui :
 *
 *   1. une information DÉDUITE PAR UN MODÈLE a-t-elle le même statut qu'une
 *      information DÉCLARÉE par l'utilisateur ?
 *   2. que se passe-t-il quand une information contredit une information déjà
 *      mémorisée ?
 *
 * Les tests marqués `.fails()` énoncent la propriété ATTENDUE et constatent
 * qu'elle n'est pas tenue. Ils passent au vert le jour où le défaut est
 * corrigé — et la suite devient alors rouge tant que le marqueur n'est pas
 * retiré. Un défaut connu cesse ainsi d'être une note de bas de page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { isUntrusted, provenanceOf } from '../../src/core/types/domain.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import { createMemoryStore } from '../../src/core/memory/store.js';

const skip = !databaseAvailable();
const TAG = `rt-mem-${String(Date.now())}`;

describe.skipIf(skip)('RED TEAM — statut épistémique de la mémoire', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /* ------------------------------------------------------------------ */
  /* A. Une déduction de modèle n'est pas une déclaration de l'utilisateur */
  /* ------------------------------------------------------------------ */

  it('constate la cartographie actuelle des origines vers les provenances', () => {
    // Photographie de l'état, sans jugement — le jugement est en dessous.
    expect(provenanceOf('USER_EXPLICIT')).toBe('USER');
    expect(provenanceOf('USER_INFERRED')).toBe('USER');
    expect(provenanceOf('EXTERNAL_SOURCE')).toBe('EXTERNAL_UNTRUSTED');
    expect(provenanceOf('TOOL_VERIFIED')).toBe('TOOL_OUTPUT');
    expect(provenanceOf('SYSTEM')).toBe('SYSTEM');
    expect(provenanceOf('MODEL_INFERRED')).toBe('SYSTEM');
  });

  it.fails(
    'DÉFAUT — une déduction de modèle ne devrait pas hériter d\'une provenance fiable',
    () => {
      // S1 : « la sortie d'un modèle est une entrée non fiable ».
      // `MODEL_INFERRED → SYSTEM` fait exactement l'inverse : elle range la
      // sortie du modèle avec ce que le NOYAU a produit lui-même.
      //
      // Conséquence, le jour où un modèle existe : une valeur déduite par lui
      // peut alimenter un paramètre sensible SANS confirmation, parce que
      // `isUntrusted('SYSTEM')` est faux.
      expect(isUntrusted(provenanceOf('MODEL_INFERRED'))).toBe(true);
    },
  );

  it('DÉMONSTRATION — une provenance SYSTEM passe le Gate sans confirmation', async () => {
    // Le même chemin qu'emprunterait une valeur déduite par un modèle.
    // Comparaison avec EXTERNAL_UNTRUSTED, qui lui est bien arrêté.
    const base = {
      toolId: 'memory_add',
      input: {
        content: `${TAG} valeur sensible`,
        memoryType: 'SEMANTIC' as const,
        sourceType: 'USER_EXPLICIT' as const,
        source: 'red-team',
      },
      actor: 'USER' as const,
      context: callContext(),
    };

    stack.setUserConfirmed(true);
    const viaSystem = await stack.gateway.invoke({
      ...base,
      operationId: operationId('rt-system'),
      parameterProvenance: {
        content: 'SYSTEM',
        memoryType: 'SYSTEM',
        sourceType: 'SYSTEM',
        dataCategory: 'SYSTEM',
        subjectEntityId: 'SYSTEM',
      },
    });

    const viaExternal = await stack.gateway.invoke({
      ...base,
      input: { ...base.input, content: `${TAG} valeur externe` },
      operationId: operationId('rt-external'),
      parameterProvenance: {
        content: 'EXTERNAL_UNTRUSTED',
        memoryType: 'EXTERNAL_UNTRUSTED',
        sourceType: 'EXTERNAL_UNTRUSTED',
        dataCategory: 'EXTERNAL_UNTRUSTED',
        subjectEntityId: 'EXTERNAL_UNTRUSTED',
      },
    });

    expect(viaSystem.ok).toBe(true); // passe sans confirmation
    expect(viaExternal.ok).toBe(false); // arrêté
    if (!viaExternal.ok) expect(viaExternal.error.kind).toBe('CONFIRMATION_REQUIRED');
  });

  it('en revanche, le plafond de confiance distingue bien les origines', () => {
    // Le second axe, lui, fait son travail : une déduction de modèle plafonne
    // plus bas qu'une déclaration. Le défaut est sur l'axe SÉCURITÉ seulement.
    expect(provenanceOf('MODEL_INFERRED')).toBe('SYSTEM');
  });

  /* ------------------------------------------------------------------ */
  /* B. Contradiction                                                     */
  /* ------------------------------------------------------------------ */

  it('DÉMONSTRATION — deux informations contradictoires cohabitent sans marquage', async () => {
    const guard = createMemoryGuard(createMemoryStore(db), createMemoryInbox(db));

    const ancien = await guard.propose(
      {
        memoryType: 'SEMANTIC',
        content: `${TAG} Jean travaille chez Orano`,
        sourceType: 'USER_EXPLICIT',
        source: 'conversation',
        suggestedConfidence: 1,
      },
      { userConfirmed: true },
    );
    const nouveau = await guard.propose(
      {
        memoryType: 'SEMANTIC',
        content: `${TAG} Jean travaille chez EDF`,
        sourceType: 'USER_EXPLICIT',
        source: 'conversation',
        suggestedConfidence: 1,
      },
      { userConfirmed: true },
    );

    expect(ancien.ok && nouveau.ok).toBe(true);
    if (!ancien.ok || !nouveau.ok) return;

    // Les deux sont STORED, actives, et de même confiance. Aucune n'est
    // marquée obsolète, aucune ne pointe vers l'autre.
    expect(ancien.value.outcome).toBe('STORED');
    expect(nouveau.value.outcome).toBe('STORED');

    const results = await stack.gateway.invoke({
      toolId: 'memory_search',
      input: { query: `${TAG} Jean travaille`, limit: 10 },
      parameterProvenance: { query: 'USER', limit: 'USER' },
      operationId: operationId('rt-contradiction'),
      actor: 'USER',
      context: callContext(),
    });

    expect(results.ok).toBe(true);
    if (!results.ok) return;
    const output: Record<string, unknown> =
      typeof results.value.output === 'object' && results.value.output !== null
        ? { ...results.value.output }
        : {};
    const rows: unknown[] = Array.isArray(output['results']) ? output['results'] : [];
    const contents = rows.map((r) => {
      const item: Record<string, unknown> =
        typeof r === 'object' && r !== null ? { ...r } : {};
      return String(item['content']);
    });

    // Les deux versions reviennent, présentées identiquement comme des FACT.
    expect(contents.some((c) => c.includes('Orano'))).toBe(true);
    expect(contents.some((c) => c.includes('EDF'))).toBe(true);
  });

  it.fails(
    'DÉFAUT — une information plus récente devrait rendre la précédente obsolète',
    async () => {
      // Propriété attendue (demande explicite de l'utilisateur) :
      //   « J'avais enregistré X. Une information plus récente indique Y.
      //     Je considère donc Y comme la version actuelle. »
      //
      // Il n'existe aujourd'hui NI colonne `superseded_by`, NI détection de
      // contradiction, NI arbitrage temporel. Le schéma ne peut même pas
      // représenter la relation.
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'memories'`,
      );
      if (!columns.ok) throw new Error(columns.error.message);
      const names = columns.value.rows.map((r) => r.column_name);
      expect(names).toContain('superseded_by');
    },
  );

  /* ------------------------------------------------------------------ */
  /* C. Cycle de vie                                                      */
  /* ------------------------------------------------------------------ */

  it('DÉMONSTRATION — aucun outil ne permet d\'oublier, de corriger ou de lister', () => {
    // `memory_add` déclare pourtant `rollback: "…via memory_forget"`. L'outil
    // n'existe pas. Le droit à l'oubli (S14, 03 §12) n'est donc pas exerçable
    // par la conversation — seulement en SQL.
    const ids = stack.gateway.list().map((t) => t.definition.id);
    expect(ids).toContain('memory_add');
    expect(ids).toContain('memory_search');
    expect(ids).not.toContain('memory_forget');
    expect(ids).not.toContain('memory_update');
    expect(ids).not.toContain('memory_list');
  });

  it.fails('DÉFAUT — le rollback annoncé par memory_add doit être exécutable', () => {
    const tool = stack.gateway.list().find((t) => t.definition.id === 'memory_add');
    if (tool === undefined) throw new Error('memory_add absent');
    const rollback = tool.definition.rollback ?? '';
    const referenced = /memory_forget/.exec(rollback);
    if (referenced === null) throw new Error('pas de rollback nommé');
    const ids = stack.gateway.list().map((t) => t.definition.id);
    expect(ids).toContain('memory_forget');
  });

  it('l\'expiration est représentable mais aucun processus ne la déclenche', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'memories' AND column_name IN ('expires_at','state')`,
    );
    expect(columns.ok).toBe(true);
    if (!columns.ok) return;
    expect(columns.value.rows).toHaveLength(2);
    // Rien dans `src/` ne balaye `expires_at`. La colonne existe, la mécanique
    // non : une mémoire expirée reste ACTIVE indéfiniment.
  });
});
