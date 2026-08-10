/**
 * Verification Engine — 05/B5 et 05/B12.
 *
 * Porte de sortie Phase 2 : « Une mutation dont la vérification échoue est
 * rapportée comme FAILED, jamais comme un succès. »
 *
 * Le scénario central est celui de l'outil qui MENT : il renvoie un succès,
 * mais l'état réel n'a pas changé. C'est exactement ce que produit une API qui
 * répond 200 sans rien faire — et c'est la raison pour laquelle les assistants
 * du marché affirment parfois avoir envoyé un email qui n'est jamais parti.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../src/core/tools/contract.js';
import {
  createVerificationEngine,
  mayClaimSuccess,
  verificationOutcome,
} from '../../src/core/verification/engine.js';
import { ok, err, jarvisError } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';

const skip = !databaseAvailable();

describe('honnêteté systémique (fonction pure)', () => {
  it('seul CONFIRMED autorise à annoncer un succès', () => {
    expect(mayClaimSuccess('CONFIRMED')).toBe(true);
    expect(mayClaimSuccess('PROBABLE')).toBe(false);
    expect(mayClaimSuccess('UNKNOWN')).toBe(false);
    expect(mayClaimSuccess('FAILED')).toBe(false);
  });

  it('CONFIRMED exige une observation, pas une déclaration', () => {
    const outcome = verificationOutcome.confirmed({ observed: 'ligne relue' });
    expect(outcome.status).toBe('CONFIRMED');
    expect(outcome.detail).toContain('État réel vérifié');
    expect(outcome.detail).toContain('ligne relue');
  });
});

describe.skipIf(skip)('Verification Engine', () => {
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
  /* 05/B12 — l'outil qui ment                                              */
  /* ---------------------------------------------------------------------- */

  it('un outil qui prétend avoir muté sans le faire est rapporté FAILED', async () => {
    stack.registerExtra(
      defineTool({
        definition: {
          id: 'outil_menteur',
          version: '1.0.0',
          description: 'Renvoie un succès sans rien changer.',
          autonomy: 'L2',
          privacyClass: 'GREEN',
          reversible: true,
          networkRequired: false,
          parameters: [],
          idempotency: 'OPERATION_KEY',
          verification: 'READ_BACK',
          timeoutMs: 1000,
          maxRetries: 0,
          auditEvent: 'LIED',
          requiredSecrets: [],
          rollback: 'Sans objet — rien n\'a été fait.',
          attemptVerification: 'NONE',
        },
        inputSchema: z.object({}),
        // « HTTP 200 » : l'outil affirme avoir créé la note 404.
        execute: () =>
          Promise.resolve(
            ok({
              output: { created: true },
              resource: { kind: 'note', id: '00000000-0000-4000-8000-000000000000' },
            }),
          ),
        // La relecture constate que rien n'existe.
        readBack: () =>
          Promise.resolve(
            ok(
              verificationOutcome.failed(
                'La note annoncée est introuvable : rien n\'a été créé.',
              ),
            ),
          ),
      }),
    );

    const result = await stack.gateway.invoke({
      toolId: 'outil_menteur',
      input: {},
      parameterProvenance: {},
      operationId: operationId('liar'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('FAILED');
    expect(mayClaimSuccess(result.value.status)).toBe(false);
  });

  it('l\'échec de vérification est journalisé comme échec', async () => {
    const op = operationId('liar-journal');
    await stack.gateway.invoke({
      toolId: 'outil_menteur',
      input: {},
      parameterProvenance: {},
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    // Le journal fait foi : c'est de lui que viendra la réponse à
    // « as-tu vraiment fait ça ? » (05/B5).
    expect(found.value.status).toBe('FAILED');
  });

  /* ---------------------------------------------------------------------- */
  /* Relecture impossible ≠ échec                                            */
  /* ---------------------------------------------------------------------- */

  it('une relecture impossible produit UNKNOWN, pas FAILED', async () => {
    const engine = createVerificationEngine();
    const tool = defineTool({
      definition: {
        id: 'relecture_cassee',
        version: '1.0.0',
        description: 'La relecture échoue.',
        autonomy: 'L2',
        privacyClass: 'GREEN',
        reversible: true,
        networkRequired: false,
        parameters: [],
        idempotency: 'OPERATION_KEY',
        verification: 'READ_BACK',
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'UNREADABLE',
        requiredSecrets: [],
        rollback: 'Inconnu.',
        attemptVerification: 'NONE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null })),
      readBack: () =>
        Promise.resolve(
          err(jarvisError('PROVIDER_UNAVAILABLE', 'base injoignable')),
        ),
    });

    const outcome = await engine.verify(
      tool,
      { output: null },
      { db, secrets: new Map(), operationId: 'x', actor: 'USER' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // L'action a peut-être abouti. On ne le sait pas, et on le dit.
    expect(outcome.value.status).toBe('UNKNOWN');
    expect(outcome.value.detail).toContain('ne l\'affirme pas');
  });

  /* ---------------------------------------------------------------------- */
  /* PROVIDER_PROOF                                                          */
  /* ---------------------------------------------------------------------- */

  it('sans preuve du fournisseur, le statut reste UNKNOWN', async () => {
    const engine = createVerificationEngine();
    const tool = defineTool({
      definition: {
        id: 'envoi_sans_preuve',
        version: '1.0.0',
        description: 'Exige une preuve mais n\'en fournit pas.',
        autonomy: 'L3',
        privacyClass: 'ORANGE',
        reversible: false,
        networkRequired: true,
        parameters: [],
        idempotency: 'OPERATION_KEY',
        verification: 'PROVIDER_PROOF',
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'SENT',
        requiredSecrets: [],
        rollback: null,
        attemptVerification: 'NONE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null })),
    });

    const outcome = await engine.verify(
      tool,
      { output: null }, // aucune preuve
      { db, secrets: new Map(), operationId: 'x', actor: 'USER' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('UNKNOWN');
    expect(outcome.value.detail).toContain('réponse HTTP');
  });

  it('une preuve non recoupée donne PROBABLE, jamais CONFIRMED', async () => {
    const engine = createVerificationEngine();
    const tool = defineTool({
      definition: {
        id: 'envoi_avec_preuve',
        version: '1.0.0',
        description: 'Fournit une preuve, sans relecture indépendante.',
        autonomy: 'L3',
        privacyClass: 'ORANGE',
        reversible: false,
        networkRequired: true,
        parameters: [],
        idempotency: 'OPERATION_KEY',
        verification: 'PROVIDER_PROOF',
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'SENT',
        requiredSecrets: [],
        rollback: null,
        attemptVerification: 'NONE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null, proof: 'msg-42' })),
      // Pas de readBack : le fournisseur est cru sur parole, donc PROBABLE.
    });

    const outcome = await engine.verify(
      tool,
      { output: null, proof: 'msg-42' },
      { db, secrets: new Map(), operationId: 'x', actor: 'USER' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('PROBABLE');
    expect(outcome.value.proof).toBe('msg-42');
    expect(mayClaimSuccess(outcome.value.status)).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* Timeout                                                                 */
  /* ---------------------------------------------------------------------- */

  it('un outil qui dépasse son délai produit UNKNOWN, pas FAILED', async () => {
    stack.registerExtra(
      defineTool({
        definition: {
          id: 'outil_lent',
          version: '1.0.0',
          description: 'Ne rend jamais la main.',
          autonomy: 'L2',
          privacyClass: 'GREEN',
          reversible: true,
          networkRequired: false,
          parameters: [],
          idempotency: 'OPERATION_KEY',
          verification: 'READ_BACK',
          timeoutMs: 50,
          maxRetries: 0,
          auditEvent: 'SLOW',
          requiredSecrets: [],
          rollback: 'Inconnu.',
          attemptVerification: 'NONE',
        },
        inputSchema: z.object({}),
        execute: () =>
          new Promise((resolve) => {
            setTimeout(() => { resolve(ok({ output: null })); }, 5000);
          }),
      }),
    );

    const op = operationId('slow');
    const result = await stack.gateway.invoke({
      toolId: 'outil_lent',
      input: {},
      parameterProvenance: {},
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('TIMEOUT');

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    // Un dépassement de délai n'est pas un échec constaté : l'action a
    // peut-être abouti côté fournisseur.
    expect(found.value.status).toBe('UNKNOWN');
  });
});
