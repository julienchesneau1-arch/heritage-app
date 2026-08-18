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
 *
 * Ce fichier ne décide de rien : il lit des lignes, appelle l'Assistant, et
 * affiche. Toute la logique est dans `src/core/assistant.ts` et
 * `src/apps/reports.ts`, partagés avec la passerelle web (ADR-023).
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mint } from '../../core/tools/identity.js';
import { openRuntime, type Runtime } from '../runtime.js';
import { auditReport, diagnosticReport, inboxReport } from '../reports.js';
import type { AssistantReply } from '../../core/assistant.js';
import {
  announce,
  confirmationPrompt,
  readConfirmation,
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
    /annule         défaire la dernière action annulable
    /inbox          les mémoires en attente de ta confirmation
    /diagnostic     état du système
    /aide           ce message
    /quitter        fin de session
`;

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
  const record: Record<string, unknown> = { ...output };

  if (toolId === 'task_list' && Array.isArray(record['tasks'])) {
    const tasks: unknown[] = record['tasks'];
    if (tasks.length === 0) return '  Aucune tâche ouverte.';
    return tasks
      .map((t) => {
        const item: Record<string, unknown> =
          typeof t === 'object' && t !== null ? { ...t } : {};
        return `  • ${text(item['title'])}`;
      })
      .join('\n');
  }

  if (toolId === 'memory_search' && Array.isArray(record['results'])) {
    const results: unknown[] = record['results'];
    const lines: string[] = [];
    // La PORTÉE est dite à chaque fois, pas seulement quand rien n'est trouvé :
    // l'utilisateur doit savoir ce qui n'a pas été consulté (HIGH-4).
    const scope = text(record['scopeLabel']);
    if (scope.length > 0) lines.push(`  (${scope})`);
    if (record['degraded'] === true) {
      // La dégradation est dite, pas masquée par un résultat plus court.
      lines.push('  (recherche sans la voie sémantique — aucun modèle d\'embeddings)');
    }
    if (results.length === 0) {
      lines.push('  Rien trouvé dans ta mémoire personnelle.');
      return lines.join('\n');
    }
    for (const r of results) {
      const item: Record<string, unknown> =
        typeof r === 'object' && r !== null ? { ...r } : {};
      lines.push(`  • ${text(item['content'])}  [${text(item['kind'])}]`);
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
      const list: unknown[] = adjustments;
      return list.map((a) => `  (${text(a)})`).join('\n');
    }
  }

  return '';
}

async function showAudit(runtime: Runtime): Promise<void> {
  const report = await auditReport(runtime);
  if (!report.ok) {
    stdout.write(`  Journal illisible : ${report.error.message}\n`);
    return;
  }
  if (report.value.events.length === 0) {
    stdout.write('  Rien aujourd\'hui.\n');
    return;
  }

  // La réponse vient du JOURNAL, pas d'une reconstruction. C'est la propriété
  // que teste 05/A9, et la raison d'être du chaînage append-only.
  stdout.write('  Depuis le journal d\'exécution :\n\n');
  for (const entry of report.value.events) {
    stdout.write(
      `    ${String(entry.count).padStart(3)} × ${entry.type} [${entry.status}]\n`,
    );
  }
  stdout.write(
    report.value.chainValid
      ? `\n  Chaîne d'audit intacte (${String(report.value.chainLength)} événements).\n`
      : `\n  ⚠ CHAÎNE D'AUDIT ROMPUE : ${report.value.brokenAt ?? ''}\n`,
  );
}

async function showInbox(runtime: Runtime): Promise<void> {
  const report = await inboxReport(runtime);
  if (!report.ok) {
    stdout.write(`  Inbox illisible : ${report.error.message}\n`);
    return;
  }
  if (report.value.candidates.length === 0) {
    stdout.write('  Rien en attente.\n');
    return;
  }
  stdout.write('  En attente de ta confirmation :\n\n');
  for (const candidate of report.value.candidates) {
    stdout.write(`    • ${candidate.content}\n`);
    stdout.write(
      `      ${candidate.memoryType} · origine ${candidate.sourceType} · ` +
        `confiance ${candidate.confidence.toFixed(2)}\n`,
    );
  }

  /* LA TRONCATURE SE DIT (ADR-064). La liste s'arrête à vingt ; sans cette
     ligne, vingt candidats affichés sur cinquante se lisent comme cinquante.
     Le correctif ne vaut que s'il arrive jusqu'à l'œil — la leçon d'ADR-063,
     où le pipeline avait été réparé et l'affichage oublié. */
  const restants = report.value.total - report.value.candidates.length;
  if (restants > 0) {
    stdout.write(
      `\n    … et ${String(restants)} autre${restants > 1 ? 's' : ''} ` +
        `(${String(report.value.total)} en attente au total).\n`,
    );
  }
}

