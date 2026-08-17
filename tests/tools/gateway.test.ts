/**
 * Tool Gateway — le seul chemin par lequel une proposition devient une action.
 *
 * Porte de sortie Phase 2 (`02`) :
 *   « Aucun outil ne reçoit un secret via le modèle. »
 *   « Un paramètre sensible provenant d'une source non fiable déclenche une
 *     confirmation. »
 *
 * Ces tests montent la vraie chaîne — Cedar, politiques réelles, journal,
 * vérification. Un test de bout en bout adossé à un Policy Engine factice ne
 * prouverait que notre intention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineTool } from '../../src/core/tools/contract.js';
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { ok } from '../../src/core/types/result.js';

const skip = !databaseAvailable();

/** Provenance fiable pour tous les paramètres — le cas nominal. */
const TRUSTED = {
  content: 'USER',
  memoryType: 'USER',
  sourceType: 'SYSTEM',
  dataCategory: 'SYSTEM',
  subjectEntityId: 'USER',
  title: 'USER',
  dueAt: 'USER',
  privacyClass: 'SYSTEM',
  query: 'USER',
  state: 'USER',
} as const;

describe.skipIf(skip)('Tool Gateway', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /* ---------------------------------------------------------------------- */
  /* Chemin nominal                                                         */
  /* ---------------------------------------------------------------------- */

  it('exécute un outil L2 et vérifie le résultat en base', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Racheter du terreau' },
      parameterProvenance: TRUSTED,
      operationId: operationId('note'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CONFIRMED n'est produit qu'après relecture de l'état réel.
    expect(result.value.status).toBe('CONFIRMED');
    expect(result.value.verification.detail).toContain('État réel vérifié');
    expect(result.value.replayed).toBe(false);
  });

  it('exécute un outil L1 sans rien vérifier — il n\'y a rien à vérifier', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'task_list',
      input: { state: 'OPEN' },
      parameterProvenance: TRUSTED,
      operationId: operationId('list'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('CONFIRMED');
    expect(result.value.verification.detail).toContain('aucune mutation');
  });

  it('journalise chaque appel avec son statut vérifié', async () => {
    const op = operationId('note-journal');
    await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note tracée' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    expect(found.value.eventType).toContain('NOTE_CREATED');
    expect(found.value.status).toBe('CONFIRMED');
    expect(found.value.policyDecision).toBe('ALLOW');
  });

  it('capture de quoi annuler toute mutation (ADR-019)', async () => {
    const op = operationId('note-undo');
    await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note annulable' },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const snapshot = await stack.snapshots.forOperation(op);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok || snapshot.value === null) {
      throw new Error('aucune capture pour une mutation');
    }
    expect(snapshot.value.undoKind).toBe('INVERSE_OPERATION');
    expect(snapshot.value.inverseToolId).toBe('note_delete');
    expect(snapshot.value.resourceKind).toBe('note');
  });

  it('ne capture rien pour une lecture', async () => {
    const op = operationId('list-undo');
    await stack.gateway.invoke({
      toolId: 'task_list',
      input: {},
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const snapshot = await stack.snapshots.forOperation(op);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.value).toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* 05/B10 — provenance d'un paramètre sensible                            */
  /* ---------------------------------------------------------------------- */

  it('un paramètre sensible non fiable déclenche une confirmation', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note', privacyClass: 'GREEN' },
      parameterProvenance: {
        content: 'USER',
        // La classe de confidentialité vient d'un document externe : si elle
        // passait, un PDF pourrait déclasser une note en GREEN.
        privacyClass: 'EXTERNAL_UNTRUSTED',
      },
      operationId: operationId('note-tainted'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
    // La confirmation porte sur la VALEUR concrète, pas sur l'intention.
    expect(result.error.details?.['privacyClass']).toBe('GREEN');
  });

  it('un paramètre non déclaré est traité comme non fiable', async () => {
    // Le défaut penche vers la prudence : ne pas déclarer la provenance ne
    // doit pas revenir à déclarer qu'elle est sûre.
    const result = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'Appeler le plombier', dueAt: '2026-08-20T09:00:00Z' },
      parameterProvenance: { title: 'USER' }, // dueAt absent
      operationId: operationId('task-undeclared'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
  });

  it('la confirmation obtenue débloque l\'exécution', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'Appeler le plombier', dueAt: '2026-08-20T09:00:00Z' },
      parameterProvenance: { title: 'USER' },
      operationId: operationId('task-confirmed'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('CONFIRMED');
  });

  it('une action préparée mais non confirmée est journalisée comme telle', async () => {
    const op = operationId('task-prepared');
    await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'Tâche préparée', dueAt: '2026-09-01T09:00:00Z' },
      parameterProvenance: { title: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    expect(found.value.eventType).toContain('_PREPARED');
    expect(found.value.policyDecision).toBe('CONFIRM');
    // Ni CONFIRMED ni FAILED : on ne sait pas ce que l'utilisateur décidera.
    expect(found.value.status).toBe('UNKNOWN');
  });

  /* ---------------------------------------------------------------------- */
  /* Politique                                                              */
  /* ---------------------------------------------------------------------- */

  it('une automation ne peut pas exécuter une action à confirmation', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Note automatique', privacyClass: 'GREEN' },
      parameterProvenance: {
        content: 'SYSTEM',
        privacyClass: 'EXTERNAL_UNTRUSTED', // durcit jusqu'à L4
      },
      operationId: operationId('note-automation'),
      actor: 'AUTOMATION',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('POLICY_DENIED');
  });

  it('un refus de politique est journalisé', async () => {
    const op = operationId('denied');
    await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: 'Refusée', privacyClass: 'GREEN' },
      parameterProvenance: { content: 'SYSTEM', privacyClass: 'EXTERNAL_UNTRUSTED' },
      operationId: op,
      actor: 'AUTOMATION',
      context: callContext(),
    });

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    expect(found.value.eventType).toContain('_DENIED');
    expect(found.value.status).toBe('FAILED');
  });

  /* ---------------------------------------------------------------------- */
  /* Frontière et contrats                                                  */
  /* ---------------------------------------------------------------------- */

  it('refuse un outil inconnu sans révéler les outils disponibles', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'shell_exec',
      input: { cmd: 'rm -rf /' },
      parameterProvenance: {},
      operationId: operationId('unknown'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('NOT_FOUND');
      expect(JSON.stringify(result.error)).not.toContain('note_create');
    }
  });

  it('refuse une entrée malformée au lieu de l\'interpréter', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: '' },
      parameterProvenance: TRUSTED,
      operationId: operationId('bad-input'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('VALIDATION');
  });

  it('refuse à l\'enregistrement un contrat incohérent', () => {
    const incoherent = defineTool({
      definition: {
        id: 'outil_incoherent',
        version: '1.0.0',
        description: 'Mute sans pouvoir être vérifié.',
        autonomy: 'L2',
        privacyClass: 'ORANGE',
        // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
        dataCategory: 'OTHER',
        reversible: true,
        networkRequired: false,
        parameters: [],
        idempotency: 'NATURALLY_IDEMPOTENT', // faux pour une mutation
        verification: 'NONE', // faux pour une mutation
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'INCOHERENT',
        requiredSecrets: [],
        rollback: null, // contredit reversible: true
        attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null })),
    });

    const registered = stack.gateway.register(incoherent);
    expect(registered.ok).toBe(false);
    if (!registered.ok) {
      expect(registered.error.kind).toBe('CONFIGURATION');
      const problems = String(registered.error.details?.['problems']);
      expect(problems).toContain('vérification NONE');
      expect(problems).toContain('idempotent');
      expect(problems).toContain('réversible');
    }
  });

  it('un outil L0 ne peut pas exister', () => {
    const forbidden = defineTool({
      definition: {
        id: 'outil_interdit',
        version: '1.0.0',
        description: 'Interdit par construction.',
        autonomy: 'L0',
        privacyClass: 'RED',
        // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
        dataCategory: 'OTHER',
        reversible: false,
        networkRequired: false,
        parameters: [],
        idempotency: 'OPERATION_KEY',
        verification: 'READ_BACK',
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'FORBIDDEN',
        requiredSecrets: [],
        rollback: null,
        attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null })),
    });

    expect(stack.gateway.register(forbidden).ok).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* Secrets — invariant S3                                                 */
  /* ---------------------------------------------------------------------- */

  it('aucun outil du noyau ne réclame de secret', () => {
    for (const tool of stack.gateway.list()) {
      expect(tool.definition.requiredSecrets).toEqual([]);
    }
  });

  it('le contexte d\'outil ne contient que les secrets déclarés', async () => {
    let observed: readonly string[] = ['non renseigné'];

    stack.registerExtra(
      defineTool({
        definition: {
          id: 'sonde_secrets',
          version: '1.0.0',
          description: 'Observe les secrets reçus.',
          autonomy: 'L1',
          privacyClass: 'GREEN',
          // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
          dataCategory: 'OTHER',
          reversible: false,
          networkRequired: false,
          parameters: [],
          idempotency: 'NATURALLY_IDEMPOTENT',
          verification: 'NONE',
          timeoutMs: 1000,
          maxRetries: 0,
          auditEvent: 'PROBE',
          requiredSecrets: [], // n'en déclare aucun
          rollback: null,
          attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
        },
        inputSchema: z.object({}),
        execute: (_input, ctx) => {
          observed = [...ctx.secrets.keys()];
          return Promise.resolve(ok({ output: null }));
        },
      }),
    );

    await stack.gateway.invoke({
      toolId: 'sonde_secrets',
      input: {},
      parameterProvenance: {},
      operationId: operationId('probe'),
      actor: 'USER',
      context: callContext(),
    });

    // Moindre privilège jusqu'au bout : un outil qui ne déclare aucun secret
    // ne reçoit pas le coffre, il reçoit une carte vide.
    expect(observed).toEqual([]);
  });
});
