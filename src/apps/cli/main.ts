/**
 * Jarvis — interface texte.
 *
 * Référence : 02 Étape C, `06 §Style des réponses`.
 *
 * La chaîne complète, en une boucle :
 *
 *   saisie → intention → Policy Gate → outil → vérification → journal → réponse
 *
 * Aucun modèle n'est requis. L'Intent Engine fonctionne au Tier 0 (règles), ce
 * qui rend cette interface conforme aux invariants I1 et I2 dès la première
 * exécution : Jarvis comprend, mémorise, retrouve et exécute sans Internet et
 * sans fournisseur IA.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { loadConfig } from '../../core/config/load.js';
import { createDb, type Db } from '../../core/db/client.js';
import { createLedger, type Ledger } from '../../core/ledger/ledger.js';
import { createPolicyGate } from '../../core/policy/gate.js';
import { createMemoryGuard } from '../../core/memory/guard.js';
import { createMemoryInbox, type MemoryInbox } from '../../core/memory/inbox.js';
import { createMemoryStore } from '../../core/memory/store.js';
import { createHybridSearch } from '../../core/memory/search.js';
import { createSessionStore, type SessionStore } from '../../core/session/session.js';
import { createIntentEngine, type IntentEngine } from '../../core/intent/engine.js';
import { createEnvSecretVault } from '../../core/secrets/vault.js';
import { createToolGateway, type ToolGateway } from '../../core/tools/gateway.js';
import { createVerificationEngine } from '../../core/verification/engine.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../providers/policy/cedar.js';
import { registerCoreTools } from '../../tools/index.js';
import { randomUUID } from 'node:crypto';
import {
  announce,
  confirmationPrompt,
  isAffirmative,
  isNegative,
  mark,
} from './report.js';

const BANNER = `
  JARVIS — interface texte

  Aucun modèle requis : l'analyse d'intention fonctionne par règles (Tier 0).
  Tape « /aide » pour les commandes, « /quitter » pour sortir.
`;

const HELP = `
  Ce que je sais faire aujourd'hui :

    note <texte>                    créer une note
    ajoute <chose> à ma liste       créer une tâche
    rappelle-moi de <chose>         créer une tâche
    mes tâches                      lister les tâches ouvertes
    retiens que <fait>              mémoriser
    que sais-tu sur <sujet>         chercher en mémoire

  Commandes :

    /audit          ce que j'ai fait, depuis le journal
    /inbox          les mémoires en attente de ta confirmation
    /diagnostic     état du système
    /aide           ce message
    /quitter        fin de session
`;

interface Runtime {
  readonly db: Db;
  readonly gateway: ToolGateway;
  readonly ledger: Ledger;
  readonly inbox: MemoryInbox;
  readonly sessions: SessionStore;
  readonly intent: IntentEngine;
  setUserConfirmed(value: boolean): void;
}

function buildRuntime(db: Db): Runtime {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);

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

  // La confirmation utilisateur est une propriété de la conversation : elle est
  // pilotée par la boucle, jamais devinée par un outil.
  let userConfirmed = false;

  const registered = registerCoreTools(gateway, {
    guard: createMemoryGuard(store, inbox),
    store,
    // Aucun fournisseur d'embeddings : la voie sémantique est indisponible, les
    // deux autres fonctionnent. C'est exactement le chemin « réseau coupé ».
    search: createHybridSearch(db, null),
    isUserConfirmed: () => userConfirmed,
  });
  if (!registered.ok) throw new Error(registered.error.message);

  return {
    db,
    gateway,
    ledger,
    inbox,
    sessions: createSessionStore(db),
    intent: createIntentEngine(),
    setUserConfirmed(value: boolean) {
      userConfirmed = value;
    },
  };
}

/** Rend une valeur inconnue en texte, sans jamais produire « [object Object] ». */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** Rend lisible la sortie d'un outil, sans la paraphraser. */
function renderOutput(toolId: string, output: unknown): string {
  if (typeof output !== 'object' || output === null) return '';
  const record = output as Record<string, unknown>;

  if (toolId === 'task_list' && Array.isArray(record['tasks'])) {
    const tasks = record['tasks'] as { title?: unknown }[];
    if (tasks.length === 0) return '  Aucune tâche ouverte.';
    return tasks.map((t) => `  • ${text(t.title)}`).join('\n');
  }

  if (toolId === 'memory_search' && Array.isArray(record['results'])) {
    const results = record['results'] as { content?: unknown; kind?: unknown }[];
    const lines: string[] = [];
    if (record['degraded'] === true) {
      // La dégradation est dite, pas masquée par un résultat plus court.
      lines.push('  (recherche sans la voie sémantique — aucun modèle d\'embeddings)');
    }
    if (results.length === 0) {
      lines.push('  Rien trouvé.');
      return lines.join('\n');
    }
    for (const r of results) {
      lines.push(`  • ${text(r.content)}  [${text(r.kind)}]`);
    }
    return lines.join('\n');
  }

  if (toolId === 'memory_add') {
    if (record['outcome'] === 'QUEUED') {
      return '  Déposé dans l\'inbox : je te demanderai confirmation avant de le retenir.';
    }
    if (record['outcome'] === 'DEDUPLICATED') {
      return '  Je le savais déjà.';
    }
    const adjustments = record['adjustments'];
    if (Array.isArray(adjustments) && adjustments.length > 0) {
      return adjustments.map((a) => `  (${text(a)})`).join('\n');
    }
  }

  return '';
}

