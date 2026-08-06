import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTEURS, DECES, estDecede, peutAgir } from '@/lib/deces';

/**
 * LA MORT — « il cesse d'être un acteur, il reste un sujet ».
 *
 * Le défaut d'origine, trouvé en relisant `relecteursPossibles` : le filtre
 * ne portait que sur `isDeleted`, c'est-à-dire « retiré de la famille ». Un
 * défunt n'est pas retiré. L'écran de l'entretien proposait donc une
 * grand-mère MORTE comme relectrice de l'enregistrement qu'on venait de
 * faire sur elle.
 *
 * Ces tests fixent la doctrine, parce qu'elle se défera autrement : chaque
 * futur écran qui listera des membres devra choisir entre les deux rôles, et
 * `isDeleted: false` restera toujours le réflexe le plus court.
 */

const lire = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');
const sansCommentaires = (...parts: string[]) =>
  lire(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Un défunt cesse d’être un acteur', () => {
  it('la distinction « retiré » / « décédé » est explicite', () => {
    expect(ACTEURS).toEqual({ isDeleted: false, deathDate: null });
    expect(peutAgir({ isDeleted: false, deathDate: null })).toBe(true);
    expect(peutAgir({ isDeleted: false, deathDate: new Date('2020-01-01') })).toBe(false);
    expect(peutAgir({ isDeleted: true, deathDate: null })).toBe(false);
    expect(estDecede({ deathDate: new Date('2020-01-01') })).toBe(true);
    expect(estDecede({ deathDate: null })).toBe(false);
  });

  it('il n’est plus proposé pour relire un entretien', () => {
    const SERVICE = sansCommentaires('src', 'services', 'entretien.service.ts');
    expect(SERVICE).toMatch(/relecteursPossibles[\s\S]{0,400}\.\.\.ACTEURS/);
    // Le filtre nu est précisément ce qui a produit le défaut.
    expect(SERVICE).not.toMatch(/relecteursPossibles[\s\S]{0,400}isDeleted: false,\s*id: \{ not/);
  });

  it('on ne peut pas prendre son identité', () => {
    expect(sansCommentaires('src', 'app', 'qui', 'page.tsx')).toMatch(/\.filter\(peutAgir\)/);
  });

  it('son lien personnel n’ouvre plus de session à son nom', () => {
    const ROUTE = sansCommentaires('src', 'app', 'f', '[familyId]', 'm', '[memberId]', '[token]', 'route.ts');
    expect(ROUTE).toMatch(/\.\.\.ACTEURS/);
    // Et le refus se distingue d'un lien cassé, sinon la famille croit à
    // une panne et fait tourner un lien qui n'a rien.
    expect(ROUTE).toMatch(/decede/);
    expect(sansCommentaires('src', 'app', 'bienvenue', 'page.tsx')).toMatch(/DECES\.lienRefuse/);
  });
});

describe('Un défunt reste un sujet', () => {
  it('il reste NARRATEUR — c’est l’objet même du produit après une mort', () => {
    const PAGE = sansCommentaires('src', 'app', 'recits', 'nouveau', 'page.tsx');
    // La liste des narrateurs ne filtre PAS sur la mort.
    expect(PAGE).not.toMatch(/members[\s\S]{0,120}peutAgir/);
    // Et le temps du verbe change : « racontait », pas « raconte ».
    expect(PAGE).toMatch(/estDecede\(member\)/);
    expect(PAGE).toMatch(/racontait/);
  });

  it('la page Famille le dit une fois, sans emphase', () => {
    const PAGE = lire('src', 'app', 'famille', 'page.tsx');
    expect(PAGE).toMatch(/DECES\.mention/);
    expect(PAGE).toMatch(/DECES\.consequence/);
  });

  it('le produit n’ajoute aucun deuil de son cru — §12', () => {
    // Pas d'inférence émotionnelle : le produit ne sait pas ce que cette
    // mort fait à cette famille, et n'a pas à le supposer.
    const tout = Object.values(DECES).join(' ');
    expect(tout).not.toMatch(/mémoire de|regretté|disparu|nos pensées|condoléances|paix/i);
    expect(DECES.mention).toBe('Cette personne est décédée.');
  });

  it('la doctrine tient en une phrase, écrite dans le fichier', () => {
    expect(lire('src', 'lib', 'deces.ts')).toMatch(
      /cesse d.être un acteur.{0,20}reste un sujet/i,
    );
  });
});