/**
 * « Annule la dernière action. » — `docs/09 §2.1`, ADR-066.
 *
 * TROIS TEMPS, ET L'ORDRE EST LE SUJET : montrer, demander, agir.
 *
 * Annuler passe par le Policy Gate comme toute action. `memory_add` est `L2` ;
 * son inverse `memory_forget` est `L4`. **Défaire coûte donc plus cher que
 * faire**, et c'est l'humain qui paie la différence — pas le moteur en se
 * confirmant lui-même.
 */
async function annulerDerniere(
  runtime: Runtime,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const apercu = await runtime.undo.previewLast();
  if (!apercu.ok) {
    stdout.write(`  Annulation indisponible : ${apercu.error.message}\n`);
    return;
  }
  if (apercu.value === null) {
    stdout.write('  Rien à annuler.\n');
    return;
  }

  // Un empêchement se dit AVANT la question : demander un accord pour une
  // action qu'on sait refusée fait perdre le temps de l'utilisateur et use la
  // confirmation.
  if (apercu.value.empechement !== null) {
    stdout.write(`  Impossible d'annuler : ${apercu.value.empechement}.\n`);
    return;
  }

  const quoi =
    `${apercu.value.resource.kind} ${apercu.value.resource.id} ` +
    `(par ${apercu.value.inverseToolId ?? '?'})`;
  stdout.write(
    `\n${confirmationPrompt('Annuler la dernière action ?', { cible: quoi })}\n`,
  );

  const reponse = await ask('');
  // Le refus est lu EN PREMIER (ADR-061) : « non » ne doit jamais tomber dans
  // la branche « oui » par contenance.
  if (readConfirmation(reponse) !== 'CONFIRM') {
    stdout.write("  Annulation abandonnée. Rien n'a été défait.\n");
    return;
  }

  const fait = await runtime.undo.undoLast({
    mode: 'NORMAL',
    cloudEnabled: runtime.cloudEnabled,
    proactive: false,
    // L'humain vient de dire oui, ici, sur cette cible précise.
    userConfirmed: true,
  });
  if (!fait.ok) {
    stdout.write(`  ${mark('FAILED')} ${fait.error.message}\n`);
    return;
  }
  stdout.write(`  ${mark(fait.value.status)} ${fait.value.detail}\n`);
}

async function showDiagnostic(runtime: Runtime): Promise<void> {
  const report = await diagnosticReport(runtime);
  if (!report.ok) {
    stdout.write(`  Diagnostic indisponible : ${report.error.message}\n`);
    return;
  }
  const d = report.value;
  stdout.write(
    `  Base           ${d.database === 'UP' ? 'joignable' : 'INJOIGNABLE'}\n`,
  );
  stdout.write(`  Outils         ${String(d.tools)} enregistrés\n`);
  stdout.write(
    `  Journal        ${
      d.chainValid ? `intact (${String(d.chainLength)} événements)` : 'ROMPU'
    }\n`,
  );
  stdout.write(`  Inbox          ${String(d.pending)} en attente\n`);
  stdout.write(
    `  Embeddings     ${
      d.embeddings ? 'disponibles' : 'absents — voie sémantique indisponible'
    }\n`,
  );
  stdout.write(`  Cloud          ${d.cloud ? 'activé' : 'désactivé'}\n`);
}

