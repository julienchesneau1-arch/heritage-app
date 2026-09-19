/**
 * CE QUE L'UTILISATEUR VOIT D'UN RÉSULTAT — un seul endroit. ADR-100.
 *
 * LE DÉFAUT, MESURÉ EN UTILISANT JARVIS
 * ---------------------------------------------------------------------------
 * ```text
 * > fais-moi un point
 *   ✓ C'est fait.
 *
 * > cherche sur le web le prix du carrelage
 *   ✓ C'est fait.
 * ```
 *
 * **Rien d'autre.** Le briefing avait lu l'agenda, les tâches, les rappels et
 * les mémoires en attente ; la recherche avait rapporté des résultats. Les deux
 * affichaient une coche et jetaient tout.
 *
 * La cause : un `renderOutput` qui traitait `task_list`, `memory_search` et
 * `memory_add`, et rendait la chaîne vide pour tout le reste. **Sept outils sur
 * vingt-et-un étaient muets.**
 *
 * ⚠ ET C'EST UNE FORME DU DÉFAUT QUE CE DÉPÔT TRAQUE
 * ---------------------------------------------------------------------------
 * « ✓ C'est fait » sans le résultat n'est pas un mensonge : l'action a bien eu
 * lieu, et la vérification est réelle. Mais l'utilisateur ne peut pas
 * distinguer « le briefing est vide » de « le briefing ne s'affiche pas ».
 *
 * C'est le cousin exact d'ADR-094 : une capacité qui existe et que rien ne
 * montre est, du siège de l'utilisateur, une capacité absente.
 *
 * ⚠ ET C'ÉTAIT LE NEUVIÈME REGISTRE
 * ---------------------------------------------------------------------------
 * Le CLI avait son renderer ; le script servi au téléphone avait le sien, en
 * JavaScript, couvrant les mêmes trois outils. Deux copies d'un même fait
 * — *comment montre-t-on la sortie d'un outil* — qui auraient divergé à la
 * première correction faite d'un seul côté.
 *
 * Ce module est le seul. Le CLI l'appelle ; la passerelle web l'appelle aussi
 * et envoie les LIGNES au téléphone, qui n'a plus qu'à les afficher. Le
 * navigateur ne décide plus rien.
 *
 * ⚠ EXHAUSTIF PAR CONSTRUCTION, PAS PAR VIGILANCE
 * ---------------------------------------------------------------------------
 * `tests/apps/render-sortie.test.ts` lit les identifiants d'outils dans
 * `src/tools/` et exige que **chacun** figure dans la table ci-dessous. Un
 * outil ajouté demain sans rendu fait rougir la CI.
 *
 * Un outil qui n'a rien à montrer le DÉCLARE (`RIEN`) plutôt que de tomber dans
 * un repli silencieux. La différence est tout le sujet : un silence déclaré est
 * une décision, un silence par défaut est un oubli.
 */
import type { VerificationStatus } from '../core/types/domain.js';

/** Rend une valeur inconnue en texte, sans jamais produire « [object Object] ». */
function txt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

function champ(o: unknown, cle: string): unknown {
  if (typeof o !== 'object' || o === null) return undefined;
  return (o as Record<string, unknown>)[cle];
}

function liste(o: unknown, cle: string): readonly unknown[] {
  const v = champ(o, cle);
  return Array.isArray(v) ? v : [];
}

