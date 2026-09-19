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
import { capacitesParlees } from '../../core/intent/engine.js';
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

/**
 * ⚠ LE HUITIÈME REGISTRE DE LA LISTE DES CAPACITÉS — ADR-098.
 *
 * ADR-075 en avait recensé six et les avait tous dérivés des règles. Tous
 * étaient en TypeScript côté noyau. ADR-094 a trouvé le septième dans
 * `QUICKSTART.md`. Celui-ci est le huitième, et il vivait **dans le script
 * servi au navigateur** :
 *
 * ```text
 * renderReport('Ce que je sais faire :', [ … six entrées écrites à la main … ])
 * ```
 *
 * Six lignes sur vingt-et-une, et l'une d'elles était FAUSSE : elle annonçait
 * un rappel là où la règle crée une TÂCHE — c'est la forme DATÉE
 * (« rappelle-moi jeudi de… ») qui fait un rappel. Le bouton s'appelle « Ce que
 * je sais faire ».
 *
 * ⚠ ET CE COMMENTAIRE NE RECOPIE PAS LA LISTE FAUTIVE, volontairement. La
 * première rédaction la citait mot pour mot — et le test d'ADR-075 a rougi sur
 * ma propre documentation. Il a eu raison : un test textuel ne distingue pas
 * un commentaire d'un message, et c'est précisément ce qui rend la garde
 * fiable. Décrire vaut mieux que citer.
 *
 * **C'est la surface que Julien consulte depuis son téléphone**, donc celle où
 * la divergence coûte le plus : sur un écran de six centimètres, cette liste
 * EST le mode d'emploi.
 *
 * Elle est désormais injectée depuis `capacitesParlees()`, comme les tables de
 * statut juste au-dessus. Même geste, même raison.
 */
function capacitesInjectees(): string {
  return `  const CAPACITES = ${JSON.stringify([...capacitesParlees()])};`;
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
  <!-- ⚠ L'« INDICATEUR VISIBLE » EXIGÉ PAR docs/02 — ADR-106.
       (Aucun accent grave dans ce commentaire : il vit dans un littéral
       gabarit TypeScript, et c'est la QUATRIÈME fois que ce fichier me le
       rappelle.)
       Dans l'EN-TÊTE, pas dans le menu : un indicateur qu'il faut aller
       chercher ne répond pas à la question « est-ce que quelque chose peut
       sortir d'ici ? » au moment où on se la pose. -->
  <span id="prive" hidden>⦿ privé</span>
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
  <button data-cmd="/attente" type="button">À confirmer sur le Mac</button>
  <!-- ⚠ UNE PHRASE, PAS UNE COMMANDE — ADR-105.
       Ce bouton n'appelle aucune route dédiée : il ÉCRIT « annule la dernière
       action » dans la boucle ordinaire. Le téléphone n'obtient donc aucun
       pouvoir que la parole ne donne pas déjà, et le Policy Gate décide comme
       pour n'importe quelle phrase — mise en file comprise. -->
  <button data-phrase="annule la dernière action" type="button">Annuler la dernière action</button>
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
#prive {
  font-size: .75rem; color: var(--accent); border: 1px solid var(--accent);
  border-radius: .7rem; padding: .1rem .45rem; margin-left: auto;
  margin-right: .5rem; letter-spacing: .02em;
}
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
/* ADR-100 — les lignes de résultat, calculées par le serveur.
   « pre-wrap » parce qu'une ligne de recherche web porte son URL sur une
   seconde ligne : l'écraser la rendrait illisible sur un écran de téléphone.

   ⚠ ET CE BLOC AUSSI VIT DANS UN LITTÉRAL GABARIT. J'ai écrit l'avertissement
   quarante lignes plus haut, puis j'ai remis un accent grave ICI trois minutes
   après. Un commentaire ne protège pas de ce qu'il décrit — seul le
   compilateur le fait, et encore faut-il le LIRE avant d'enchaîner. */
