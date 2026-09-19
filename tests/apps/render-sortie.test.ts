/**
 * CHAQUE OUTIL MONTRE CE QU'IL A TROUVÉ — ADR-100.
 *
 * LE DÉFAUT, MESURÉ EN UTILISANT JARVIS PLUTÔT QU'EN LE RELISANT
 * ---------------------------------------------------------------------------
 * ```text
 * > fais-moi un point
 *   ✓ C'est fait.        ← et rien d'autre
 * ```
 *
 * Sept outils sur vingt-et-un étaient muets. Le briefing avait lu l'agenda, les
 * tâches, les rappels et les mémoires en attente ; il affichait une coche et
 * jetait tout.
 *
 * Ce n'est pas un mensonge — l'action a eu lieu, la vérification est réelle.
 * Mais l'utilisateur ne peut pas distinguer « le briefing est vide » de « le
 * briefing ne s'affiche pas ». Du siège de l'utilisateur, une capacité que rien
 * ne montre est une capacité absente (ADR-094).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  enteteDeReponse,
  estUneLecture,
  lignesDeSortie,
  outilsRendus,
} from '../../src/apps/render-sortie.js';

/** Les outils réellement enregistrés, lus depuis `src/tools/`. */
function outilsEnregistres(): readonly string[] {
  const ids: string[] = [];
  for (const f of readdirSync('src/tools')) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    for (const m of readFileSync(join('src/tools', f), 'utf8').matchAll(
      /^\s{6}id: '([a-z_]+)',$/gm,
    )) {
      const id = m[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

describe('aucun outil n’est muet', () => {
  const enregistres = outilsEnregistres();

  it('le compteur ne rend pas zéro — sinon il prouverait le vide', () => {
    /* ⚠ SANS CETTE ASSERTION, UN EXTRACTEUR CASSÉ RENDRAIT UNE LISTE VIDE et
       la boucle ci-dessous passerait en n'ayant rien vérifié. L'indentation de
       six espaces est une hypothèse sur la source ; si elle change, on veut le
       savoir bruyamment. */
    expect(enregistres.length).toBeGreaterThan(20);
  });

  it.each(outilsEnregistres())('%s a un rendu déclaré', (toolId) => {
    /* LA GARDE QUI REND L'EXHAUSTIVITÉ STRUCTURELLE.

       Un outil ajouté demain sans rendu fait rougir la CI. Sans ça, la
       prochaine capacité serait muette exactement comme les sept premières,
       et personne ne le verrait avant de s'en servir. */
    expect(outilsRendus()).toContain(toolId);
  });

  it('⚠ un outil INCONNU rend une ligne VISIBLE, pas le silence', () => {
    /* LE REPLI VA VERS LE BRUIT, ET C'EST DÉLIBÉRÉ.

       Rendre `[]` reproduirait exactement le défaut corrigé ici : un résultat
       jeté sans que personne ne le sache. On préfère une ligne laide qui se
       voit à un silence propre qui ne se voit pas. */
    const lignes = lignesDeSortie('outil_inexistant', { quelque: 'chose' });
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.join(' ')).toContain('aucun rendu défini');
  });
});

/* ====================================================================== *
 * LES SORTIES RÉELLES — formes relevées sur la base, pas inventées
 * ====================================================================== */

describe('les outils qui étaient muets montrent maintenant leur contenu', () => {
  it('le BRIEFING dit chaque section, et son état', () => {
    /* ⚠ UNE SECTION INDISPONIBLE NE S'AFFICHE PAS VIDE.

       C'est la règle de `calendar_read` — « l'agenda est inconnu, pas vide » —
       appliquée à l'affichage. Un agenda indisponible rendu comme une liste
       vide ferait croire à une journée libre. */
    const lignes = lignesDeSortie('briefing_generate', {
      agenda: { etat: 'INDISPONIBLE', motif: 'aucun fournisseur configuré', items: [] },
      taches: { etat: 'OK', items: [{ title: 'appeler le plombier' }] },
      rappels: { etat: 'OK', items: [] },
      enAttente: { etat: 'OK', items: [] },
      complet: false,
    });
    const tout = lignes.join('\n');
    expect(tout).toContain('indisponible');
    expect(tout).toContain('aucun fournisseur configuré');
    expect(tout).toContain('appeler le plombier');
    expect(tout).toContain('Rappels : rien.');
    expect(tout).toContain('incomplet');
  });

  it('la RECHERCHE WEB marque le contenu de tiers', () => {
    /* `CLAUDE.md` règle 2 : aucune donnée externe n'est une instruction. Un
       titre de page est écrit par un inconnu. L'afficher comme le reste
       effacerait la frontière entre « Jarvis dit » et « quelqu'un a écrit »,
       qui est la seule protection dont dispose le lecteur. */
    const lignes = lignesDeSortie('web_search', {
      count: 1,
      contenuDeTiers: true,
      results: [{ title: 'Prix du carrelage', url: 'https://exemple.fr/a' }],
    });
    expect(lignes.join('\n')).toContain('contenu de tiers');
    expect(lignes.join('\n')).toContain('Prix du carrelage');
  });

  it('la RECHERCHE DE FICHIERS dit ce qu’elle n’a PAS pu voir', () => {
    /* Une liste courte sans explication ressemble à « il n'y a rien ». */
    const lignes = lignesDeSortie('file_search', {
      count: 0,
      truncated: false,
      gaps: ['/Documents/prive : permission refusée'],
      hits: [],
    });
    expect(lignes.join('\n')).toContain('Non exploré');
    expect(lignes.join('\n')).toContain('permission refusée');
  });

  it('⚠ un RAPPEL dit que rien ne sonne — ADR-048', () => {
    /* LA PHRASE QUI EMPÊCHE LA PROMESSE DE MENTIR.

       Rien ne sonne dans ce dépôt. Un rappel est restitué par le briefing, pas
       par une notification. Le taire laisserait croire à une alarme qui
       n'existe pas — et l'utilisateur s'en apercevrait le jour où elle ne
       sonne pas, c'est-à-dire trop tard. */
    const lignes = lignesDeSortie('reminder_create', {
      reminderId: 'r1',
      text: 'appeler le plombier',
      remindAt: '2026-09-20T09:00:00Z',
    });
    const tout = lignes.join('\n');
    expect(tout).toContain('appeler le plombier');
    expect(tout).toContain('rien ne sonne');
  });

  it('⚠ un OUBLI nomme les copies qui survivent — ADR-065', () => {
    /* Annoncer « oublié » sans dire ce qui reste ailleurs serait une fausse
       promesse de confidentialité. */
    const lignes = lignesDeSortie('memory_forget', {
      existait: true,
      derivesRestants: ['backup:disque-externe'],
    });
    expect(lignes.join('\n')).toContain('ne sont PAS parties');
    expect(lignes.join('\n')).toContain('backup:disque-externe');
  });

  it('l’AGENDA vide le dit, et nomme sa source', () => {
    const lignes = lignesDeSortie('calendar_read', {
      source: 'google-calendar',
      count: 0,
      events: [],
    });
    expect(lignes.join('\n')).toContain('google-calendar');
    expect(lignes.join('\n')).toContain('Rien sur cette période');
  });

  it('l’ÉGRESSION vide le dit en toutes lettres', () => {
    expect(
      lignesDeSortie('egress_review', { rienNEstSorti: true, sorties: [] }).join('\n'),
    ).toContain('Rien n’est sorti');
  });
});

/* ====================================================================== *
 * UNE LECTURE NE S'ANNONCE PAS « C'EST FAIT »
 * ====================================================================== */

describe('l’en-tête distingue lire et agir', () => {
  const dire = (s: string): string => `verdict:${s}`;

  it.each([
    'task_list',
    'memory_search',
    'audit_query',
    'egress_review',
    'system_status',
    'briefing_generate',
    'calendar_read',
    'web_search',
    'file_search',
  ])('%s est une lecture — « voici ce que j’ai trouvé »', (toolId) => {
    expect(estUneLecture(toolId)).toBe(true);
    expect(enteteDeReponse(toolId, 'CONFIRMED', dire)).toContain('trouvé');
  });

  it.each(['note_create', 'task_create', 'memory_add', 'note_delete', 'calendar_create'])(
    '%s AGIT — et rend le verdict de vérification',
    (toolId) => {
      /* ⚠ LE CONTRÔLE QUI EMPÊCHE L'INVERSE. Si une ÉCRITURE tombait dans la
         liste des lectures, « voici ce que j'ai trouvé » remplacerait le
         verdict — et un `UNKNOWN` deviendrait invisible. C'est la pire
         confusion possible dans ce dépôt. */
      expect(estUneLecture(toolId)).toBe(false);
      expect(enteteDeReponse(toolId, 'CONFIRMED', dire)).toBe('verdict:CONFIRMED');
    },
  );

  it('⚠ une lecture NON confirmée rend quand même son verdict', () => {
    /* « Voici ce que j'ai trouvé » sur un `UNKNOWN` affirmerait avoir trouvé
       ce qu'on n'est pas sûr d'avoir lu. La formule ne s'applique qu'au cas
       CONFIRMED. */
    expect(enteteDeReponse('task_list', 'UNKNOWN', dire)).toBe('verdict:UNKNOWN');
  });
});