/** Une date ISO rendue lisible. Jamais l'horloge du processus — juste du texte. */
function heure(iso: unknown): string {
  const s = txt(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(s);
  if (m === null) return s;
  return `${m[3] ?? ''}/${m[2] ?? ''} ${m[4] ?? ''}:${m[5] ?? ''}`;
}

/**
 * Le marqueur qui dit d'où vient un texte — ADR-096 et `CLAUDE.md` règle 2.
 *
 * Un titre de page web ou un nom de fichier est écrit par un tiers. L'afficher
 * comme le reste effacerait la frontière entre *Jarvis dit* et *quelqu'un a
 * écrit*, qui est la seule protection dont dispose le lecteur.
 */
const VENU_DAILLEURS = '⚠ contenu de tiers — Jarvis ne le reprend pas à son compte';

/** Les outils qui n'ont rien à montrer, et qui le disent. */
const RIEN: readonly string[] = [];

/**
 * Le libellé d'un élément de briefing, quel que soit son genre.
 *
 * Les quatre sections ne portent pas les mêmes champs : une tâche a `title`,
 * un rappel `text`, et un point en attente ni l'un ni l'autre — il a `tool` et
 * `state`. Chercher un champ unique produisait une puce vide.
 */
function descriptionDItem(it: unknown): string {
  for (const cle of ['title', 'text', 'content', 'displayName']) {
    const v = champ(it, cle);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const outil = txt(champ(it, 'tool'));
  const etat = txt(champ(it, 'state'));
  if (outil.length > 0) {
    return etat.length > 0 ? `${outil} — ${etat}` : outil;
  }
  /* Dernier recours : on dit qu'on ne sait pas nommer l'élément, plutôt que de
     rendre une puce vide qui ressemble à un trou dans les données. */
  return '(élément sans libellé)';
}

type Rendu = (output: unknown) => readonly string[];

/**
 * Un rendu par outil. La table est écrite en toutes lettres plutôt que déduite :
 * un outil oublié doit provoquer un ÉCHEC DE TEST, pas un repli silencieux.
 */
const RENDU: Readonly<Record<string, Rendu>> = {
  /* ---- Tâches ---------------------------------------------------------- */
  task_list: (o) => {
    const t = liste(o, 'tasks');
    if (t.length === 0) return ['Aucune tâche ouverte.'];
    return t.map((x) => {
      const quand = champ(x, 'dueAt');
      const echeance = quand === null || quand === undefined ? '' : ` — ${heure(quand)}`;
      return `• ${txt(champ(x, 'title'))}${echeance}`;
    });
  },
  task_create: (o) =>
    champ(o, 'alreadyExisted') === true
      ? ['Elle y était déjà.']
      : [`• ${txt(champ(o, 'title'))}`],
  task_complete: (o) => [`✓ ${txt(champ(o, 'title'))} — terminée.`],
  task_cancel: (o) => [`✗ ${txt(champ(o, 'title'))} — annulée.`],

  /* ---- Rappels --------------------------------------------------------- */
  reminder_create: (o) =>
    champ(o, 'alreadyExisted') === true
      ? ['Ce rappel existait déjà.']
      : [
          `• ${txt(champ(o, 'text'))} — ${heure(champ(o, 'remindAt'))}`,
          /* ⚠ LA PHRASE QUI EMPÊCHE LA PROMESSE DE MENTIR — ADR-048.
             Rien ne sonne dans ce dépôt. Un rappel est restitué par le
             briefing, pas par une notification. Le taire laisserait croire à
             une alarme qui n'existe pas. */
          'Il apparaîtra dans ton briefing du jour — rien ne sonne encore.',
        ],
  reminder_cancel: (o) => [`✗ ${txt(champ(o, 'text'))} — annulé.`],

  /* ---- Notes et mémoire ------------------------------------------------ */
  note_create: (o) =>
    champ(o, 'alreadyExisted') === true ? ['Cette note existait déjà.'] : RIEN,
  note_delete: () => ['Note supprimée définitivement.'],
  memory_add: (o) => {
    const issue = txt(champ(o, 'outcome'));
    if (issue === 'QUEUED') {
      return ['Déposé dans l’inbox : je te demanderai confirmation avant de le retenir.'];
    }
    if (issue === 'DEDUPLICATED') return ['Je le savais déjà.'];
    return liste(o, 'adjustments').map((a) => `(${txt(a)})`);
  },
  memory_search: (o) => {
    const lignes: string[] = [];
    /* LA PORTÉE EST DITE À CHAQUE FOIS, pas seulement quand rien n'est trouvé
       (HIGH-4) : l'utilisateur doit savoir ce qui n'a PAS été consulté. */
    const portee = txt(champ(o, 'scopeLabel'));
    if (portee.length > 0) lignes.push(`(${portee})`);
    if (champ(o, 'degraded') === true) {
      lignes.push('(recherche sans la voie sémantique — aucun modèle d’embeddings)');
    }
    const r = liste(o, 'results');
    if (r.length === 0) {
      lignes.push('Rien trouvé dans ta mémoire personnelle.');
      return lignes;
    }
    for (const m of r) lignes.push(`• ${txt(champ(m, 'content'))}  [${txt(champ(m, 'kind'))}]`);
    return lignes;
  },
  memory_forget: (o) => {
    const lignes = [
      champ(o, 'existait') === true
        ? 'Mémoire effacée définitivement.'
        : 'Il n’y avait rien à effacer.',
    ];
    /* LES DÉRIVÉS QUI SURVIVENT SONT NOMMÉS — ADR-065. Annoncer « oublié »
       sans dire ce qui reste ailleurs serait une fausse promesse de
       confidentialité. */
    const restants = liste(o, 'derivesRestants');
    if (restants.length > 0) {
      lignes.push(`⚠ Ces copies ne sont PAS parties : ${restants.map(txt).join(', ')}.`);
    }
    return lignes;
  },

  /* ---- Entités --------------------------------------------------------- */
  entity_create: (o) =>
    [`• ${txt(champ(o, 'displayName'))} [${txt(champ(o, 'kind'))}]`],
  entity_delete: () => ['Fiche supprimée définitivement, avec ses relations.'],

  /* ---- Agenda ---------------------------------------------------------- */
  calendar_read: (o) => {
    const e = liste(o, 'events');
    const source = txt(champ(o, 'source'));
    const entete = source.length > 0 ? [`(agenda : ${source})`] : [];
    if (e.length === 0) return [...entete, 'Rien sur cette période.'];
    return [
      ...entete,
      ...e.map(
        (x) => `• ${heure(champ(x, 'startsAt'))} — ${txt(champ(x, 'title'))}`,
      ),
    ];
  },
  calendar_create: (o) => [
    `• ${txt(champ(o, 'title'))} — ${heure(champ(o, 'startsAt'))} → ${heure(champ(o, 'endsAt'))}`,
  ],
  calendar_update: (o) => [
    `• ${txt(champ(o, 'title'))} — ${heure(champ(o, 'startsAt'))} → ${heure(champ(o, 'endsAt'))}`,
  ],

  /* ---- Recherches ------------------------------------------------------ */
  web_search: (o) => {
    const r = liste(o, 'results');
    if (r.length === 0) return ['Aucun résultat.'];
    return [
      VENU_DAILLEURS,
      ...r.map((x) => `• ${txt(champ(x, 'title'))}\n    ${txt(champ(x, 'url'))}`),
    ];
  },
  file_search: (o) => {
    const h = liste(o, 'hits');
    const lignes: string[] = [];
    if (h.length === 0) lignes.push('Aucun fichier trouvé.');
    else {
      lignes.push(VENU_DAILLEURS);
      for (const f of h) lignes.push(`• ${txt(champ(f, 'path') ?? champ(f, 'name'))}`);
    }
    /* CE QU'ON N'A PAS PU VOIR SE DIT — une liste courte sans explication
       ressemble à « il n'y a rien ». */
    const trous = liste(o, 'gaps');
    if (trous.length > 0) {
      lignes.push(`⚠ Non exploré : ${trous.map(txt).join(', ')}.`);
    }
    if (champ(o, 'truncated') === true) lignes.push('⚠ Liste tronquée.');
    return lignes;
  },

  /* ---- Lectures du système --------------------------------------------- */
  briefing_generate: (o) => {
    const lignes: string[] = [];
    /* CHAQUE SECTION DIT SON ÉTAT. Une section indisponible qui s'afficherait
       vide ferait croire que l'agenda est libre alors qu'il est INCONNU —
       exactement ce que `calendar_read` refuse de faire. */
    for (const [cle, titre] of [
      ['agenda', 'Agenda'],
      ['taches', 'Tâches'],
      ['rappels', 'Rappels'],
      ['enAttente', 'En attente'],
    ] as const) {
      const section = champ(o, cle);
      const etat = txt(champ(section, 'etat'));
      if (etat === 'INDISPONIBLE') {
        lignes.push(`${titre} : indisponible — ${txt(champ(section, 'motif'))}`);
        continue;
      }
      const items = liste(section, 'items');
      if (items.length === 0) {
        lignes.push(`${titre} : rien.`);
        continue;
      }
      lignes.push(`${titre} :`);
      for (const it of items.slice(0, 5)) {
        /* ⚠ CHAQUE SECTION A SES PROPRES CHAMPS, et la première rédaction ne
           le savait pas : elle cherchait `title | text | content` et affichait
           une PUCE VIDE pour « En attente », dont les éléments portent
           `tool` et `state`.

           Une puce vide est le même défaut en plus petit — un résultat montré
           comme s'il n'y avait rien à en dire. `descriptionDItem` s'arrête sur
           le premier champ présent, et rend le genre de l'élément à défaut. */
        lignes.push(`  • ${descriptionDItem(it)}`);
      }
      if (items.length > 5) lignes.push(`  … et ${String(items.length - 5)} de plus.`);
    }
    if (champ(o, 'complet') === false) {
      lignes.push('⚠ Briefing incomplet — une source n’a pas répondu.');
    }
    return lignes;
  },
  system_status: (o) => {
    const controles = champ(o, 'controles');
    if (typeof controles !== 'object' || controles === null) return RIEN;
    return Object.entries(controles as Record<string, unknown>).map(
      ([nom, c]) => `${txt(champ(c, 'verdict')) === 'OK' ? '✓' : '⚠'} ${nom} — ${txt(champ(c, 'detail'))}`,
    );
  },
  audit_query: (o) => {
    const e = liste(o, 'entries');
    if (e.length === 0) return ['Rien dans le journal sur cette période.'];
    const lignes = e.map(
      (x) =>
        `• ${heure(champ(x, 'occurredAt'))} ${txt(champ(x, 'eventType'))} [${txt(champ(x, 'status'))}]`,
    );
    if (champ(o, 'truncated') === true) lignes.push('⚠ Liste tronquée.');
    return lignes;
  },
  egress_review: (o) => {
    if (champ(o, 'rienNEstSorti') === true) return ['Rien n’est sorti de la machine.'];
    const s = liste(o, 'sorties');
    return s.map(
      (x) =>
        `• ${heure(champ(x, 'occurredAt'))} → ${txt(champ(x, 'destination'))} `
        + `[${txt(champ(x, 'dataLevel'))}] ${txt(champ(x, 'reason'))}`,
    );
  },
};

/**
 * Les lignes à montrer pour la sortie d'un outil.
 *
 * ⚠ UN OUTIL INCONNU REND UNE LIGNE VISIBLE, PAS LE SILENCE.
 *
 * Le repli naturel — rendre `[]` — reproduirait exactement le défaut que ce
 * module corrige : un résultat jeté sans que personne ne le sache. On préfère
 * une ligne laide qui se voit à un silence propre qui ne se voit pas.
 *
 * Le test d'exhaustivité rend ce cas impossible en CI ; ce repli couvre le jour
 * où il arriverait quand même.
 */
export function lignesDeSortie(
  toolId: string,
  output: unknown,
): readonly string[] {
  const rendu = RENDU[toolId];
  if (rendu === undefined) {
    return [`(aucun rendu défini pour « ${toolId} » — signale-le)`];
  }
  if (output === undefined || output === null) return RIEN;
  return rendu(output);
}

/** Les outils couverts. Lu par le test d'exhaustivité. */
export function outilsRendus(): readonly string[] {
  return Object.keys(RENDU);
}

/**
 * Une lecture ne s'annonce pas « C'est fait » : rien n'a été fait.
 *
 * Partagée par le CLI et la passerelle — c'était, elle aussi, écrite des deux
 * côtés, et le téléphone n'en connaissait que deux sur les huit.
 */
const LECTURES: ReadonlySet<string> = new Set([
  'task_list',
  'memory_search',
  'audit_query',
  'egress_review',
  'system_status',
  'briefing_generate',
  'calendar_read',
  'web_search',
  'file_search',
]);

export function estUneLecture(toolId: string): boolean {
  return LECTURES.has(toolId);
}

/** L'en-tête d'une réponse : « Voici ce que j'ai trouvé » ou le verdict. */
export function enteteDeReponse(
  toolId: string,
  status: VerificationStatus,
  dire: (s: VerificationStatus) => string,
): string {
  return estUneLecture(toolId) && status === 'CONFIRMED'
    ? 'Voici ce que j’ai trouvé.'
    : dire(status);
}
