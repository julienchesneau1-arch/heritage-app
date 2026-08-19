/**
 * LA SURFACE PARLÉE — combien d'outils un utilisateur peut-il DÉCLENCHER en
 * parlant ? ADR-075.
 *
 * `docs/28` compte les outils **écrits** : 22, tous éprouvés, tous conformes.
 * Ce fichier compte les outils **atteignables par une phrase**, et l'écart
 * entre les deux nombres est la distance réelle qui sépare Jarvis d'un
 * assistant vocal généraliste.
 *
 * POURQUOI CE COMPTAGE EST UNE PREUVE, ET PAS UN GREP DE PLUS
 * ---------------------------------------------------------------------------
 * `docs/26 §4.2 ter` a déjà établi ce qu'un balayage textuel ne dit PAS. Ici la
 * dissymétrie est assumée, et chaque moitié est prouvée par le moyen qui
 * convient :
 *
 *   INATTEIGNABLE  prouvé par ABSENCE dans la source du moteur. Le moteur ne
 *                  peut émettre qu'un `toolId` qu'il nomme en LITTÉRAL — il n'y
 *                  a ni concaténation ni table indirecte. Ne pas y figurer est
 *                  donc une impossibilité, pas une présomption.
 *
 *   ATTEIGNABLE    prouvé par une PHRASE qui le produit réellement. Figurer
 *                  dans la source ne suffit pas : une règle peut être masquée
 *                  par une autre placée avant elle.
 *
 * Un seul des deux moyens aurait menti. Le grep seul aurait compté une règle
 * morte comme une capacité ; les phrases seules n'auraient jamais pu prouver
 * qu'un outil est hors d'atteinte.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createIntentEngine } from '../../src/core/intent/engine.js';

const SOURCE = readFileSync('src/core/intent/engine.ts', 'utf8');

/**
 * Les outils enregistrés par `src/tools/index.ts`.
 *
 * Extrait de la source d'assemblage plutôt que codé en dur : un outil ajouté
 * sans règle d'intention doit faire bouger ce fichier, pas passer inaperçu.
 */
