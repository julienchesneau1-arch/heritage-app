/**
 * Interface web mobile.
 *
 * Aucune ressource externe : ni police, ni script, ni feuille de style
 * distante. La page fonctionne hors ligne et ne peut rien exfiltrer, ce qui
 * permet une politique de sécurité de contenu stricte (`default-src 'self'`).
 *
 * Le jeton arrive une fois par le fragment d'URL (`#t=…`), est rangé dans
 * `localStorage`, puis retiré de la barre d'adresse. Un fragment n'est jamais
 * transmis au serveur ni écrit dans ses journaux — contrairement à un paramètre
 * de requête.
 */

import { VerificationStatus } from '../../core/types/domain.js';
import { headline, mark } from '../cli/report.js';

/**
 * LES TABLES DU CLIENT, DÉRIVÉES — jamais recopiées (ADR-062).
 *
 * Elles étaient écrites à la main dans le script servi au navigateur, et elles
 * avaient divergé : le web connaissait **quatre** statuts sur sept. `PARTIAL`,
 * `NOT_ATTEMPTED` et `PROVIDER_CONTRACT_VIOLATION` tombaient sur un repli —
 * identifiant brut affiché à l'utilisateur, et marqueur `·`, qui est dans le
 * CLI celui de `NOT_ATTEMPTED`.
 *
 * Le signal le plus fort du système portait donc le symbole du plus bénin.
 *
 * On les construit ici depuis `report.ts`, à partir de l'ÉNUMÉRATION : un
 * statut ajouté demain apparaît des deux côtés sans que personne y pense.
 */
function tablesDeStatut(): string {
  const statuts = VerificationStatus.options;
  const say = Object.fromEntries(statuts.map((s) => [s, headline(s)]));
  const marque = Object.fromEntries(statuts.map((s) => [s, mark(s)]));
  /* `JSON.stringify` échappe ce qu'il faut pour un littéral JavaScript, y
     compris les apostrophes des phrases françaises et les retours à la ligne
     de `PROVIDER_CONTRACT_VIOLATION`. */
  return (
    `  const MARK = ${JSON.stringify(marque)};\n` +
    `  const SAY = ${JSON.stringify(say)};`
  );
}

export const HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Jarvis">
<title>Jarvis</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1>Jarvis</h1>
  <button id="menu" type="button" aria-label="Menu">···</button>
</header>

<main id="log" aria-live="polite"></main>

<form id="composer" autocomplete="off">
  <input id="input" type="text" placeholder="Note que…" enterkeyhint="send"
         autocapitalize="sentences" autocorrect="on">
  <button type="submit" aria-label="Envoyer">↑</button>
</form>

<dialog id="sheet">
  <button data-cmd="/audit" type="button">Qu'as-tu fait aujourd'hui&nbsp;?</button>
  <button data-cmd="/inbox" type="button">Mémoires en attente</button>
  <button data-cmd="/diagnostic" type="button">Diagnostic</button>
  <button data-cmd="/aide" type="button">Ce que je sais faire</button>
  <button id="forget" type="button" class="danger">Oublier ce jeton</button>
</dialog>

