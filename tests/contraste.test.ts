import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LE CONTRASTE, MESURÉ.
 *
 * La §6.4 exige 4,5:1. Jusqu'ici la règle était appliquée à la main et
 * vérifiée à l'œil — c'est-à-dire affirmée, jamais établie. La direction de
 * design reçue annonçait elle aussi « fonds descendus d'un cran pour tenir
 * 4,5:1 » ; sa classe de texte atténué, la plus utilisée de toutes,
 * mesurait 3,57:1.
 *
 * C'est exactement l'amendement 6 appliqué à une couleur : on ne dit pas
 * qu'un contraste passe, on le calcule. Formule WCAG 2.1, sans dépendance.
 */

// ─── La formule ───

function canalLineaire(valeur: number): number {
  const c = valeur / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (
    0.2126 * canalLineaire(r!) + 0.7152 * canalLineaire(g!) + 0.0722 * canalLineaire(b!)
  );
}

export function contraste(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ─── Les couleurs, lues dans la configuration et non recopiées ───

const CONFIG = readFileSync(join(process.cwd(), 'tailwind.config.ts'), 'utf8');

function couleur(chemin: string): string {
  // « accent.700 » ou « paper ». On lit le fichier pour que le test échoue
  // si quelqu'un change une valeur sans revenir ici.
  const [famille, niveau] = chemin.split('.');
  // Les clés composées sont entre guillemets dans la configuration
  // (`'muted-clair':`) : le motif doit les accepter, sinon le test échoue
  // sur une couleur qui existe.
  const motif = niveau
    ? new RegExp(`${famille}:\\s*\\{[^}]*?['"]?\\b${niveau}['"]?:\\s*'(#[0-9a-f]{6})'`, 'is')
    : new RegExp(`['"]?\\b${famille}['"]?:\\s*'(#[0-9a-f]{6})'`, 'i');
  const trouve = CONFIG.match(motif);
  if (!trouve) throw new Error(`couleur introuvable dans tailwind.config.ts : ${chemin}`);
  return trouve[1]!;
}

/** Seuil WCAG : 3:1 au-delà de 24 px, 4,5:1 en dessous. */
const PAIRES: Array<[string, string, string, number]> = [
  ['texte sur papier', 'ink', 'paper', 16],
  ['justification sur papier', 'muted', 'paper', 16],
  ['justification sur carte', 'muted-clair', 'neutre.100', 16],
  ['justification sur carte du Passeur', 'muted-chaud', 'accent.300', 16],
  ['corps sur aplat terre cuite', 'accent.100', 'accent.700', 19],
  ['justification claire sur aplat', 'accent.200', 'accent.700', 16],
  ['barre du premier jour', 'accent.100', 'accent.800', 16],
  ['lien de la barre', 'accent.200', 'accent.800', 16],
  ['titre sur bandeau sauge', 'neutre.100', 'sauge.700', 19],
  ['justification sur bandeau sauge', 'sauge.200', 'sauge.700', 16],
  ['corps de la veillée', 'neutre.100', 'neutre.900', 25],
  ['justification de la veillée', 'neutre.300', 'neutre.900', 16],
  ['position de la veillée', 'accent.400', 'neutre.900', 16],
  ['bouton principal', 'accent.100', 'accent.700', 16],
  ['bouton de la veillée', 'accent.900', 'accent.400', 16],
  ['bouton de la carte du Passeur', 'accent.100', 'accent.900', 16],
  ['bouton secondaire de la carte', 'accent.900', 'accent.200', 16],
];

describe('Toutes les paires de couleurs du produit tiennent la §6.4', () => {
  it.each(PAIRES)('%s', (_nom, avant, arriere, taille) => {
    const seuil = taille >= 24 ? 3 : 4.5;
    const mesure = contraste(couleur(avant), couleur(arriere));
    expect(mesure).toBeGreaterThanOrEqual(seuil);
  });

  it('vérifie bien quelque chose : la formule reconnaît un échec', () => {
    // Sans ce contrôle, une erreur dans `contraste()` rendrait tout vert.
    expect(contraste('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contraste('#777777', '#808080')).toBeLessThan(1.2);
  });

  it('refuserait le gris de la direction d’origine', () => {
    // `color-mix(ink 55%, transparent)` sur crème donnait #807a71.
    // C'est la valeur qui a été mesurée à 3,57:1 et corrigée.
    expect(contraste('#807a71', couleur('paper'))).toBeLessThan(4.5);
    expect(contraste(couleur('muted'), couleur('paper'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Les polices sont servies par l’application, jamais par un tiers', () => {
  const CSS = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');

  it('ne charge aucune police distante', () => {
    // Rendu sans réseau, un `@import` Google Fonts se résout en `system-ui`
    // et toute l'identité disparaît SANS QUE ÇA SE VOIE. L'application est
    // une PWA avec page hors-ligne.
    expect(CSS).not.toMatch(/@import[^;]*fonts\.googleapis|fonts\.gstatic/);
  });

  it('déclare les fichiers locaux', () => {
    for (const fichier of ['caprasimo-400', 'figtree-400', 'figtree-600', 'figtree-700']) {
      expect(CSS).toContain(`/polices/${fichier}.woff2`);
    }
  });

  it('affiche le texte sans attendre la police', () => {
    // `font-display: swap` : une mémoire familiale ne fait pas attendre
    // quelqu'un devant un écran blanc. On compte les BLOCS, pas les
    // occurrences — le mot apparaît aussi dans le commentaire qui l'explique.
    const blocs = CSS.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(blocs).toHaveLength(4);
    for (const bloc of blocs) expect(bloc).toMatch(/font-display: swap/);
  });
});

describe('Aucune opacité ne vient défaire un contraste mesuré', () => {
  /**
   * Le défaut trouvé par axe-core, et que ce fichier ne voyait pas.
   *
   * `text-muted` mesure 4,84:1 sur crème. La barre de navigation lui
   * appliquait `opacity-80` : à l'écran, 3,28:1. Je mesurais le JETON,
   * l'écran affichait le jeton MULTIPLIÉ par une opacité — c'est
   * exactement le piège que j'avais reproché à la maquette.
   *
   * Une couleur pleine, jamais une opacité : la rampe en compte neuf, il
   * y en a toujours une qui convient.
   */
  const SOURCES = ['src/components/Nav.tsx', 'src/app/page.tsx', 'src/app/layout.tsx'];

  it.each(SOURCES)('%s n’atténue aucun texte par opacité', (chemin) => {
    const code = readFileSync(join(process.cwd(), chemin), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    // `opacity-*` sur du texte. Les formes décoratives, elles, ont le droit
    // — elles ne portent aucun mot (`/50`, `/60` sur un fond).
    expect(code).not.toMatch(/\bopacity-(?!100\b)\d{1,2}\b/);
  });
});

describe('Le plancher de 16 px tient dans tout le produit', () => {
  /**
   * La §6.4 pose « 16 px minimum ». C'était vrai du `html { font-size }` et
   * faux de vingt-neuf endroits : étiquettes de champs, listes déroulantes,
   * zones de saisie et pastilles d'entités descendaient à 14, parfois 12 px.
   *
   * Le plancher ne vaut que s'il est vérifié. Deux exceptions, et deux
   * seulement : la classe `.section-label` et la position de la veillée,
   * qui sont des CAPITALES ESPACÉES de deux ou trois mots — une forme que
   * WCAG traite comme un libellé et non comme du texte à lire. Toute autre
   * apparition de `text-sm` ou `text-xs` fait échouer ce test, et c'est le
   * but : le rattrapage se fait ici, pas à l'œil, six mois plus tard.
   */
  const SOURCES: string[] = [];
  (function parcourir(dossier: string) {
    for (const entree of readdirSync(dossier)) {
      const chemin = join(dossier, entree);
      if (statSync(chemin).isDirectory()) parcourir(chemin);
      else if (/\.tsx?$/.test(entree)) SOURCES.push(chemin);
    }
  })(join(process.cwd(), 'src'));

  const EXEMPTS = new Set([
    // La position dans la veillée : « 2 SUR 3 », capitales espacées.
    join(process.cwd(), 'src', 'app', 'veillee', 'page.tsx'),
  ]);

  it('aucun fichier ne descend sous le corps de base', () => {
    const fautifs = SOURCES.filter((chemin) => {
      if (EXEMPTS.has(chemin)) return false;
      const code = readFileSync(chemin, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return /\btext-(sm|xs)\b/.test(code);
    }).map((chemin) => chemin.replace(process.cwd() + '/', ''));
    expect(fautifs).toEqual([]);
  });

  it('une étiquette de champ se lit en casse normale, jamais en capitales', () => {
    // `.section-label` est un intertitre de deux mots. Posé sur un `<label>`,
    // il transforme « Cette personne écoutera l'enregistrement » en une
    // ligne de capitales espacées, qui se lit lettre à lettre — au moment
    // exact où l'on demande à quelqu'un de choisir qui l'écoutera.
    const fautifs = SOURCES.filter((chemin) =>
      /<label[^>]*className="[^"]*\bsection-label\b/s.test(readFileSync(chemin, 'utf8')),
    ).map((chemin) => chemin.replace(process.cwd() + '/', ''));
    expect(fautifs).toEqual([]);
  });

  it('vérifie bien quelque chose', () => {
    // Sans ce contrôle, une expression rationnelle cassée rendrait vert un
    // produit entièrement composé en 12 px.
    expect(/\btext-(sm|xs)\b/.test('className="font-sans text-sm"')).toBe(true);
    expect(/<label[^>]*className="[^"]*\bsection-label\b/s.test('<label className="section-label">')).toBe(true);
  });
});
