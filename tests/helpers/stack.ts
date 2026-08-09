/**
 * Assemblage complet du noyau, pour les tests d'intégration.
 *
 * Monte la vraie chaîne : Policy Gate (Cedar + vraies politiques), Ledger,
 * Verification Engine, Tool Gateway, cinq outils. Aucun composant simulé côté
 * sécurité — un test de bout en bout adossé à un Policy Engine factice ne
 * prouverait que notre intention.
 */
import { join } from 'node:path';
import { createLedger } from '../../src/core/ledger/ledger.js';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import { createMemoryStore } from '../../src/core/memory/store.js';
import { createHybridSearch } from '../../src/core/memory/search.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import { createToolGateway, type ToolGateway } from '../../src/core/tools/gateway.js';
import { createVerificationEngine } from '../../src/core/verification/engine.js';
import { createSnapshotStore, type SnapshotStore } from '../../src/core/undo/snapshots.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../src/providers/policy/cedar.js';
import { registerCoreTools } from '../../src/tools/index.js';
import type { Db } from '../../src/core/db/client.js';
import type { EmbeddingProvider } from '../../src/providers/contract.js';
import type { Ledger } from '../../src/core/ledger/ledger.js';
import type { MemoryStore } from '../../src/core/memory/store.js';
import type { RegisteredTool } from '../../src/core/tools/contract.js';

export interface Stack {
  readonly gateway: ToolGateway;
  readonly ledger: Ledger;
  readonly store: MemoryStore;
  readonly snapshots: SnapshotStore;
  /** Pilote la confirmation utilisateur simulée du Memory Guard. */
  setUserConfirmed(value: boolean): void;
  registerExtra(tool: RegisteredTool): void;
}

export function buildStack(
  db: Db,
  options: { embeddings?: EmbeddingProvider | null } = {},
): Stack {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);

  const gate = createPolicyGate(createCedarEvaluator(source.value));
  const ledger = createLedger(db);
  const store = createMemoryStore(db);
  const inbox = createMemoryInbox(db);
  const guard = createMemoryGuard(store, inbox);
  const search = createHybridSearch(db, options.embeddings ?? null);
  const snapshots = createSnapshotStore(db);

  const gateway = createToolGateway({
    db,
    gate,
    vault: createEnvSecretVault({}),
    ledger,
    verifier: createVerificationEngine(),
  });

  let userConfirmed = true;
  const registered = registerCoreTools(gateway, {
    guard,
    store,
    search,
    isUserConfirmed: () => userConfirmed,
  });
  if (!registered.ok) throw new Error(registered.error.message);

  return {
    gateway,
    ledger,
    store,
    snapshots,
    setUserConfirmed(value: boolean) {
      userConfirmed = value;
    },
    registerExtra(tool: RegisteredTool) {
      const result = gateway.register(tool);
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}

let counter = 0;
export function operationId(prefix = 'op'): string {
  counter += 1;
  return `${prefix}-${String(Date.now())}-${String(counter)}`;
}

/** Contexte d'appel par défaut : local, explicite, hors mode privé. */
export function callContext(overrides: Partial<{
  mode: 'NORMAL' | 'PRIVATE';
  cloudEnabled: boolean;
  proactive: boolean;
  userConfirmed: boolean;
}> = {}) {
  return {
    mode: 'NORMAL' as const,
    cloudEnabled: false,
    proactive: false,
    userConfirmed: false,
    ...overrides,
  };
}