<script src="/app.js"></script>
</body>
</html>
`;

export const CSS = `:root {
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68;
  --line: #e4e4e1; --accent: #2f6f4f; --danger: #a33;
  --bubble-user: #eceae5; --bubble-jarvis: #fff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --fg: #e8e8e6; --muted: #97978f;
    --line: #2c2c2a; --accent: #7bbd97; --danger: #e08585;
    --bubble-user: #232320; --bubble-jarvis: #1e1e1c;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--fg);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  display: flex; flex-direction: column;
  padding-top: env(safe-area-inset-top);
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: .6rem 1rem; border-bottom: 1px solid var(--line);
  position: sticky; top: 0; background: var(--bg); z-index: 2;
}
h1 { font-size: 1rem; font-weight: 600; margin: 0; letter-spacing: .02em; }
#menu {
  background: none; border: none; color: var(--muted);
  font-size: 1.3rem; line-height: 1; cursor: pointer; padding: .2rem .5rem;
}
main {
  flex: 1; overflow-y: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: .75rem;
}
.turn { max-width: 90%; padding: .6rem .8rem; border-radius: .8rem; }
.turn.user { align-self: flex-end; background: var(--bubble-user); }
.turn.jarvis { align-self: flex-start; background: var(--bubble-jarvis); border: 1px solid var(--line); }
.turn .mark { font-weight: 600; margin-right: .35rem; }
.turn .detail, .turn .note { color: var(--muted); font-size: .85rem; margin-top: .35rem; }
.turn ul { margin: .4rem 0 0; padding-left: 1.1rem; }
.turn li { margin: .15rem 0; }
.kind { color: var(--muted); font-size: .78rem; }
.confirm { border-color: var(--accent); }
.confirm .values {
  margin: .5rem 0; padding: .5rem .7rem; border-radius: .5rem;
  background: var(--bg); border: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem;
  word-break: break-all;
}
.actions { display: flex; gap: .5rem; margin-top: .5rem; }
.actions button {
  flex: 1; padding: .55rem; border-radius: .5rem; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font-size: .9rem; cursor: pointer;
}
.actions button.yes { border-color: var(--accent); color: var(--accent); font-weight: 600; }
form {
  display: flex; gap: .5rem; padding: .75rem 1rem;
  padding-bottom: calc(.75rem + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line); background: var(--bg);
}
input {
  flex: 1; padding: .7rem .9rem; font-size: 16px;
  border: 1px solid var(--line); border-radius: 1.4rem;
  background: var(--bubble-jarvis); color: var(--fg);
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
form button {
  width: 2.7rem; border: none; border-radius: 50%;
  background: var(--accent); color: var(--bg); font-size: 1.1rem; cursor: pointer;
}
dialog {
  border: 1px solid var(--line); border-radius: .8rem; padding: .5rem;
  background: var(--bubble-jarvis); color: var(--fg); min-width: 15rem;
}
dialog::backdrop { background: rgba(0,0,0,.4); }
dialog button {
  display: block; width: 100%; text-align: left; padding: .7rem .8rem;
  background: none; border: none; color: var(--fg); font-size: .95rem; cursor: pointer;
  border-radius: .4rem;
}
dialog button:hover { background: var(--bubble-user); }
dialog button.danger { color: var(--danger); border-top: 1px solid var(--line); margin-top: .3rem; }
`;

export const JS = `(() => {
  'use strict';
  const log = document.getElementById('log');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sheet = document.getElementById('sheet');

  /* Le jeton arrive une seule fois par le fragment, jamais par la requête. */
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('t')) {
    localStorage.setItem('jarvis_token', hash.get('t'));
    history.replaceState(null, '', location.pathname);
  }
  const token = () => localStorage.getItem('jarvis_token') || '';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function push(node) {
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }
  function jarvis() { return push(el('div', 'turn jarvis')); }

${tablesDeStatut()}

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'authorization': 'Bearer ' + token(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new Error('Jeton refusé. Rouvre le lien fourni au démarrage.');
    if (res.status === 429) throw new Error('Trop de tentatives. Réessaie dans une minute.');
    if (!res.ok) throw new Error('Erreur ' + res.status);
    return res.json();
  }

  function renderOutput(node, toolId, output) {
    if (!output || typeof output !== 'object') return;
    if (Array.isArray(output.tasks)) {
      if (!output.tasks.length) { node.appendChild(el('div', 'note', 'Aucune tâche ouverte.')); return; }
      const ul = el('ul');
      output.tasks.forEach(t => ul.appendChild(el('li', null, t.title)));
      node.appendChild(ul);
    }
    if (Array.isArray(output.results)) {
      /* La PORTÉE est affichée à chaque recherche : l'utilisateur doit savoir
         ce qui n'a PAS été consulté, pas seulement ce qui l'a été. */
      if (output.scopeLabel) node.appendChild(el('div', 'note', output.scopeLabel));
      if (output.degraded) {
        node.appendChild(el('div', 'note', "recherche sans la voie sémantique — aucun modèle d'embeddings"));
      }
      if (!output.results.length) {
        node.appendChild(el('div', 'note', 'Rien trouvé dans ta mémoire personnelle.'));
        return;
      }
      const ul = el('ul');
      output.results.forEach(r => {
        const li = el('li', null, r.content + ' ');
        li.appendChild(el('span', 'kind', '[' + r.kind + ']'));
        ul.appendChild(li);
      });
      node.appendChild(ul);
    }
    if (output.outcome === 'QUEUED') {
      node.appendChild(el('div', 'note', "Déposé dans l'inbox : je demanderai confirmation avant de le retenir."));
    }
    if (output.outcome === 'DEDUPLICATED') {
      node.appendChild(el('div', 'note', 'Je le savais déjà.'));
    }
    if (Array.isArray(output.adjustments)) {
      output.adjustments.forEach(a => node.appendChild(el('div', 'note', a)));
    }
  }

  function renderReply(reply, originalText) {
    const node = jarvis();

    if (reply.kind === 'DONE') {
      /* Une lecture ne s'annonce pas « C'est fait » : rien n'a été fait. */
      const readOnly = reply.toolId === 'memory_search' || reply.toolId === 'task_list';
      const head = el('div');
      /* Les tables couvrent l'ENUMERATION entière (ADR-062) : le repli ne
         devrait jamais servir. Il reste comme filet, pas comme mécanisme. */
      head.appendChild(el('span', 'mark', MARK[reply.status] || '·'));
      head.appendChild(document.createTextNode(
        readOnly && reply.status === 'CONFIRMED'
          ? "Voici ce que j'ai trouvé."
          : (SAY[reply.status] || reply.status)));
      node.appendChild(head);
      if (reply.status !== 'CONFIRMED') node.appendChild(el('div', 'detail', reply.detail));
      renderOutput(node, reply.toolId, reply.output);
      return;
    }

    if (reply.kind === 'CONFIRM') {
      node.classList.add('confirm');
      node.appendChild(el('div', null, reply.reason));
      const values = el('div', 'values');
      Object.entries(reply.values).forEach(([k, v]) => {
        values.appendChild(el('div', null, k + ' : ' + v));
      });
      if (Object.keys(reply.values).length) node.appendChild(values);

      const actions = el('div', 'actions');
      const yes = el('button', 'yes', 'Confirmer');
      const no = el('button', null, 'Annuler');
      actions.appendChild(yes); actions.appendChild(no);
      node.appendChild(actions);

      no.onclick = () => { actions.remove(); node.appendChild(el('div', 'note', "Annulé. Rien n'a été fait.")); };
      yes.onclick = async () => {
        actions.remove();
        try {
          const confirmed = await api('/api/say', {
            text: originalText, operationId: reply.operationId, confirm: true,
          });
          renderReply(confirmed, originalText);
        } catch (e) { jarvis().appendChild(el('div', 'detail', e.message)); }
      };
      return;
    }

    if (reply.kind === 'CLARIFY') { node.appendChild(el('div', null, reply.question)); return; }
    if (reply.kind === 'UNSUPPORTED') {
      node.appendChild(el('div', null, 'Je comprends ' + reply.understood + '.'));
      node.appendChild(el('div', 'detail', 'Il me manque ' + reply.missing));
      return;
    }
    if (reply.kind === 'DENIED') { node.appendChild(el('div', null, 'Refusé : ' + reply.reason)); return; }
    node.appendChild(el('div', null, reply.message || 'Erreur.'));
  }

  function renderReport(title, lines, footer) {
    const node = jarvis();
    node.appendChild(el('div', null, title));
    const ul = el('ul');
    lines.forEach(l => ul.appendChild(el('li', null, l)));
    if (lines.length) node.appendChild(ul);
    else node.appendChild(el('div', 'note', 'Rien.'));
    if (footer) node.appendChild(el('div', 'note', footer));
  }

  async function command(cmd) {
    try {
      if (cmd === '/audit') {
        const r = await api('/api/audit');
        renderReport("Depuis le journal d'exécution :",
          r.events.map(e => e.count + ' × ' + e.type + ' [' + e.status + ']'),
          r.chainValid ? "Chaîne d'audit intacte (" + r.chainLength + " événements)."
                       : "⚠ CHAÎNE D'AUDIT ROMPUE");
      } else if (cmd === '/inbox') {
        const r = await api('/api/inbox');
        // La troncature se dit ici AUSSI (ADR-064) : deux surfaces, une seule
        // vérité. Une liste écourtée en silence se lit comme une liste entière.
        const lignes = r.candidates.map(c => c.content + '  (' + c.memoryType + ', ' + c.sourceType + ')');
        const reste = r.total - r.candidates.length;
        if (reste > 0) lignes.push('… et ' + reste + ' autre(s) (' + r.total + ' en attente au total).');
        renderReport('En attente de ta confirmation :', lignes);
      } else if (cmd === '/diagnostic') {
        const r = await api('/api/diagnostic');
        renderReport('Diagnostic :', [
          'Base ' + (r.database === 'UP' ? 'joignable' : 'INJOIGNABLE'),
          r.tools + ' outils enregistrés',
          'Journal ' + (r.chainValid ? 'intact (' + r.chainLength + ' événements)' : 'ROMPU'),
          r.pending + ' mémoire(s) en attente',
          'Embeddings ' + (r.embeddings ? 'disponibles' : 'absents — voie sémantique indisponible'),
          'Cloud ' + (r.cloud ? 'activé' : 'désactivé'),
        ]);
      } else if (cmd === '/aide') {
        renderReport('Ce que je sais faire :', [
          'note <texte>', 'ajoute <chose> à ma liste', 'rappelle-moi de <chose>',
          'mes tâches', 'retiens que <fait>', 'que sais-tu sur <sujet>',
        ]);
      }
    } catch (e) { jarvis().appendChild(el('div', 'detail', e.message)); }
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    push(el('div', 'turn user', text));

    if (text.startsWith('/')) { await command(text); return; }
    if (/^qu'?as-tu fait/i.test(text)) { await command('/audit'); return; }

    try { renderReply(await api('/api/say', { text }), text); }
    catch (e) { jarvis().appendChild(el('div', 'detail', e.message)); }
  };

  document.getElementById('menu').onclick = () => sheet.showModal();
  sheet.onclick = (event) => { if (event.target === sheet) sheet.close(); };
  sheet.querySelectorAll('[data-cmd]').forEach(b => {
    b.onclick = () => { sheet.close(); push(el('div', 'turn user', b.dataset.cmd)); command(b.dataset.cmd); };
  });
  document.getElementById('forget').onclick = () => {
    localStorage.removeItem('jarvis_token');
    sheet.close();
    jarvis().appendChild(el('div', null, 'Jeton oublié sur cet appareil.'));
  };

  if (!token()) {
    jarvis().appendChild(el('div', null, "Aucun jeton. Ouvre le lien complet affiché au démarrage du serveur."));
  }
})();
`;