.turn .ligne { margin-top: .3rem; white-space: pre-wrap; overflow-wrap: anywhere; }
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
${capacitesInjectees()}

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

  /* ⚠ « renderOutput » A ÉTÉ RETIRÉ D'ICI — ADR-100.

     Il couvrait trois outils sur vingt-et-un, et il doublait celui du CLI.
     Deux copies d'un même fait qui auraient divergé à la première correction
     faite d'un seul côté. Les lignes arrivent désormais du serveur.

     ⚠ AUCUN ACCENT GRAVE DANS CE BLOC, et ce n'est pas du style : tout ce
     fichier vit dans un littéral gabarit. Un accent grave y ferme la chaîne,
     et le compilateur rend alors des erreurs de syntaxe à cinquante lignes de
     là. Ma première rédaction en contenait quatre. */


  function renderReply(reply, originalText) {
    const node = jarvis();

    if (reply.kind === 'DONE') {
      /* ⚠ « lecture » ET « lignes » VIENNENT DU SERVEUR — ADR-100.

         Ce bloc décidait lui-même quels outils sont des lectures, et il n'en
         connaissait que DEUX sur neuf. Il appelait ensuite un renderer local
         qui traitait trois outils sur vingt-et-un.

         Le serveur applique désormais le MÊME code que le CLI. Le navigateur
         affiche des chaînes ; il ne décide plus rien, donc il ne peut plus
         diverger. */
      const head = el('div');
      /* Les tables couvrent l'ENUMERATION entière (ADR-062) : le repli ne
         devrait jamais servir. Il reste comme filet, pas comme mécanisme. */
      head.appendChild(el('span', 'mark', MARK[reply.status] || '·'));
      head.appendChild(document.createTextNode(
        reply.lecture && reply.status === 'CONFIRMED'
          ? "Voici ce que j'ai trouvé."
          : (SAY[reply.status] || reply.status)));
      node.appendChild(head);
      if (reply.status !== 'CONFIRMED') node.appendChild(el('div', 'detail', reply.detail));
      (reply.lignes || []).forEach(function (l) { node.appendChild(el('div', 'ligne', l)); });
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
    /* ADR-099 — mis en file. « Rien n'a été fait » vient EN PREMIER : sur un
       écran de téléphone, « en attente » lu vite ressemble à « c'est fait ».
       La même discipline que l'accusé de réception vocal (ADR-074), qui porte
       sur la RÉCEPTION et jamais sur l'effet. */
    if (reply.kind === 'EN_ATTENTE') {
      node.appendChild(el('div', null, 'Rien n’a été fait — préparé : ' + reply.resume));
      node.appendChild(el('div', 'detail',
        'À confirmer sur ton Mac avec « /confirmer » — ' + reply.minutesRestantes + ' min restantes.'));
      return;
    }
    /* ⚠ ADR-104 — L'ARRÊT D'URGENCE EST ATTEIGNABLE DEPUIS LE TÉLÉPHONE, et
       c'est une exception ASSUMÉE à ADR-090.

       ADR-090 refuse les actions dangereuses venues d'un canal moins sûr.
       Arrêter va dans le sens inverse : quelqu'un qui n'est pas devant sa
       machine est exactement celui qui a le plus besoin de pouvoir dire stop.

       ⚠ MAIS LA LEVÉE, ELLE, N'EST PAS ICI. Il n'existe aucun bouton
       « reprendre » sur cette page et aucune route qui la serve : lever se
       fait devant la machine, comme confirmer (ADR-101). Voir n'est pas
       pouvoir ; arrêter n'est pas repartir. */
    /* ADR-105 — l'annulation a abouti. On NOMME ce qui a été défait : « c'est
       annulé » sans dire quoi laisse l'utilisateur vérifier lui-même, ce qui
       est exactement ce qu'une annulation devait lui éviter. */
    if (reply.kind === 'MODE_PRIVE') {
      badgePrive(true);
      node.appendChild(el('div', null, reply.dejaActif
        ? 'Le mode privé était déjà actif, depuis ' + reply.depuis + '.'
        : '⦿ MODE PRIVÉ ACTIF. Plus rien ne sort de la machine.'));
      /* ⚠ LA SORTIE N'EST PAS ICI, ET C'EST LA MÊME FRONTIÈRE QU'ADR-101.
         Activer va dans le sens sûr ; désactiver rend à Jarvis le droit de
         parler à l'extérieur. Le téléphone peut fermer, pas rouvrir. */
      node.appendChild(el('div', 'note',
        'Pour en sortir : « /normal <raison> » sur ton Mac.'));
      return;
    }
    if (reply.kind === 'ANNULE') {
      node.appendChild(el('div', null, 'Annulé — ' + reply.cible));
      node.appendChild(el('div', 'detail', reply.detail));
      return;
    }
    if (reply.kind === 'ARRET') {
      /* ⚠ « NOUVELLE » N'EST PAS UN MOT DE REMPLISSAGE. Mesuré en utilisant
         Jarvis : après un arrêt, « mes tâches » répond encore — ADR-057 laisse
         passer les lectures locales, délibérément. La première version de cette
         phrase disait « plus aucune action », ce qui promettait une protection
         plus large que la vraie. */
      node.appendChild(el('div', null, '⏹ ARRÊTÉ. Aucune action NOUVELLE ne passera.'));
      node.appendChild(el('div', 'detail',
        reply.annulees + ' action(s) en attente annulée(s).'));
      node.appendChild(el('div', 'detail',
        'Les lectures locales restent possibles — après un arrêt, on a besoin de voir.'));
      if (reply.enVol > 0) {
        node.appendChild(el('div', 'detail',
          '⚠ ' + reply.enVol + ' action(s) étaient déjà parties : leur effet existe peut-être.'));
      }
      node.appendChild(el('div', 'note',
        'Pour reprendre : « /reprendre <raison> » sur ton Mac.'));
      return;
    }
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
          'Mode privé ' + (r.modePrive
            ? (r.modePriveImpose ? 'ACTIF — imposé par la configuration' : 'ACTIF')
            : 'inactif'),
        ]);
      } else if (cmd === '/attente') {
        /* ADR-101 — LECTURE SEULE. Aucun bouton n'exécute d'ici : confirmer
           reste l'affaire de la surface locale (ADR-090). On MONTRE ce qui
           attend, pour que rien ne se perde entre le téléphone et le bureau. */
        const r = await api('/api/attente');
        if (!r.total) { renderReport('Rien n’attend ta confirmation.', []); }
        else {
          renderReport(
            r.total + ' à confirmer sur ton Mac (tape « /confirmer ») :',
            r.items.map(function (i) {
              return i.resume + ' — ' + i.minutesRestantes + ' min restantes';
            }));
        }
      } else if (cmd === '/aide') {
        renderReport('Ce que je sais faire :', CAPACITES);
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

  function badgePrive(actif) {
    const b = document.getElementById('prive');
    if (b) b.hidden = !actif;
  }

  /* L'ÉTAT EST LU AU CHARGEMENT, pas seulement après une bascule : le mode
     privé survit aux redémarrages et aux surfaces (il vit en base, ADR-106).
     Un badge qui n'apparaîtrait qu'après l'avoir activé DANS CET ONGLET
     mentirait à chaque réouverture. */
  (async () => {
    try { badgePrive((await api('/api/diagnostic')).modePrive); }
    catch { /* pas de jeton, ou hors ligne : on n'affiche rien plutôt que faux */ }
  })();

  document.getElementById('menu').onclick = () => sheet.showModal();
  sheet.onclick = (event) => { if (event.target === sheet) sheet.close(); };
  sheet.querySelectorAll('[data-cmd]').forEach(b => {
    b.onclick = () => { sheet.close(); push(el('div', 'turn user', b.dataset.cmd)); command(b.dataset.cmd); };
  });
  /* Les boutons de PHRASE traversent la boucle ordinaire — ADR-105. Ils ne
     sont qu'un raccourci de frappe, et aucune capacité ne leur est réservée. */
  sheet.querySelectorAll('[data-phrase]').forEach(b => {
    b.onclick = async () => {
      sheet.close();
      const text = b.dataset.phrase;
      push(el('div', 'turn user', text));
      try { renderReply(await api('/api/say', { text }), text); }
      catch (e) { jarvis().appendChild(el('div', 'detail', e.message)); }
    };
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