function show(reply: AssistantReply): void {
  switch (reply.kind) {
    case 'CLARIFY':
      stdout.write(`  ${reply.question}\n`);
      return;

    case 'UNSUPPORTED':
      // PRD §23 : jamais « je n'ai pas compris ». On dit ce qu'on a saisi et ce
      // qui manque.
      stdout.write(`  Je comprends ${reply.understood}.\n`);
      stdout.write(`  Il me manque ${reply.missing}\n`);
      return;

    case 'DENIED':
      stdout.write(`  Refusé : ${reply.reason}\n`);
      return;

    case 'ERROR':
      stdout.write(`  ${reply.message}\n`);
      return;

    case 'CONFIRM':
      // Traité par l'appelant : il faut poser la question à l'utilisateur.
      return;

    case 'DONE': {
      // Une LECTURE ne s'annonce pas « C'est fait » : il n'y a rien eu à
      // faire. Dire « c'est fait » sur une recherche vide était une petite
      // malhonnêteté, mais une malhonnêteté quand même (audit `docs/11`,
      // LOW-3).
      const readOnly = reply.toolId === 'memory_search' || reply.toolId === 'task_list';
      stdout.write(
        readOnly && reply.status === 'CONFIRMED'
          ? '  ✓ Voici ce que j\'ai trouvé.\n'
          : `  ${mark(reply.status)} ${announce({ status: reply.status, detail: reply.detail })}\n`,
      );
      const rendered = renderOutput(reply.toolId, reply.output);
      if (rendered.length > 0) stdout.write(`${rendered}\n`);
      return;
    }
  }
}

async function handleText(
  runtime: Runtime,
  sessionId: string,
  line: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  // La clé d'opération est fixée AVANT le premier essai : confirmer ne crée pas
  // une nouvelle opération, cela rejoue la même (idempotence, ADR-013).
  const operationId = mint();
  let reply = await runtime.assistant.say(line, { operationId });

  if (reply.kind === 'CONFIRM') {
    const answer = await ask(confirmationPrompt(reply.reason, reply.values));

    /* UNE SEULE LECTURE, TROIS ISSUES — et deux d'entre elles ne font rien.
       La décision vit dans `report.ts` et y est éprouvée : elle n'a plus à
       être reconstituée ici par une chaîne de `if` que rien ne traverse. */
    const lecture = readConfirmation(answer);
    if (lecture === 'REFUSE') {
      stdout.write('  Annulé. Rien n\'a été fait.\n');
      return;
    }
    if (lecture === 'UNCLEAR') {
      // PRD §135 : une réponse ambiguë n'est pas une confirmation.
      stdout.write('  Je n\'ai pas compris comme un oui. Rien n\'a été fait.\n');
      return;
    }

    reply = await runtime.assistant.say(line, {
      operationId: reply.operationId,
      confirm: true,
    });
  }

  show(reply);

  if (reply.kind === 'DONE') {
    await runtime.sessions.appendTurn(sessionId, {
      speaker: 'JARVIS',
      content: `${reply.toolId} → ${reply.status}`,
    });
  }
}

async function main(): Promise<void> {
  const runtime = openRuntime();
  if (!runtime.ok) {
    stdout.write(`✗ ${runtime.error.message}\n`);
    process.exit(1);
  }

  const session = await runtime.value.sessions.start('NORMAL');
  if (!session.ok) {
    stdout.write(`✗ ${session.error.message}\n`);
    await runtime.value.close();
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
        await showAudit(runtime.value);
        continue;
      }
      if (line === '/annule' || /^annule la derni[eè]re action/iu.test(line)) {
        /* « Annule la dernière action. » est la formulation de `docs/09 §2.1`.
           Elle est reconnue en toutes lettres autant que par la commande : le
           scénario du document est écrit en français, pas en slash. */
        await annulerDerniere(runtime.value, async (q: string) => {
          const answer = await nextLine(`\n  ${q}\n  > `);
          // Fin d'entrée pendant une confirmation : ce n'est pas un oui.
          return answer ?? '';
        });
        continue;
      }
      if (line === '/inbox') {
        await showInbox(runtime.value);
        continue;
      }
      if (line === '/diagnostic') {
        await showDiagnostic(runtime.value);
        continue;
      }
      // « Qu'as-tu fait aujourd'hui ? » est un critère de succès V1 : la
      // réponse vient du journal, pas du modèle (05/A9).
      if (/^qu(?:'|’)as-tu fait/iu.test(line)) {
        await showAudit(runtime.value);
        continue;
      }

      await runtime.value.sessions.appendTurn(session.value.id, {
        speaker: 'USER',
        content: line,
      });

      await handleText(runtime.value, session.value.id, line, async (q) => {
        const answer = await nextLine(`\n  ${q}\n  > `);
        // Fin d'entrée pendant une demande de confirmation : ce n'est pas un
        // oui. L'absence de réponse ne vaut jamais accord (PRD §135).
        return answer ?? '';
      });
    }
  } finally {
    rl.close();
    await runtime.value.sessions.end(session.value.id);
    await runtime.value.close();
  }

  stdout.write('\n  À bientôt.\n');
}

main().catch((error: unknown) => {
  stdout.write(
    `\n✗ Interrompu : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