function outilsEnregistres(): readonly string[] {
  const index = readFileSync('src/tools/index.ts', 'utf8');
  const fichiers = [...index.matchAll(/from '\.\/([a-z]+)\.js'/g)].map((m) => m[1]);
  const ids = new Set<string>();
  for (const f of fichiers) {
    if (f === 'index') continue;
    const src = readFileSync(`src/tools/${f ?? ''}.ts`, 'utf8');
    /* Ancré sur le début de ligne — un `id:` cité dans un commentaire ou une
       chaîne ne compte pas. L'indentation, elle, n'est PAS fixée : la première
       version exigeait quatre espaces là où les fichiers en ont six, et rendait
       une liste VIDE. Un compteur qui rend zéro doit faire échouer bruyamment,
       jamais passer pour « rien à signaler » — d'où l'assertion de longueur. */
    for (const m of src.matchAll(/^\s+id: '([a-z_]+)',$/gm)) {
      if (m[1] !== undefined) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

/** Un `toolId` est-il seulement NOMMÉ par le moteur d'intention ? */
function nommeParLeMoteur(toolId: string): boolean {
  return SOURCE.includes(`toolId: '${toolId}'`);
}

/**
 * Les phrases qui prouvent l'atteignabilité — une par outil atteignable.
 *
 * Écrites en français ordinaire, telles qu'on les dirait à voix haute. Aucune
 * n'est une commande `/slash` : la question posée est *« que puis-je obtenir en
 * PARLANT »*, et une commande n'est pas de la parole.
 */
const PHRASES: Readonly<Record<string, string>> = {
  memory_add: 'retiens que je préfère le train à l’avion',
  memory_search: 'que sais-tu sur mes préférences de transport',
  note_create: 'note rappeler le devis au carreleur',
  task_create: 'ajoute du café à ma liste',
  task_list: 'mes tâches',
  entity_create: 'enregistre Camille Berthier comme personne',
  /* LES QUATRE D'ADR-075 — chacune ferme une capacité qui existait sans porte,
     et trois d'entre elles fermaient un MENSONGE actif du moteur. */
  web_search: 'cherche sur le web le prix moyen d’un carrelage',
  file_search: 'cherche dans mes documents le devis du carreleur',
  briefing_generate: 'fais-moi un point',
  system_status: 'comment vas-tu',
  /* ADR-077 — le verrou des DATES tombe, et c'est lui qui bloquait le cas
     d'usage réel de Julien : « je vais plus sur l'agenda que sur une liste ». */
  reminder_create: 'rappelle-moi jeudi d’appeler le médecin',
};

describe('la surface parlée de Jarvis', () => {
  const enregistres = outilsEnregistres();
  const moteur = createIntentEngine();

  it('CHAQUE outil déclaré atteignable l’est VRAIMENT — par une phrase', () => {
    /* La moitié qui ne peut pas se prouver par lecture. Une règle peut être
       présente dans la source et n'être jamais atteinte parce qu'une autre,
       placée avant, capture les mêmes phrases. C'est arrivé (ADR-073 : la règle
       de tâches capturait « ajoute ÇA à ma liste » et créait une tâche
       intitulée « ça »). */
    for (const [toolId, phrase] of Object.entries(PHRASES)) {
      const proposal = moteur.propose(phrase);
      expect(proposal.kind, `« ${phrase} » → ${proposal.kind}`).toBe('TOOL_CALL');
      if (proposal.kind !== 'TOOL_CALL') continue;
      expect(proposal.toolId, `« ${phrase} »`).toBe(toolId);
    }
  });

  it('LE CHIFFRE — 11 outils atteignables par la parole sur 22 écrits', () => {
    /* ⚠ C'EST LE CHIFFRE QUI RÉPOND À « SOMMES-NOUS PROCHES D'UN CHATGPT
       VOCAL ? », ET IL N'ÉTAIT COMPTÉ NULLE PART.

       `docs/28` mesure l'étendue en outils ÉCRITS. C'est la bonne mesure de
       l'ingénierie, et la mauvaise mesure de ce que l'utilisateur obtient. Les
       deux ne se confondent que si on lit vite — exactement la faute que
       `docs/26 §4.12` a corrigée sur le Context Engine, ici généralisée à tout
       le catalogue. */
    const atteignables = enregistres.filter((id) => nommeParLeMoteur(id));
    const horsAtteinte = enregistres.filter((id) => !nommeParLeMoteur(id));

    expect([...atteignables].sort()).toEqual(Object.keys(PHRASES).sort());

    /* Liste FIGÉE : elle doit bouger quand une règle d'intention est ajoutée,
       et faire rougir la CI si le mouvement n'était pas voulu. Chaque entrée
       est une capacité que Jarvis POSSÈDE et que l'utilisateur ne peut pas
       demander. */
    expect(horsAtteinte).toEqual([
      'audit_query', //     atteignable par `/audit` seulement
      'calendar_create', // exige des dates ISO qu'une règle ne peut pas produire
      'calendar_read', //   idem — et ADR-036/037 interdisent l'horloge du processus
      'calendar_update', // idem, plus un identifiant d'événement
      'egress_review', //   revue d'égression, hors surface conversationnelle
      'entity_delete', //   exige un identifiant qu'une phrase ne porte pas
      'memory_forget', //   idem — atteignable par `/annule`
      'note_delete', //     idem — atteignable par `/annule`
      'reminder_cancel', // idem — atteignable par `/annule`
      'task_cancel', //     exige un identifiant — atteignable par `/annule`
      'task_complete', //   exige un identifiant de tâche
    ]);

    /* CE QUE CETTE LISTE DIT MAINTENANT, ET QU'ELLE NE DISAIT PAS.
       Les douze restants ne sont plus « sans chemin utilisateur » : ils sont
       hors d'atteinte pour DEUX raisons nommées, et aucune ne se règle en
       écrivant une règle de plus.

         un IDENTIFIANT qu'une phrase ne porte pas   7 outils
         une DATE non encore câblée à l'outil        3 outils (agenda)

       La première demande une résolution par désignation (« cette note »).

       ⚠ LA SECONDE A CHANGÉ DE NATURE AVEC ADR-077. La résolution de dates
       EXISTE désormais, et elle a débloqué `reminder_create`. Les trois outils
       d'agenda restent hors d'atteinte pour une autre raison : aucun
       adaptateur n'est branché, et leurs règles restent à écrire. Ce n'est plus
       un verrou de conception, c'est du câblage. */
    expect(atteignables).toHaveLength(11);
    expect(enregistres).toHaveLength(22);
  });

  it('LE CAS LE PLUS TROMPEUR — « rappelle-moi » ne crée PAS un rappel', () => {
    /* ⚠ TROUVÉ EN COMPTANT, ET C'EST LE PLUS INSTRUCTIF DE LA LISTE.

       `reminder_create` existe, est éprouvé, et dit honnêtement que rien ne
       sonne dans ce dépôt (ADR-048). Mais la seule phrase française qui devrait
       l'atteindre — « rappelle-moi de… » — est capturée par la règle des
       TÂCHES, qui la précède.

       L'utilisateur obtient donc une tâche là où il demandait un rappel. Ce
       n'est pas un mensonge sur un effet — la tâche est réellement créée — mais
       c'est une action DIFFÉRENTE de celle demandée, et c'est précisément le
       motif qui avait justifié de restreindre `memory_search` (voir le
       commentaire de sa règle : « une action DIFFÉRENTE de celle demandée,
       annoncée comme un succès »).

       On le CONSTATE ici sans le corriger : le corriger demande de trancher ce
       que « rappelle-moi » doit vouloir dire quand rien ne sonne, et cette
       question appartient à Julien. Ce test tombera le jour où elle sera
       tranchée. */
    const proposal = moteur.propose('rappelle-moi d’appeler le plombier');
    expect(proposal.kind).toBe('TOOL_CALL');
    if (proposal.kind !== 'TOOL_CALL') return;
    expect(proposal.toolId).toBe('task_create');
    expect(proposal.toolId).not.toBe('reminder_create');
  });

  it('CONTRÔLE NÉGATIF — une phrase hors surface ne fabrique aucun appel', () => {
    /* Sans lui, un moteur qui rendrait `TOOL_CALL` sur n'importe quoi passerait
       le premier test. Et la propriété défendue est justement qu'il refuse :
       `docs/23` interdit d'inventer une intention. */
    for (const phrase of [
      'quel temps fera-t-il demain',
      'envoie un message à Paul',
      'raconte-moi une histoire',
    ]) {
      const proposal = moteur.propose(phrase);
      expect(proposal.kind, phrase).not.toBe('TOOL_CALL');
    }
  });
});
