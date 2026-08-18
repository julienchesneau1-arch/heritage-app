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
import { SOURCE_CEILING } from '../../src/core/memory/types.js';

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

  it('une déduction de modèle ne peut PAS hériter d\'une provenance fiable', () => {
    // Corrigé (CRIT-2, ADR-024). `MODEL_INFERRED` rendait `'SYSTEM'` —
    // c'est-à-dire la même provenance que ce que le NOYAU produit lui-même.
    // Une IA pouvait ainsi s'auto-élever au rang d'autorité.
    expect(provenanceOf('MODEL_INFERRED')).toBe('MODEL_OUTPUT');
    expect(isUntrusted(provenanceOf('MODEL_INFERRED'))).toBe(true);
  });

  it('la cartographie complète des origines vers les provenances', () => {
    expect(provenanceOf('USER_EXPLICIT')).toBe('USER');
    expect(provenanceOf('USER_INFERRED')).toBe('USER');
    expect(provenanceOf('EXTERNAL_SOURCE')).toBe('EXTERNAL_UNTRUSTED');
    expect(provenanceOf('TOOL_VERIFIED')).toBe('TOOL_OUTPUT');
    expect(provenanceOf('SYSTEM')).toBe('SYSTEM');
    expect(provenanceOf('MODEL_INFERRED')).toBe('MODEL_OUTPUT');
  });

  it('`SYSTEM` reste réservé au noyau, et reste donc fiable', () => {
    // La correction ne consiste pas à tout rendre suspect : ce que le noyau
    // produit lui-même n'a pas de raison de l'être. Elle consiste à ne plus
    // confondre « produit par le noyau » et « déduit par un modèle ».
    expect(isUntrusted('SYSTEM')).toBe(false);
    expect(isUntrusted('USER')).toBe(false);
    expect(isUntrusted('MODEL_OUTPUT')).toBe(true);
    expect(isUntrusted('EXTERNAL_UNTRUSTED')).toBe(true);
  });

  it('une valeur d\'origine MODEL_OUTPUT est arrêtée par le Gate', async () => {
    // Le chemin qu'emprunterait demain une valeur déduite par un modèle. Il
    // est aujourd'hui traité exactement comme une valeur lue dans un email :
    // confirmation exigée sur la VALEUR concrète.
    const result = await stack.gateway.invoke({
      toolId: 'memory_add',
      input: {
        content: `${TAG} déduction de modèle`,
        memoryType: 'SEMANTIC' as const,
        sourceType: 'MODEL_INFERRED' as const,
        source: 'modèle local',
      },
      operationId: operationId('rt-model'),
      actor: 'JARVIS' as const,
      context: callContext(),
      parameterProvenance: {
        content: 'MODEL_OUTPUT',
        memoryType: 'MODEL_OUTPUT',
        sourceType: 'MODEL_OUTPUT',
        dataCategory: 'MODEL_OUTPUT',
        subjectEntityId: 'MODEL_OUTPUT',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
  });

  it('et le plafond de confiance continue de distinguer les origines', () => {
    // Le second axe faisait déjà son travail : `SOURCE_CEILING` plafonnait
    // MODEL_INFERRED à 0,7. C'était l'axe SÉCURITÉ qui était faux — d'où la
    // difficulté à voir le défaut en relisant.
    expect(SOURCE_CEILING.MODEL_INFERRED).toBeLessThan(SOURCE_CEILING.USER_EXPLICIT);
    expect(SOURCE_CEILING.MODEL_INFERRED).toBeGreaterThan(SOURCE_CEILING.EXTERNAL_SOURCE);
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

  it('OUBLIER est désormais exerçable ; CORRIGER et LISTER ne le sont pas', () => {
    /* ⚠ CE TEST A CHANGÉ DE CAMP — ADR-065.
       Il disait : « aucun outil ne permet d'oublier […] le droit à l'oubli
       (S14, `03 §12`) n'est pas exerçable par la conversation — seulement en
       SQL. » `memory_forget` existe : `docs/05 §C3` est servi.

       Les deux autres manques restent, et restent nommés. Un test qui perd une
       assertion en gagnant une capacité cesserait de surveiller ce qui manque
       encore. */
    const ids = stack.gateway.list().map((t) => t.definition.id);
    expect(ids).toContain('memory_add');
    expect(ids).toContain('memory_search');
    expect(ids).toContain('memory_forget');
    expect(ids).not.toContain('memory_update');
    expect(ids).not.toContain('memory_list');
  });

  it('le rollback annoncé par memory_add est exécutable', () => {
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
