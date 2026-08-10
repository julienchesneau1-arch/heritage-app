/**
 * Assemblage du banc de défaillance.
 *
 * Monte la vraie chaîne de sécurité — Cedar, Ledger, Verification Engine, Tool
 * Gateway — et y branche un outil dont l'effet est réellement externe. Aucun
 * composant de sécurité n'est simulé : un banc adossé à un Policy Engine
 * factice ne prouverait que notre intention.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { join } from 'node:path';
import { createDb, type Db } from '../../src/core/db/client.js';
import { createLedger, type Ledger } from '../../src/core/ledger/ledger.js';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import { createToolGateway, type ToolGateway } from '../../src/core/tools/gateway.js';
import { createVerificationEngine } from '../../src/core/verification/engine.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../src/providers/policy/cedar.js';
import type { RegisteredTool } from '../../src/core/tools/contract.js';
import type { ToolCall } from '../../src/core/tools/gateway.js';
import { mint, type OperationIdentity } from '../../src/core/tools/identity.js';

/** Connexion applicative avec un pool dimensionné pour la concurrence. */
export function labDb(poolMax = 40): Db {
  const password = process.env['JARVIS_DB_PASSWORD'];
  if (password === undefined || password === '') {
    throw new Error('JARVIS_DB_PASSWORD absent : le banc exige une base de test.');
  }
  return createDb({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password,
    poolMax,
  });
}

export interface LabStack {
  readonly gateway: ToolGateway;
  readonly ledger: Ledger;
  register(tool: RegisteredTool): void;
}

export function buildLabStack(db: Db): LabStack {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);

  const gateway = createToolGateway({
    db,
    gate: createPolicyGate(createCedarEvaluator(source.value)),
    vault: createEnvSecretVault({}),
    ledger: createLedger(db),
    verifier: createVerificationEngine(),
  });

  return {
    gateway,
    ledger: createLedger(db),
    register(tool: RegisteredTool): void {
      const registered = gateway.register(tool);
      if (!registered.ok) throw new Error(registered.error.message);
    },
  };
}

/**
 * Appel type du banc : sortie réseau autorisée, aucune donnée sensible.
 *
 * `cloudEnabled: true` est nécessaire — un outil `networkRequired` est refusé
 * sinon, et c'est une propriété qu'on vérifie ailleurs plutôt que de la
 * contourner ici sans le dire.
 */
export function labCall(
  operationId: OperationIdentity,
  overrides: Partial<ToolCall> = {},
): ToolCall {
  return {
    toolId: 'lab_external_send',
    input: { payload: 'charge utile' },
    parameterProvenance: { payload: 'USER' },
    operationId,
    actor: 'USER',
    context: {
      mode: 'NORMAL',
      cloudEnabled: true,
      proactive: false,
      userConfirmed: true,
    },
    ...overrides,
  };
}

let counter = 0;
export function labKey(prefix = 'lab'): OperationIdentity {
  counter += 1;
  return mint(`${prefix}-${String(counter)}`);
}
