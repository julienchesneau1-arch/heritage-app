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
import { mint, fromClient } from '../../core/tools/identity.js';
import { openRuntime, type Runtime } from '../runtime.js';
import { ecouter } from '../../core/voice/turn.js';
import { capacitesParlees } from '../../core/intent/engine.js';
import { enteteDeReponse, lignesDeSortie } from '../render-sortie.js';
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

/* ⚠ CETTE LISTE ÉTAIT ÉCRITE À LA MAIN — le sixième registre de la même chose
   (ADR-075), et il avait divergé comme les cinq autres : il ignorait
   `enregistre … comme personne`, ajouté trois commits plus tôt.

   Elle est désormais DÉRIVÉE des règles du moteur. Une capacité ne peut plus
   exister sans être annoncée, ni être annoncée sans exister. */
const HELP = `
  Ce que je sais faire aujourd'hui :

${capacitesParlees()
  .map((c) => `    ${c}`)
  .join('\n')}

  Commandes :

    /audit          ce que j'ai fait, depuis le journal
    /annule         défaire la dernière action annulable
    /reprendre <raison>
                    lever un arrêt d'urgence — dis « arrête tout » pour l'engager
    /confirmer      exécuter ce qui a été préparé depuis le téléphone
    /inbox          les mémoires en attente de ta confirmation
    /diagnostic     état du système
    /aide           ce message
    /quitter        fin de session
`;

/* ⚠ `renderOutput` ET `text` ONT ÉTÉ RETIRÉS D'ICI — ADR-100.

   Ils traitaient `task_list`, `memory_search` et `memory_add`, et rendaient la
   chaîne VIDE pour les dix-huit autres outils. « fais-moi un point » affichait
   une coche et jetait le briefing entier.

   Et le script servi au téléphone portait la MÊME logique, en JavaScript,
   couvrant les mêmes trois outils — deux copies d'un même fait qui auraient
   divergé à la première correction faite d'un seul côté.

   `src/apps/render-sortie.ts` est désormais le seul endroit, et un test exige
   qu'il couvre CHAQUE outil enregistré. */


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

/* ⚠ `annulerDerniere` A ÉTÉ SUPPRIMÉE D'ICI — ADR-105.

   Elle portait tout le scénario `docs/09 §2.1` : aperçu, question, exécution.
   C'était un SECOND registre du même fait — la première copie étant
   l'Assistant, qui ne le portait pas encore. Le résultat était mesurable :

       CLI        « annule la dernière action »  →  marchait
       say()      la même phrase                  →  « capacité absente »
       téléphone  rien du tout

   Le scénario vit désormais dans `src/core/assistant.ts`, comme tout le reste,
   et cette interface se contente d'afficher. */

/**
 * LES INTENTIONS PRÉPARÉES AILLEURS — ADR-099.
 *
 * Le téléphone a demandé une action irréversible. ADR-090 l'a refusée : une
 * confirmation renvoyée par le même canal que la demande ne prouve rien. Elle a
 * donc été mise en file, et c'est ici — devant la machine — qu'un humain
 * décide.
 *
 * ⚠⚠ LA CHAÎNE EST REJOUÉE EN ENTIER, ET C'EST TOUT LE SUJET.
 *
 * On n'exécute pas « ce que la file a autorisé » : la file n'autorise rien.
 * On rejoue `gateway.invoke` avec l'appel stocké, sur la surface `LOCALE`, et
 * le Policy Gate décide de nouveau — Cedar compris.
 *
 * Sans ce rejeu, la file deviendrait un contournement : il suffirait d'y
 * écrire une ligne pour obtenir demain ce qui est interdit aujourd'hui. Avec
 * lui, y écrire une ligne ne donne que le droit d'être RELU par un humain.
 */