describe('La primitive a repris sa place — Annexe A point 1', () => {
  const PAGE = lire('src', 'app', 'recits', '[storyId]', 'page.tsx');

  it('« Raconter la suite » n’est plus un outil parmi d’autres', () => {
    // Il vivait entre « Archiver » et « Corriger », en `btn`.
    expect(PAGE).toMatch(/Raconter la suite/);
    const geste = PAGE.slice(0, PAGE.indexOf('Raconter la suite'));
    expect(geste).toMatch(/btn-primary w-full/);
  });

  it('il vient AVANT le fil et les outils, contre le texte du récit', () => {
    // On compare des ANCRES qui ne peuvent pas apparaître dans un
    // commentaire — mon explication cite « Archiver », et le test se
    // comparait alors à sa propre justification. Retirer les commentaires
    // ne suffisait pas non plus : le nettoyage emportait au passage la
    // section du fil. Des ancres de code exactes lèvent les deux pièges.
    const suite = PAGE.indexOf('Raconter la suite');
    expect(suite).toBeGreaterThan(PAGE.indexOf('{story.content}'));
    expect(suite).toBeLessThan(PAGE.indexOf('<section id="conversations"'));
    expect(suite).toBeLessThan(PAGE.indexOf("{story.archived ? 'Désarchiver' : 'Archiver'}"));
  });

  it('la filiation se lit, et ne se compte pas — §12', () => {
    expect(PAGE).toMatch(/Né de/);
    expect(PAGE).toMatch(/A fait naître/);
    // Aucun nombre : ni « 2 récits », ni un taux.
    expect(PAGE).not.toMatch(/\{\s*story\.(parent|child)Passages\.length\s*\}/);
  });
});

describe('Parcimonie — Annexe A point 2', () => {
  it('le type de structure ne s’imprime plus sur chaque récit', () => {
    // C'est une étiquette de classement : utile au filtre et au Passeur,
    // muette pour qui vient lire l'histoire de sa grand-mère.
    for (const chemin of [
      ['src', 'app', 'recits', 'page.tsx'],
      ['src', 'app', 'recits', '[storyId]', 'page.tsx'],
    ]) {
      expect(sansCommentaires(...chemin)).not.toMatch(/\{story\.structureType\}/);
    }
  });

  it('mais il reste choisissable, et dans l’export', () => {
    // Retirer l'affichage n'est pas retirer la donnée.
    expect(sansCommentaires('src', 'app', 'recits', 'page.tsx')).toMatch(/STRUCTURE_TYPES\.map/);
    expect(sansCommentaires('src', 'services', 'export.service.ts')).toMatch(/stories/);
  });
});

describe('La demande d’un mort ne s’éteint pas', () => {
  /**
   * Une demande portée s'adressait à la famille : « ne parlez pas de cela ».
   * La mort de qui l'a formulée ne la retire pas — elle la rend définitive,
   * puisque personne ne peut plus la lever. La §2.6 interdit de décider à la
   * place d'un autre ; on ne décide pas davantage à la place de quelqu'un
   * qui ne peut plus parler.
   */
  it('le service dit si l’auteur de la demande est décédé', () => {
    const SERVICE = sansCommentaires('src', 'services', 'reserve.service.ts');
    expect(SERVICE).toMatch(/decede:\s*\(r\.member\.deathDate \?\? null\) !== null/);
  });

  it('et l’écran le dit, sinon la demande se lit comme encore négociable', () => {
    expect(sansCommentaires('src', 'app', 'graphe', 'page.tsx')).toMatch(
      /demande\.decede[\s\S]{0,120}DECES\.reserveMaintenue/,
    );
  });

  it('aucune phrase de `DECES` n’est écrite sans être utilisée', () => {
    // Une constante qui promet un comportement sans le brancher est
    // exactement le défaut que ce dépôt poursuit : affirmer sans établir.
    const SOURCES = [
      'src/app/famille/page.tsx',
      'src/app/bienvenue/page.tsx',
      'src/app/graphe/page.tsx',
    ]
      .map((chemin) => readFileSync(join(process.cwd(), chemin), 'utf8'))
      .join('\n');
    for (const clef of Object.keys(DECES)) {
      expect(SOURCES).toContain(`DECES.${clef}`);
    }
  });
});
