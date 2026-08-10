/**
 * Porte de sortie Phase 2 — vérification exécutable.
 *
 * Les quatre conditions de `02`, éprouvées sur la vraie chaîne : Cedar,
 * politiques réelles, journal chaîné, vérification par relecture.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mint, type OperationIdentity } from '../../src/core/tools/identity.js';
import { createDb } from '../../src/core/db/client.js';
import { createLedger } from '../../src/core/ledger/ledger.js';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import { createMemoryStore } from '../../src/core/memory/store.js';
import { createHybridSearch } from '../../src/core/memory/search.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import { createToolGateway } from '../../src/core/tools/gateway.js';
import { createVerificationEngine } from '../../src/core/verification/engine.js';
import { createSnapshotStore } from '../../src/core/undo/snapshots.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../src/providers/policy/cedar.js';
import { registerCoreTools } from '../../src/tools/index.js';
import type { Db } from '../../src/core/db/client.js';

interface Check {
  readonly id: string;
  readonly label: string;
  run(): Promise<boolean> | boolean;
}

function runCommand(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

const dbConfigured =
  process.env['JARVIS_DB_PASSWORD'] !== undefined &&
  process.env['JARVIS_DB_PASSWORD'] !== '';

function db(): Db {
  return createDb({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password: process.env['JARVIS_DB_PASSWORD'] ?? '',
  });
}

function stack(connection: Db) {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);

  const store = createMemoryStore(connection);
  const gateway = createToolGateway({
    db: connection,
    gate: createPolicyGate(createCedarEvaluator(source.value)),
    vault: createEnvSecretVault({}),
    ledger: createLedger(connection),
    verifier: createVerificationEngine(),
  });

  const registered = registerCoreTools(gateway, {
    guard: createMemoryGuard(store, createMemoryInbox(connection)),
    store,
    search: createHybridSearch(connection, null),
    isUserConfirmed: () => true,
  });
  if (!registered.ok) throw new Error(registered.error.message);

  return { gateway, ledger: createLedger(connection), snapshots: createSnapshotStore(connection) };
}

let seq = 0;
function operationId(prefix: string): OperationIdentity {
  seq += 1;
  return mint(`gate2-${prefix}-${String(seq)}`);
}

const checks: readonly Check[] = [
  {
    id: 'G2.1',
    label: 'Une commande rejouée ne crée pas de doublon',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const op = operationId('idem');
        const title = `Porte Phase 2 ${op}`;
        const input = { title, dueAt: null };
        const call = {
          toolId: 'task_create',
          input,
          parameterProvenance: { title: 'USER', dueAt: 'USER' } as const,
          operationId: op,
          actor: 'USER' as const,
          context: {
            mode: 'NORMAL' as const,
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        };

        const first = await gateway.invoke(call);
        const second = await gateway.invoke(call);
        if (!first.ok || !second.ok) return false;
        if (first.value.replayed || !second.value.replayed) return false;

        const count = await connection.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM tasks WHERE title = $1',
          [title],
        );
        return count.ok && count.value.rows[0]?.n === '1';
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G2.2',
    label: 'Une mutation vérifiée avec succès est rapportée CONFIRMED',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const result = await gateway.invoke({
          toolId: 'note_create',
          input: { content: `Porte Phase 2 ${operationId('note')}` },
          parameterProvenance: { content: 'USER', privacyClass: 'SYSTEM' },
          operationId: operationId('note'),
          actor: 'USER',
          context: {
            mode: 'NORMAL',
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        });
        return (
          result.ok &&
          result.value.status === 'CONFIRMED' &&
          result.value.verification.detail.includes('État réel vérifié')
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G2.3',
    label: 'Une mutation dont l\'état réel a disparu est rapportée FAILED',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const op = operationId('gone');
        const content = `Porte Phase 2 disparue ${op}`;

        const created = await gateway.invoke({
          toolId: 'note_create',
          input: { content },
          parameterProvenance: { content: 'USER', privacyClass: 'SYSTEM' },
          operationId: op,
          actor: 'USER',
          context: {
            mode: 'NORMAL',
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        });
        if (!created.ok) return false;

        // La ressource disparaît hors de Jarvis.
        await connection.query('DELETE FROM notes WHERE operation_id = $1', [op]);

        const replay = await gateway.invoke({
          toolId: 'note_create',
          input: { content },
          parameterProvenance: { content: 'USER', privacyClass: 'SYSTEM' },
          operationId: op,
          actor: 'USER',
          context: {
            mode: 'NORMAL',
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        });
        // Jamais un succès que le monde ne confirme plus.
        return replay.ok && replay.value.status === 'FAILED';
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G2.4',
    label: 'Aucun outil du noyau ne réclame de secret',
    run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        return gateway
          .list()
          .every((tool) => tool.definition.requiredSecrets.length === 0);
      } finally {
        void connection.close();
      }
    },
  },
  {
    id: 'G2.5',
    label: 'Un paramètre sensible non fiable déclenche une confirmation',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const result = await gateway.invoke({
          toolId: 'note_create',
          input: { content: 'Porte Phase 2', privacyClass: 'GREEN' },
          parameterProvenance: {
            content: 'USER',
            privacyClass: 'EXTERNAL_UNTRUSTED',
          },
          operationId: operationId('tainted'),
          actor: 'USER',
          context: {
            mode: 'NORMAL',
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        });
        return (
          !result.ok &&
          result.error.kind === 'CONFIRMATION_REQUIRED' &&
          // La confirmation porte sur la valeur concrète, pas sur l'intention.
          result.error.details?.['privacyClass'] === 'GREEN'
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G2.6',
    label: 'Toute mutation capture de quoi être annulée (ADR-019)',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway, snapshots } = stack(connection);
        const op = operationId('undo');
        const created = await gateway.invoke({
          toolId: 'note_create',
          input: { content: `Porte Phase 2 annulable ${op}` },
          parameterProvenance: { content: 'USER', privacyClass: 'SYSTEM' },
          operationId: op,
          actor: 'USER',
          context: {
            mode: 'NORMAL',
            cloudEnabled: false,
            proactive: false,
            userConfirmed: false,
          },
        });
        if (!created.ok) return false;

        const snapshot = await snapshots.forOperation(op);
        return (
          snapshot.ok &&
          snapshot.value !== null &&
          snapshot.value.undoKind !== 'NOT_UNDOABLE'
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G2.7',
    label: 'Les cinq premiers outils sont enregistrés et conformes',
    run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const ids = gateway.list().map((t) => t.definition.id).sort();
        return (
          ids.length === 5 &&
          ids.join(',') ===
            'memory_add,memory_search,note_create,task_create,task_list'
        );
      } finally {
        void connection.close();
      }
    },
  },
  {
    id: 'G2.8',
    label: 'Tests outils et quarantaine passent',
    run: () =>
      runCommand('pnpm', ['test:tools']) && runCommand('pnpm', ['test:quarantine']),
  },
  {
    id: 'G2.9',
    label: 'Les Phases 0 et 1 restent franchies (aucune régression)',
    run: () =>
      runCommand('pnpm', ['test:contracts']) &&
      runCommand('pnpm', ['test:policy']) &&
      runCommand('pnpm', ['test:security']) &&
      runCommand('pnpm', ['test:memory']) &&
      runCommand('pnpm', ['test:context']),
  },
];

async function main(): Promise<void> {
  console.log('\n  PORTE DE SORTIE — PHASE 2\n');

  if (!dbConfigured) {
    console.log('  ⚠ JARVIS_DB_PASSWORD absent : les contrôles base échoueront.\n');
  }

  let failures = 0;
  for (const check of checks) {
    process.stdout.write(`  ${check.id.padEnd(6)} ${check.label} … `);
    let passed = false;
    try {
      passed = await check.run();
    } catch {
      passed = false;
    }
    console.log(passed ? 'OK' : 'ÉCHEC');
    if (!passed) failures += 1;
  }

  console.log('');
  if (failures === 0) {
    console.log('  ✓ Phase 2 franchie. Jarvis peut être utilisé en texte.\n');
    process.exit(0);
  }
  console.log(`  ✗ ${String(failures)} contrôle(s) en échec.\n`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('Vérification interrompue :', error);
  process.exit(1);
});