async function confirmerEnAttente(
  runtime: Runtime,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const attente = await runtime.file.enAttente();
  if (!attente.ok) {
    stdout.write(`  File indisponible : ${attente.error.message}\n`);
    return;
  }
  if (attente.value.length === 0) {
    stdout.write('  Rien n’attend ta confirmation.\n');
    return;
  }

  for (const demande of attente.value) {
    /* CE QUI EST MONTRÉ EST CE QUI SERA FAIT. Le résumé vient de la file, et
       il a été produit par `libelleSur` (ADR-096) : une mémoire dont le
       plancher dépasse PERSONAL y est NOMMÉE, jamais citée. */
    stdout.write(
      `\n  Demandé depuis ${demande.demandeeDe === 'DISTANTE' ? 'le téléphone' : 'cette machine'}` +
        ` · expire dans ${String(demande.minutesRestantes)} min\n`,
    );
    stdout.write(
      `${confirmationPrompt('Exécuter cette action ?', { action: demande.resume })}\n`,
    );

    const reponse = await ask('');
    // Le refus est lu EN PREMIER (ADR-061) : « non » ne tombe jamais dans la
    // branche « oui » par contenance.
    if (readConfirmation(reponse) !== 'CONFIRM') {
      const refus = await runtime.file.refuser(demande.id);
      stdout.write(
        refus.ok
          ? '  Abandonnée. Rien n’a été fait.\n'
          : `  ${mark('FAILED')} ${refus.error.message}\n`,
      );
      continue;
    }

    /* ⚠ ON MARQUE AVANT D'EXÉCUTER, et c'est délibéré.

       L'ordre inverse — exécuter puis marquer — laisserait, si le processus
       meurt entre les deux, une intention TOUJOURS EN ATTENTE dont l'effet a
       déjà eu lieu. Le prochain `/confirmer` la reproposerait, et
       l'utilisateur l'exécuterait deux fois.

       Dans cet ordre, une mort au même endroit laisse une intention marquée
       confirmée sans effet : Jarvis n'a rien fait, et il ne prétend rien
       avoir fait. C'est le même arbitrage que l'Undo Engine — on préfère
       l'action manquante à l'action dupliquée.

       La clé d'opération (ADR-030) protège de toute façon le rejeu côté
       outil : c'est une ceinture de plus, pas la seule. */
    const pris = await runtime.file.confirmer(demande.id);
    if (!pris.ok) {
      stdout.write(`  ${mark('FAILED')} ${pris.error.message}\n`);
      continue;
    }

    /* ⚠ ON REND L'INTENTION À SON PROPRIÉTAIRE — ADR-105.

       La file ne sait pas exécuter, et c'est ce qui la rend sûre. Elle sait
       désormais à QUI rendre ce qu'elle garde :

           OUTIL       → gateway.invoke      (le propriétaire est l'outil)
           ANNULATION  → undo.undoOperation  (le propriétaire est l'Undo Engine)

       Ce n'est pas un second chemin de rejeu : `undoOperation` appelle
       `gateway.invoke` en interne, donc le Policy Gate est traversé
       exactement une fois dans les deux cas. Ce qui change est la
       COMPTABILITÉ — `undoLast` marque aussi la capture annulée, et la file
       ne saurait pas le faire. Sans ce geste, la capture resterait annulable
       et l'utilisateur se la verrait reproposer. */
    if (pris.value.genre === 'ANNULATION') {
      const defait = await runtime.undo.undoOperation(pris.value.operationId, {
        mode: 'NORMAL',
        cloudEnabled: runtime.cloudEnabled,
        proactive: false,
        // L'humain vient de dire oui, ici, devant la machine, sur CETTE cible.
        userConfirmed: true,
        surface: 'LOCALE',
      });
      stdout.write(
        defait.ok
          ? `  ${mark(defait.value.status)} Annulé — ${defait.value.resource.kind} `
            + `${defait.value.resource.id}\n`
          : `  ${mark('FAILED')} ${defait.error.message}\n`,
      );
      continue;
    }

    const fait = await runtime.gateway.invoke({
      toolId: pris.value.toolId,
      input: pris.value.input,
      /* Aucun `as` : la file rend déjà des `Provenance` validées par Zod à la
         sortie de la base (ADR-016). Un `as` ici aurait rendu fiable, sans le
         vérifier, ce sur quoi le Policy Gate durcit. */
      parameterProvenance: pris.value.provenance,
      // MÊME clé d'opération que la demande d'origine — ADR-030.
      operationId: fromClient(pris.value.operationId),
      actor: 'USER',
      context: {
        mode: 'NORMAL',
        cloudEnabled: runtime.cloudEnabled,
        proactive: false,
        /* L'humain vient de dire oui, ici, devant la machine, sur CETTE cible.
           C'est la seule chose que la file ne pouvait pas fournir. */
        userConfirmed: true,
        surface: 'LOCALE',
      },
    });

    if (!fait.ok) {
      stdout.write(`  ${mark('FAILED')} ${fait.error.message}\n`);
      continue;
    }
    stdout.write(`  ${mark(fait.value.status)} ${fait.value.verification.detail}\n`);
  }
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
  /* ADR-086 : la ligne qui manquait, et la seule que l'utilisateur regarde
     juste après avoir installé un modèle. */
  stdout.write(`  Modèle local   ${d.modeleLocal}\n`);
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

    case 'EN_ATTENTE':
      /* ADR-099. Rien n'a été exécuté, et la phrase le dit d'abord — avant de
         dire ce qui est possible ensuite. L'ordre compte : « c'est en file »
         lu vite ressemble à « c'est fait ». */
      stdout.write(
        `  Rien n'a été fait. Préparé et mis en attente : ${reply.resume}\n`,
      );
      stdout.write(
        `  Tape « /confirmer » sur cette machine — il te reste `
          + `${String(reply.minutesRestantes)} min.\n`,
      );
      return;

    case 'ANNULE':
      /* ⚠ ON NOMME CE QUI A ÉTÉ DÉFAIT, et le statut vient du Verification
         Engine. « C'est annulé » sans vérification serait le succès non
         vérifié que `CLAUDE.md` interdit — et sur une annulation, croire à
         tort que l'état est revenu en arrière est pire qu'ailleurs. */
      stdout.write(`  ${mark(reply.status)} Annulé — ${reply.cible}\n`);
      stdout.write(`  ${reply.detail}\n`);
      return;

    case 'ARRET':
      /* ⚠ ADR-104 — ET L'ORDRE DES TROIS LIGNES EST LA PARTIE UTILE.

         1. ce qui est VRAI maintenant : Jarvis est arrêté
         2. ce que l'arrêt N'A PAS pu défaire — `docs/26 §5`
         3. comment en sortir

         Le deuxième point est celui qu'on serait tenté de taire. Une opération
         déjà partie a peut-être produit son effet, et laisser croire que
         « stop » a tout effacé serait le seul mensonge que cette réponse
         puisse commettre. */
      /* ⚠ « PLUS AUCUNE ACTION NE PASSERA » — J'AVAIS ÉCRIT ÇA, ET C'ÉTAIT FAUX.

         Trouvé en UTILISANT Jarvis, pas en le relisant : après « arrête tout »,
         « mes tâches » a répondu normalement. Le mécanisme n'a pas de défaut —
         ADR-057 laisse délibérément passer les LECTURES LOCALES
         (`L1 && !networkRequired`), parce qu'après avoir appuyé sur le bouton
         on a PLUS besoin de comprendre, pas moins.

         C'est donc la phrase qui mentait, et dans le sens le plus coûteux :
         elle promettait une protection plus large que la vraie. Un utilisateur
         qui croit que TOUT est bloqué ne s'étonnera pas de voir une lecture
         aboutir — il en conclura que l'arrêt n'a pas marché, ou pire, il
         supposera bloqué ce qui ne l'est pas. */
      stdout.write('  ⏹ ARRÊTÉ. Aucune action NOUVELLE ne passera.\n');
      stdout.write(
        `  ${String(reply.annulees)} action(s) en attente annulée(s).\n`,
      );
      stdout.write(
        '  Les lectures locales restent possibles — journal, tâches, état : '
          + 'après un arrêt, on a besoin de voir.\n',
      );
      if (reply.enVol > 0) {
        stdout.write(
          `  ⚠ ${String(reply.enVol)} action(s) étaient DÉJÀ parties : `
            + `leur effet existe peut-être, et l'arrêt ne les rattrape pas.\n`,
        );
      }
      if (reply.journalMuet) {
        stdout.write(
          '  ⚠ L’arrêt tient, mais le journal n’a pas pris l’événement.\n',
        );
      }
      stdout.write('  Pour reprendre : « /reprendre <raison> », sur cette machine.\n');
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
      /* ⚠ LA LISTE DES LECTURES ÉTAIT ÉCRITE ICI, et elle n'en connaissait
         que DEUX sur neuf. « qu'as-tu fait », « fais-moi un point »,
         « comment vas-tu » s'annonçaient donc « C'est fait » — alors que rien
         n'avait été fait. Elle vit désormais dans `render-sortie.ts`, avec un
         test qui éprouve les deux sens. */
      stdout.write(
        `  ${mark(reply.status)} `
          + `${enteteDeReponse(reply.toolId, reply.status, (s) => announce({ status: s, detail: reply.detail }))}\n`,
      );
      for (const ligne of lignesDeSortie(reply.toolId, reply.output)) {
        stdout.write(`  ${ligne}\n`);
      }
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
  /* LA SESSION EST TRANSMISE — ADR-073. Sans elle, un référent (« ajoute ça à
     ma liste ») produit une QUESTION plutôt qu'une supposition : `docs/05 §A2`
     interdit de deviner quand deux lectures diffèrent. */
  /* LOCALE — ADR-090. L'utilisateur est au clavier de la machine : sa
     confirmation vaut ce qu'une confirmation doit valoir. */
  let reply = await runtime.assistant.say(line, {
    operationId,
    sessionId,
    surface: 'LOCALE',
  });

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
      sessionId,
      surface: 'LOCALE',
    });
  }

  show(reply);

  if (reply.kind === 'DONE') {
    /* LE TOUR PORTE CE QUI A ÉTÉ ÉVOQUÉ — ADR-072, `docs/05 §A2`.
       Sans cette ligne, `resolveAnaphora` ne trouve jamais rien : le
       mécanisme de résolution existait, la boucle ne lui donnait aucune
       matière. C'est la moitié du blocage d'A2 qui restait après ADR-071. */
    await runtime.sessions.appendTurn(sessionId, {
      speaker: 'JARVIS',
      content: `${reply.toolId} → ${reply.status}`,
      mentionedEntityIds: reply.mentionedEntityIds,
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

      /* LA PORTE UNIQUE PAR LAQUELLE UN ÉNONCÉ DEVIENT UNE ACTION — ADR-074.
         Une ligne tapée est toujours FINALE : l'utilisateur a appuyé sur
         Entrée, le texte ne changera plus. Une transcription vocale, elle, ne
         l'est pas toujours — et c'est exactement pourquoi cette porte existe
         AVANT l'audio plutôt qu'après : le jour où un moteur de reconnaissance
         alimente cette boucle, il passe par le même verdict, sans qu'on ait à
         se souvenir de l'écrire.

         Elle remplace un `trim()` suivi d'un `if vide → continue`. Le
         comportement est le même ; la décision est NOMMÉE et porte son motif. */
      const verdict = ecouter({ text: raw, final: true });
      if (verdict.kind === 'ATTENDRE') continue;
      const line = verdict.texte;

      if (line === '/quitter' || line === '/quit') break;
      if (line === '/aide' || line === '/help') {
        stdout.write(HELP);
        continue;
      }
      if (line === '/audit') {
        await showAudit(runtime.value);
        continue;
      }
      if (line === '/annule') {
        /* ⚠ LA COMMANDE N'EST QU'UN RACCOURCI — ADR-105.

           Elle portait sa PROPRE reconnaissance (`/^annule la derni[eè]re
           action/iu`) et sa propre chaîne aperçu → question → exécution. Le
           résultat mesuré sur le banc des trente actions : la phrase marchait
           dans le CLI et rendait « capacité absente » par `assistant.say()`,
           donc depuis le téléphone.

           Elle traverse désormais la MÊME boucle que tout le reste. Une
           surface ne décide de rien ; elle affiche ce que l'Assistant a
           décidé. */
        await handleText(
          runtime.value,
          session.value.id,
          'annule la dernière action',
          async (q: string) => (await nextLine(`\n  ${q}\n  > `)) ?? '',
        );
        continue;
      }
      if (line === '/confirmer' || line === '/attente') {
        await confirmerEnAttente(runtime.value, async (q: string) => {
          const answer = await nextLine(`\n  ${q}\n  > `);
          // Fin d'entrée pendant une confirmation : ce n'est pas un oui.
          return answer ?? '';
        });
        continue;
      }
      if (line === '/reprendre' || line.startsWith('/reprendre ')) {
        /* ⚠ LEVER UN ARRÊT EST UNE COMMANDE, PAS UNE PHRASE — ADR-104.

           `halt.ts` pose la dissymétrie : engager va dans le sens sûr, lever
           va dans le sens dangereux. Reconnaître « reprends » comme on
           reconnaît « stop » les rendrait aussi faciles l'une que l'autre, et
           une injection indirecte pourrait enchaîner les deux.

           Trois gardes, et aucune n'est décorative :
             — commande explicite, jamais une phrase ;
             — RAISON obligatoire, tapée à la main ;
             — surface LOCALE par construction — ce chemin n'existe que dans
               le CLI, et la passerelle web ne l'expose pas (ADR-090/101). */
        const raison = line.slice('/reprendre'.length).trim();
        if (raison.length === 0) {
          stdout.write(
            '  Il faut une raison : « /reprendre j’ai vérifié, c’était une fausse alerte ».\n',
          );
          continue;
        }
        const leve = await runtime.value.arret.lever(raison);
        stdout.write(
          leve.ok
            ? '  ▶ Arrêt levé. Jarvis peut de nouveau agir.\n'
            : `  ${leve.error.message}\n`,
        );
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
