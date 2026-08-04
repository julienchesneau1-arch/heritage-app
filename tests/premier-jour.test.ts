import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS, INVENTAIRE_VIDE, PREMIER_JOUR } from '@/lib/sections';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

/**
 * LES DEUX PREMIÈRES SECONDES.
 *
 * Vérifié sur une famille neuve, en conditions réelles : le premier écran
 * n'affichait que le nom de la famille, sous un menu de neuf entrées dont
 * sept menaient à une page vide. Rien ne disait ce qu'était le produit, ni
 * quoi faire. La parcimonie, parfaitement appliquée, produisait un écran
 * muet — juste pour une mémoire installée, mortel pour une qui commence.
 */

describe('Un menu ne propose que ce qui existe (§6.1)', () => {
  it('ne montre aucune section à une famille qui n’a rien', () => {
    expect(SECTIONS.filter((s) => s.utile(INVENTAIRE_VIDE))).toHaveLength(0);
  });

  it('ouvre les sections dès qu’un récit existe', () => {
    const avec = { ...INVENTAIRE_VIDE, recits: 1 };
    const ouvertes = SECTIONS.filter((s) => s.utile(avec)).map((s) => s.label);
    expect(ouvertes).toEqual(['Veillée', 'Récits', 'Transmission']);
  });

  it('n’ouvre le graphe que lorsqu’il a des nœuds', () => {
    const graphe = SECTIONS.find((s) => s.href === '/graphe')!;
    expect(graphe.utile({ ...INVENTAIRE_VIDE, recits: 10 })).toBe(false);
    expect(graphe.utile({ ...INVENTAIRE_VIDE, entites: 1 })).toBe(true);
  });

  it('n’ouvre « À mettre au propre » que s’il y a quelque chose à relire', () => {
    const brouillons = SECTIONS.find((s) => s.href === '/brouillons')!;
    expect(brouillons.utile({ ...INVENTAIRE_VIDE, recits: 99 })).toBe(false);
    expect(brouillons.utile({ ...INVENTAIRE_VIDE, brouillons: 1 })).toBe(true);
  });

  it('ne rend aucune section inatteignable : chacune sait dire à quoi elle sert', () => {
    // Les sections repliées sont listées sous « Tout le reste » avec leur
    // rôle. Sans cette phrase, on cacherait le produit au lieu de le calmer.
    for (const section of SECTIONS) {
      expect(section.role.length).toBeGreaterThan(20);
      expect(section.role.endsWith('.')).toBe(true);
    }
  });
});

describe('Le premier écran dit ce que c’est, comment ça marche, quoi faire', () => {
  it('nomme le lieu plutôt que le manque (§6.2)', () => {
    // « Vous n'avez encore rien écrit » constate un manque ; « Ici, la
    // famille se raconte » décrit un lieu. La Constitution interdit le
    // premier — c'est du chantage émotionnel déguisé en information.
    const tout = [PREMIER_JOUR.quoi('Martin'), PREMIER_JOUR.comment, PREMIER_JOUR.rassurance];
    for (const phrase of tout) {
      expect(phrase).not.toMatch(/vous n[’']avez|il y a longtemps|pas encore de récit|aucun récit/i);
    }
  });

  it('franchit le filtre constitutionnel', () => {
    for (const phrase of [
      PREMIER_JOUR.quoi('Martin'),
      PREMIER_JOUR.comment,
      PREMIER_JOUR.rassurance,
      PREMIER_JOUR.action,
    ]) {
      expect(constitutionEmotionFilter(phrase)).toBe(true);
      expect(isNonCoerciveLanguage(phrase)).toBe(true);
    }
  });

  it('tient en trois phrases : plus long ne se lit pas en deux secondes', () => {
    const total = [PREMIER_JOUR.quoi('Martin'), PREMIER_JOUR.comment, PREMIER_JOUR.rassurance]
      .join(' ')
      .length;
    expect(total).toBeLessThan(320);
  });

  it('explique que rien n’est à rédiger — c’est le verrou qu’on vient d’ôter', () => {
    expect(PREMIER_JOUR.rassurance).toMatch(/rien à rédiger/i);
  });
});

describe('Le premier écran ne propose qu’une seule action (§6.1)', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'premier-jour.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('n’affiche qu’un seul formulaire', () => {
    expect(source.match(/<ChampDeParole/g) ?? []).toHaveLength(1);
  });

  it('ne propose ni visite guidée, ni liste d’étapes à cocher', () => {
    expect(source).not.toMatch(/étape|tutoriel|bienvenue dans|découvrir|commencer par|checklist/i);
  });

  it('n’offre qu’un seul autre chemin, et jamais sous forme de bouton', () => {
    // §6.1 interdit plus d'une SUGGESTION par écran. Reprendre une
    // conversation qui existe déjà n'est pas une seconde suggestion : c'est
    // l'autre porte du même geste, pour une famille qui a déjà parlé
    // ailleurs. Mais elle ne doit pas rivaliser avec l'action : un lien en
    // texte, pas un bouton.
    const liens = source.match(/<Link/g) ?? [];
    expect(liens).toHaveLength(1);
    expect(source).toMatch(/<Link[^>]*className="underline"/);
    expect(source).not.toMatch(/<Link[^>]*className="[^"]*\bbtn/);
  });

  it('nomme l’autre chemin sans reprocher l’absence de récits', () => {
    expect(PREMIER_JOUR.autreChemin).not.toMatch(/vous n[’']avez|aucun récit|vide/i);
    expect(constitutionEmotionFilter(PREMIER_JOUR.autreChemin)).toBe(true);
    expect(isNonCoerciveLanguage(PREMIER_JOUR.autreChemin)).toBe(true);
  });
});
