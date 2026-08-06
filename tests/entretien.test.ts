import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  EntretienService,
  ENTRETIEN,
  QUESTIONS_DE_DEPART,
  avertissement,
  phrasesDeLEntretien,
} from '@/services/entretien.service';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

/**
 * LE MODE ENTRETIEN — un écran, une question, un bouton.
 *
 * Ces tests portent surtout sur ce que l'écran NE FAIT PAS. Chaque absence
 * est un choix : quelqu'un parle seul dans une pièce, souvent âgé, souvent
 * fatigué, à une machine qui pose des questions.
 */

function sansCommentaires(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const AVANT = sansCommentaires('src', 'app', 'entretien', 'page.tsx');
const PARLER = sansCommentaires('src', 'app', 'entretien', 'parler', 'page.tsx');
const SERVICE = sansCommentaires('src', 'services', 'entretien.service.ts');
const ACTIONS = sansCommentaires('src', 'app', 'actions.ts');

// ─── Ce qui doit être dit avant d'enregistrer ───

describe('On sait qui écoutera avant d’ouvrir la bouche', () => {
  it('nomme le relecteur dans une phrase, pas dans un libellé de champ', () => {
    expect(avertissement('Emma')).toBe('Ce que vous direz sera relu par Emma.');
  });

  it('affiche cet avertissement en tête de l’écran où l’on parle', () => {
    // AVANT le premier bouton, jamais après. La confidentialité d'un
    // entretien n'est pas une note de bas de page.
    const avantLeMagneto = PARLER.slice(0, PARLER.indexOf('<AudioRecorder'));
    expect(avantLeMagneto).toMatch(/avertissement\(relecteur\.name\)/);
  });

  it('refuse de commencer sans relecteur nommé', () => {
    // Ce n'est pas une validation de formulaire : c'est une promesse qu'on
    // ne peut pas faire à moitié.
    expect(PARLER).toMatch(/if \(!relecteur \|\| relecteur\.id === context\.member\.id\) redirect/);
  });

  it('ne propose jamais de se relire soi-même', async () => {
    const prisma = {
      member: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          expect(where.id).toEqual({ not: 'mem_1' });
          return [{ id: 'mem_2', name: 'Emma', generation: 3 }];
        },
      },
    } as unknown as PrismaClient;
    const membres = await new EntretienService(prisma).relecteursPossibles('fam_1', 'mem_1');
    expect(membres.map((m) => m.id)).not.toContain('mem_1');
  });

  it('ne garde rien si le relecteur est invalide', () => {
    expect(ACTIONS).toMatch(/if \(!relecteur \|\| relecteur\.id === context\.member\.id\) redirect\('\/entretien\?erreur=relecteur'\)/);
    // Et ce contrôle passe AVANT la lecture du fichier : rien n'est écrit.
    const action = ACTIONS.slice(ACTIONS.indexOf('deposerEntretien'));
    expect(action.indexOf('erreur=relecteur')).toBeLessThan(action.indexOf('storage.put'));
  });
});

// ─── Ce que l'écran ne fait pas ───