async function showAudit(runtime: Runtime): Promise<void> {
  const recent = await runtime.ledger.recent(200);
  if (!recent.ok) {
    stdout.write(`  Journal illisible : ${recent.error.message}\n`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const events = recent.value.filter((e) => e.occurredAt.startsWith(today));

  if (events.length === 0) {
    stdout.write('  Rien aujourd\'hui.\n');
    return;
  }

  // La réponse vient du JOURNAL, pas d'une reconstruction. C'est la propriété
  // que teste 05/A9, et la raison d'être du chaînage append-only.
  const byType = new Map<string, number>();
  for (const event of events) {
    const key = `${event.eventType} [${event.status}]`;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  stdout.write('  Depuis le journal d\'exécution :\n\n');
  for (const [type, count] of [...byType.entries()].sort()) {
    stdout.write(`    ${String(count).padStart(3)} × ${type}\n`);
  }

  const chain = await runtime.ledger.verifyChain();
  if (chain.ok) {
    stdout.write(
      chain.value.valid
        ? `\n  Chaîne d'audit intacte (${String(chain.value.checked)} événements).\n`
        : `\n  ⚠ CHAÎNE D'AUDIT ROMPUE : ${chain.value.brokenAt?.reason ?? ''}\n`,
    );
  }
}

async function showInbox(runtime: Runtime): Promise<void> {
  const pending = await runtime.inbox.pending();
  if (!pending.ok) {
    stdout.write(`  Inbox illisible : ${pending.error.message}\n`);
    return;
  }
  if (pending.value.length === 0) {
    stdout.write('  Rien en attente.\n');
    return;
  }
  stdout.write('  En attente de ta confirmation :\n\n');
  for (const candidate of pending.value) {
    stdout.write(`    • ${candidate.content}\n`);
    stdout.write(
      `      ${candidate.memoryType} · origine ${candidate.sourceType} · ` +
        `confiance ${candidate.suggestedConfidence.toFixed(2)}\n`,
    );
  }
}

async function showDiagnostic(runtime: Runtime): Promise<void> {
  const tools = runtime.gateway.list();
  const chain = await runtime.ledger.verifyChain();
  const pending = await runtime.inbox.pending(1000);

  stdout.write(`  Outils         ${String(tools.length)} enregistrés\n`);
  stdout.write(
    `  Journal        ${
      chain.ok
        ? chain.value.valid
          ? `intact (${String(chain.value.checked)} événements)`
          : 'ROMPU'
        : 'illisible'
    }\n`,
  );
  stdout.write(
    `  Inbox          ${pending.ok ? String(pending.value.length) : '?'} en attente\n`,
  );
  stdout.write('  Embeddings     absents — voie sémantique indisponible\n');
  stdout.write('  Cloud          désactivé\n');
}

async function handleText(
  runtime: Runtime,
  sessionId: string,
  text: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const proposal = runtime.intent.propose(text);

  if (proposal.kind === 'CLARIFY') {
    stdout.write(`  ${proposal.question}\n`);
    return;
  }

  if (proposal.kind === 'UNSUPPORTED') {
    // PRD §23 : jamais « je n'ai pas compris ». On dit ce qu'on a saisi et ce
    // qui manque.
    stdout.write(`  Je comprends ${proposal.understood}.\n`);
    stdout.write(`  Il me manque ${proposal.missing}\n`);
    return;
  }

  const operationId = randomUUID();

  const invoke = (userConfirmed: boolean) =>
    runtime.gateway.invoke({
      toolId: proposal.toolId,
      input: proposal.input,
      parameterProvenance: proposal.parameterProvenance,
      operationId,
      actor: 'USER',
      context: {
        mode: 'NORMAL',
        cloudEnabled: false,
        proactive: false,
        userConfirmed,
      },
    });

  // « Retiens que X » vaut confirmation ; « mes tâches » non.
  runtime.setUserConfirmed(proposal.userConfirms);
  let result = await invoke(false);

  /* --- Confirmation ---------------------------------------------------- */
  if (!result.ok && result.error.kind === 'CONFIRMATION_REQUIRED') {
    const answer = await ask(
      confirmationPrompt(result.error.message, result.error.details ?? {}),
    );

    if (isNegative(answer)) {
      stdout.write('  Annulé. Rien n\'a été fait.\n');
      return;
    }
    if (!isAffirmative(answer)) {
      // PRD §135 : une réponse ambiguë n'est pas une confirmation.
      stdout.write('  Je n\'ai pas compris comme un oui. Rien n\'a été fait.\n');
      return;
    }

    runtime.setUserConfirmed(true);
    result = await invoke(true);
    runtime.setUserConfirmed(false);
  }

  if (!result.ok) {
    if (result.error.kind === 'POLICY_DENIED') {
      stdout.write(`  Refusé : ${result.error.message}\n`);
    } else {
      stdout.write(`  ${result.error.message}\n`);
    }
    return;
  }

  stdout.write(`  ${mark(result.value.status)} ${announce(result.value.verification)}\n`);
  const rendered = renderOutput(proposal.toolId, result.value.output);
  if (rendered.length > 0) stdout.write(`${rendered}\n`);

  await runtime.sessions.appendTurn(sessionId, {
    speaker: 'JARVIS',
    content: `${proposal.toolId} → ${result.value.status}`,
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.ok) {
    stdout.write(`✗ ${config.error.message}\n`);
    process.exit(1);
  }

  const db = createDb({
    host: config.value.public.database.host,
    port: config.value.public.database.port,
    database: config.value.public.database.name,
    user: config.value.public.database.user,
    password: config.value.secret.databasePassword,
  });

  const runtime = buildRuntime(db);
  const session = await runtime.sessions.start('NORMAL');
  if (!session.ok) {
    stdout.write(`✗ ${session.error.message}\n`);
    await db.close();
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(BANNER);

  // Itérateur plutôt que `rl.question()` en boucle : avec une entrée redirigée
  // (`printf … | pnpm jarvis`), le flux se ferme dès la fin des données et les
  // appels suivants à `question()` échouent sur « readline was closed ». Lire
  // ligne à ligne fonctionne dans les deux modes, interactif comme scripté.
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (prompt: string): Promise<string | null> => {
    stdout.write(prompt);
    const next: IteratorResult<string> = await lines.next();
    return next.done === true ? null : next.value;
  };

  try {
    for (;;) {
      const raw = await nextLine('\n> ');
      if (raw === null) break; // fin d'entrée
      const line = raw.trim();
      if (line.length === 0) continue;

      if (line === '/quitter' || line === '/quit') break;
      if (line === '/aide' || line === '/help') {
        stdout.write(HELP);
        continue;
      }
      if (line === '/audit') {
        await showAudit(runtime);
        continue;
      }
      if (line === '/inbox') {
        await showInbox(runtime);
        continue;
      }
      if (line === '/diagnostic') {
        await showDiagnostic(runtime);
        continue;
      }
      // « Qu'as-tu fait aujourd'hui ? » est un critère de succès V1 : la
      // réponse vient du journal, pas du modèle (05/A9).
      if (/^qu(?:'|’)as-tu fait/iu.test(line)) {
        await showAudit(runtime);
        continue;
      }

      await runtime.sessions.appendTurn(session.value.id, {
        speaker: 'USER',
        content: line,
      });

      await handleText(runtime, session.value.id, line, async (q) => {
        const answer = await nextLine(`\n  ${q}\n  > `);
        // Fin d'entrée pendant une demande de confirmation : ce n'est pas un
        // oui. L'absence de réponse ne vaut jamais accord (PRD §135).
        return answer ?? '';
      });
    }
  } finally {
    rl.close();
    await runtime.sessions.end(session.value.id);
    await db.close();
  }

  stdout.write('\n  À bientôt.\n');
}

main().catch((error: unknown) => {
  stdout.write(
    `\n✗ Interrompu : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
