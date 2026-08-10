/**
 * Runtime applicatif — l'assemblage commun à toutes les interfaces.
 *
 * Référence : 02 Étape C, ADR-023.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le CLI et le serveur web doivent charger **exactement** le même noyau : mêmes
 * politiques, même Policy Gate, même Memory Guard, même journal. Dupliquer cet
 * assemblage, c'est accepter qu'un jour l'une des deux interfaces oublie une
 * pièce — et une pièce oubliée ici est une barrière de sécurité en moins.
 *
 * Une interface n'assemble rien. Elle reçoit un runtime et l'affiche.
 */
import { join } from 'node:path';
import { loadConfig } from '../core/config/load.js';
import { createDb, type Db } from '../core/db/client.js';
import { createLedger, type Ledger } from '../core/ledger/ledger.js';
import { createPolicyGate } from '../core/policy/gate.js';
import { createMemoryGuard } from '../core/memory/guard.js';
import { createMemoryInbox, type MemoryInbox } from '../core/memory/inbox.js';
import { createMemoryStore } from '../core/memory/store.js';
import { createHybridSearch } from '../core/memory/search.js';
import { createSessionStore, type SessionStore } from '../core/session/session.js';
import { createIntentEngine, type IntentEngine } from '../core/intent/engine.js';
import { createEnvSecretVault } from '../core/secrets/vault.js';
import { createToolGateway, type ToolGateway } from '../core/tools/gateway.js';
import { createVerificationEngine } from '../core/verification/engine.js';
import { createAssistant, type Assistant } from '../core/assistant.js';
import { createCedarEvaluator, loadPolicySource } from '../providers/policy/cedar.js';
import { registerCoreTools } from '../tools/index.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';

export interface Runtime {
  readonly db: Db;
  readonly gateway: ToolGateway;
  readonly ledger: Ledger;
  readonly inbox: MemoryInbox;
  readonly sessions: SessionStore;
  readonly intent: IntentEngine;
  readonly assistant: Assistant;
  /** Aucun fournisseur d'embeddings n'est câblé aujourd'hui — dit, pas masqué. */
  readonly embeddingsAvailable: boolean;
  readonly cloudEnabled: boolean;
  setUserConfirmed(value: boolean): void;
  close(): Promise<void>;
}

export function buildRuntime(db: Db, options: { policyDir?: string } = {}): Result<Runtime> {
  const source = loadPolicySource(options.policyDir ?? join(process.cwd(), 'policies'));
  if (!source.ok) return source;

  const store = createMemoryStore(db);
  const inbox = createMemoryInbox(db);
  const ledger = createLedger(db);

  const gateway = createToolGateway({
    db,
    gate: createPolicyGate(createCedarEvaluator(source.value)),
    vault: createEnvSecretVault(),
    ledger,
    verifier: createVerificationEngine(),
  });

  // La confirmation utilisateur est une propriété de la CONVERSATION : elle est
  // pilotée par la boucle, jamais devinée par un outil.
  let userConfirmed = false;
  const setUserConfirmed = (value: boolean): void => {
    userConfirmed = value;
  };

  const registered = registerCoreTools(gateway, {
    guard: createMemoryGuard(store, inbox),
    store,
    // Aucun fournisseur d'embeddings : la voie sémantique est indisponible, les
    // deux autres fonctionnent. C'est exactement le chemin « réseau coupé ».
    search: createHybridSearch(db, null),
    isUserConfirmed: () => userConfirmed,
  });
  if (!registered.ok) return registered;

  return ok({
    db,
    gateway,
    ledger,
    inbox,
    sessions: createSessionStore(db),
    intent: createIntentEngine(),
    assistant: createAssistant({
      intent: createIntentEngine(),
      gateway,
      setGuardConfirmed: setUserConfirmed,
    }),
    embeddingsAvailable: false,
    cloudEnabled: false,
    setUserConfirmed,
    close: () => db.close(),
  });
}

/** Charge la configuration, ouvre la base, assemble le noyau. */
export function openRuntime(): Result<Runtime> {
  const config = loadConfig();
  if (!config.ok) return config;

  const db = createDb({
    host: config.value.public.database.host,
    port: config.value.public.database.port,
    database: config.value.public.database.name,
    user: config.value.public.database.user,
    password: config.value.secret.databasePassword,
  });

  const runtime = buildRuntime(db);
  if (!runtime.ok) {
    void db.close();
    return err(
      jarvisError('CONFIGURATION', runtime.error.message, undefined, runtime.error),
    );
  }
  return runtime;
}