describe('Ce n’est pas une séance', () => {
  it('n’affiche ni compteur, ni progression, ni durée cible', () => {
    expect(PARLER).not.toMatch(/sur \d|\d+ sur|progress|étape \d|question \d|reste \d/i);
  });

  it('n’encourage pas, ne relance pas, ne félicite pas', () => {
    expect(PARLER).not.toMatch(/bravo|continuez|excellent|intéressant|merci d[’']avoir|encore un/i);
  });

  it('ne teste jamais la mémoire de qui parle', () => {
    // Un produit de mémoire qui évalue la mémoire de quelqu'un est une
    // insulte. Aucune question ne vérifie ce dont la personne se souvient.
    for (const question of QUESTIONS_DE_DEPART) {
      expect(question).not.toMatch(/vous rappelez-vous|vous souvenez-vous de la date|quel âge aviez/i);
    }
  });

  it('propose « Passer » sans jamais demander pourquoi', () => {
    expect(ENTRETIEN.passer).toBe('Passer');
    expect(PARLER).toMatch(/ENTRETIEN\.passer/);
    expect(PARLER).not.toMatch(/pourquoi|raison du passage|expliquez/i);
  });

  it('ne rend pas « Passer » plus discret que « Garder »', () => {
    // Passer doit coûter zéro. Un lien minuscule à côté d'un gros bouton
    // est un choix qui n'en est pas un.
    expect(PARLER).toMatch(/ENTRETIEN\.passer[\s\S]{0,80}/);
    const passer = PARLER.slice(PARLER.indexOf('ENTRETIEN.passer') - 200, PARLER.indexOf('ENTRETIEN.passer'));
    expect(passer).toMatch(/className="btn"/);
  });
});

// ─── Le brouillon appartient à la voix ───

describe('Ce qu’on vient de dire reste à celui qui l’a dit', () => {
  it('enregistre qui a parlé, et pas seulement qui a demandé', () => {
    expect(ACTIONS).toMatch(/spokenById: context\.member\.id/);
    expect(ACTIONS).toMatch(/reviewerId: relecteur\.id/);
  });

  it('garde la question posée avec l’enregistrement', () => {
    // Une réponse sans énoncé n'est pas une réponse.
    expect(ACTIONS).toMatch(/promptText: question \|\| null/);
  });

  it('n’autorise la destruction qu’à celui dont c’est la voix', () => {
    const action = ACTIONS.slice(ACTIONS.indexOf('effacerEntretien'));
    expect(action).toMatch(/spokenById: context\.member\.id/);
  });

  it('détruit aussi l’audio : garder l’original trahirait la promesse', () => {
    const action = ACTIONS.slice(ACTIONS.indexOf('effacerEntretien'));
    expect(action).toMatch(/archive\.delete/);
    expect(action).toMatch(/\$transaction/);
  });

  it('n’efface plus rien dès qu’un récit en est né', () => {
    // Le récit a été relu et validé par un humain : il ne dépend plus de sa
    // source, et l'effacer emporterait le travail du relecteur.
    const action = ACTIONS.slice(ACTIONS.indexOf('effacerEntretien'));
    expect(action).toMatch(/!draft\.storyId/);
  });

  it('propose la réécoute avant de garder, jamais après', () => {
    expect(ENTRETIEN.reecoute).toMatch(/Réécoutez avant de garder/);
  });
});

// ─── Le signal comportemental ───

describe('Deux passages sur le même sujet, et l’on cesse de le proposer', () => {
  function service(questionDuPasseur: { text: string; justification: string; storyId: string | null } | null) {
    const passeur = { generateQuestion: async () => questionDuPasseur };
    const reserves = { entitesEnReserve: async () => new Set<string>() };
    const prisma = {
      story: { findUnique: async () => ({ linkedEntities: [{ id: 'e_robert' }] }) },
    } as unknown as PrismaClient;
    return new EntretienService(prisma, passeur as never, reserves as never);
  }

  const duPasseur = { text: 'Et la montre ?', justification: 'Ce récit dit…', storyId: 's_1' };

  it('propose le sujet la première fois', async () => {
    const q = await service(duPasseur).prochaineQuestion('fam_1', 'mem_1', []);
    expect(q.texte).toBe('Et la montre ?');
  });

  it('le propose encore après un seul passage', async () => {
    const q = await service(duPasseur).prochaineQuestion('fam_1', 'mem_1', ['e_robert']);
    expect(q.texte).toBe('Et la montre ?');
  });

  it('cesse au deuxième, silencieusement', async () => {
    const q = await service(duPasseur).prochaineQuestion('fam_1', 'mem_1', ['e_robert', 'e_robert']);
    expect(q.texte).not.toBe('Et la montre ?');
    expect(QUESTIONS_DE_DEPART).toContain(q.texte);
    // Silencieusement : la justification ne dit pas qu'un sujet a été retiré.
    expect(q.justification).not.toMatch(/passé|évité|retiré|vous avez/i);
  });

  it('a toujours une question à poser, même sans aucun récit', async () => {
    const q = await service(null).prochaineQuestion('fam_1', 'mem_1', []);
    expect(QUESTIONS_DE_DEPART).toContain(q.texte);
    expect(q.storyId).toBeNull();
  });

  it('n’expose aucune fonction qui ferait AJOUTER un sujet', () => {
    expect(SERVICE).not.toMatch(/insiste|renforce|prioriseSi|remonte[rz]Sujet/i);
  });
});

// ─── Le langage ───

describe('Tout ce que l’entretien dit franchit les deux filtres', () => {
  it('ne déduit aucune émotion et n’exerce aucune pression', () => {
    for (const phrase of phrasesDeLEntretien()) {
      expect(constitutionEmotionFilter(phrase), phrase).toBe(true);
      expect(isNonCoerciveLanguage(phrase), phrase).toBe(true);
    }
  });

  it('pose la question de la réserve une fois, sans la répéter à chaque écran', () => {
    expect(AVANT).toMatch(/ENTRETIEN\.reserve/);
    expect(PARLER).not.toMatch(/ENTRETIEN\.reserve/);
  });

  it('dit que la réserve ne se voit nulle part', () => {
    expect(AVANT).toMatch(/personne dans la famille n[’']en est informé/i);
  });

  it('dit qu’une demande portée n’empêche personne d’écrire', () => {
    // L'application porte la demande. Elle ne l'applique jamais.
    expect(AVANT).toMatch(/n[’']empêche personne d[’']écrire/i);
  });
});

// ─── La porte d'entrée ───

describe('L’entretien est atteignable sans devenir une huitième section', () => {
  it('est proposé depuis « Raconter », en lien texte et jamais en bouton', () => {
    const nouveau = sansCommentaires('src', 'app', 'recits', 'nouveau', 'page.tsx');
    expect(nouveau).toMatch(/href="\/entretien"/);
    const lien = nouveau.slice(nouveau.indexOf('href="/entretien"') - 60, nouveau.indexOf('href="/entretien"') + 60);
    expect(lien).toMatch(/className="underline"/);
    expect(lien).not.toMatch(/btn/);
  });
});

// ─── L'écran où l'on parle est nu ───

describe('L’écran où l’on parle ne demande rien à lire d’autre', () => {
  const NAV = sansCommentaires('src', 'components', 'Nav.tsx');
  const RECORDER = sansCommentaires('src', 'components', 'AudioRecorder.tsx');

  it('retire la navigation sur cet écran, et sur celui-là seulement', () => {
    // Neuf entrées de menu au-dessus d'une question posée à voix haute,
    // c'est neuf choses à ne pas lire pour quelqu'un qui doit seulement se
    // souvenir. Vu à l'écran, pas déduit du code.
    expect(NAV).toMatch(/pathname\.startsWith\('\/entretien\/parler'\)/);
    // L'écran d'avant, lui, reste une page normale.
    expect(NAV).not.toMatch(/startsWith\('\/entretien'\)[^/]/);
  });

  it('laisse le pied de page et « Terminer » : rien ne devient inatteignable', () => {
    expect(PARLER).toMatch(/ENTRETIEN\.terminer/);
    const LAYOUT = sansCommentaires('src', 'app', 'layout.tsx');
    expect(LAYOUT).toMatch(/Exporter la mémoire/);
  });

  it('permet de réécouter AVANT que le son ne parte', () => {
    // « Vous pouvez l'effacer de notre serveur » et « il n'a jamais quitté
    // votre appareil sans votre accord » ne sont pas la même promesse.
    expect(RECORDER).toMatch(/URL\.createObjectURL\(blob\)/);
    expect(RECORDER).toMatch(/<audio src=\{preview\} controls/);
  });

  it('permet de renoncer sans rien envoyer', () => {
    expect(RECORDER).toMatch(/function jeter\(\)/);
    expect(RECORDER).toMatch(/URL\.revokeObjectURL/);
    expect(RECORDER).toMatch(/input\.value = ''/);
  });
});
