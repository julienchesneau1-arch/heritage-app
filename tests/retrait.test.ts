import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS } from '@/lib/sections';
import { dateDuRecit, moisJourEnClair } from '@/lib/normalize';

/**
 * LA PASSE DE RETRAIT.
 *
 * Toutes les relectures précédentes ont cherché ce qui manquait. Celle-ci
 * cherche ce qui doit PARTIR, avec une seule question par écran : qu'est-ce
 * que la famille perd si on l'enlève ?
 *
 * Deux règles du document n'étaient appliquées qu'à l'endroit où je les
 * avais écrites, alors qu'elles sont générales :
 *
 *  - §12, « ne pas utiliser de like ni de score ». Vérifiée dans le fil
 *    seulement. La page Transmission servait un pourcentage en corps 4xl
 *    avec une cible à atteindre ; les traditions affichaient « relevée
 *    3 fois » ; la liste des récits, « a engendré 2 récits ».
 *  - L'interdit d'afficher l'inactivité, écrit pour le fil. Les traditions
 *    affichaient « dernière fois le 15 octobre 2024 » — sur une tradition
 *    annuelle, onze mois sur douze, cette ligne dit à une famille qu'elle
 *    est en retard sur elle-même.
 *
 * Ces tests portent sur TOUTES les pages, pour que la prochaine page écrite
 * hérite de la règle au lieu de la redécouvrir.
 */

/** Le code sans ses commentaires : sinon on teste sa propre documentation. */
function sansCommentaires(chemin: string): string {
  return readFileSync(chemin, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Toutes les pages rendues à un membre de la famille. */
function pages(): Array<{ chemin: string; source: string }> {
  const racine = join(process.cwd(), 'src', 'app');
  const trouvees: Array<{ chemin: string; source: string }> = [];

  const parcourir = (dossier: string) => {
    for (const entree of readdirSync(dossier)) {
      const complet = join(dossier, entree);
      if (statSync(complet).isDirectory()) {
        // `api` ne rend rien à un humain : ce sont mes instruments, et la
        // §12 ne leur interdit rien. Ils gardent tous les chiffres.
        if (entree !== 'api') parcourir(complet);
      } else if (entree === 'page.tsx') {
        trouvees.push({ chemin: complet.slice(racine.length + 1), source: sansCommentaires(complet) });
      }
    }
  };

  parcourir(racine);
  return trouvees;
}

const PAGES = pages();

describe('Aucun écran ne note la famille (§12)', () => {
  it('trouve bien les pages — un test qui ne lit rien ne prouve rien', () => {
    expect(PAGES.length).toBeGreaterThan(10);
    expect(PAGES.map((p) => p.chemin)).toContain(join('transmission', 'page.tsx'));
  });

  it('n’affiche jamais un objectif à atteindre', () => {
    // « Objectif V1 : > 20 % » (§9.1) est MA cible, pas la leur. Servie à
    // une famille, elle transforme une mémoire en tableau de bord.
    //
    // Le mot n'est interdit qu'ISOLÉ : sans la sentinelle, `distortionScore`
    // — un nom de champ que la reddition de comptes doit justement afficher —
    // faisait échouer le test, et les deux règles de ce fichier se
    // contredisaient. On interdit une phrase, pas un identifiant.
    const grade = /(?<![A-Za-z])(objectif|cible|palier|score)/i;
    for (const page of PAGES) {
      expect(page.source, page.chemin).not.toMatch(grade);
    }
  });

  it('n’affiche plus le taux de transmission comme une note', () => {
    const transmission = PAGES.find((p) => p.chemin.startsWith('transmission'))!;
    expect(transmission.source).not.toMatch(/transmissionRate|passeurConversion|maxChainDepth/);
    expect(transmission.source).not.toMatch(/medianLatencyDays|rawPassageRatio/);
  });

  it('garde ce qui est dû : ce que l’algorithme écarte (§6.3, Annexe A point 5)', () => {
    // Le retrait ne doit pas emporter la reddition de comptes. Une page qui
    // ne dirait plus rien serait pire qu'une page qui notait.
    const transmission = PAGES.find((p) => p.chemin.startsWith('transmission'))!;
    for (const dû of ['invisibleStories', 'overexposedStories', 'quarantinedStories', 'distortionScore']) {
      expect(transmission.source, dû).toContain(dû);
    }
  });

  it('ne compte plus les accomplissements d’une tradition', () => {
    const traditions = PAGES.find((p) => p.chemin.startsWith('traditions'))!;
    expect(traditions.source).not.toContain('activationCount');
  });

  it('ne classe plus les récits par ce qu’ils ont engendré', () => {
    // La §5.2 demande la chaîne SUR le récit — « né de X, a engendré Y »,
    // des liens qu'on suit. Réduite à un nombre dans un index trié, la même
    // information devient une colonne de classement.
    const liste = PAGES.find((p) => p.chemin === join('recits', 'page.tsx'))!;
    expect(liste.source).not.toMatch(/a engendré|parentPassages/);

    // Le chemin EXACT : `includes` attrapait d'abord `[storyId]/modifier`,
    // et le test passait sur une page qui n'affiche aucune chaîne.
    const recit = PAGES.find((p) => p.chemin === join('recits', '[storyId]', 'page.tsx'))!;
    expect(recit.source).toMatch(/Passage|passages|engendr/i);
  });
});

describe('Aucun écran n’exhibe l’inactivité', () => {
  it('ne date jamais la dernière fois qu’une chose a eu lieu, hors reddition de comptes', () => {
    // L'exception est nommée, et une seule : « Rappel patrimonial » liste
    // les récits non relus depuis douze mois. C'est l'Annexe A point 5 —
    // garantir qu'aucun récit ne devient inaccessible par l'algorithme —
    // et cette page est justement celle où le produit s'accuse lui-même.
    for (const page of PAGES) {
      if (page.chemin.startsWith('transmission')) continue;
      expect(page.source, page.chemin).not.toMatch(
        /dernière fois|lastActivatedAt|inactif|depuis \d+ (jour|semaine|mois|an)/i,
      );
    }
  });
});

describe('Ce que le produit ÉCRIT en base finit à l’écran, et suit les mêmes règles', () => {
  /**
   * Le trou de la règle précédente : elle ne lit que les `page.tsx`. Or une
   * phrase composée dans un service et rangée en base s'affiche exactement
   * comme une phrase écrite dans du JSX. `sleepReason` en est une —
   * « Non relevée depuis 3 ans » passait sous le radar parce qu'elle vivait
   * dans `tradition.service.ts`.
   */
  const SERVICE = sansCommentaires(join(process.cwd(), 'src', 'services', 'tradition.service.ts'));

  it('n’accuse pas la famille d’avoir laissé tomber une tradition', () => {
    const raison = SERVICE.match(/sleepReason: `([^`]+)`/)?.[1];
    expect(raison, 'la raison du sommeil doit rester lisible dans le source').toBeTruthy();
    expect(raison).not.toMatch(/^Non |oubli|abandonn|négligé/i);
    // Le sujet de la phrase est l'application, pas la famille.
    expect(raison).toMatch(/^L[’']application/);
  });

  it('dit tout de même pourquoi elle dort : un sommeil sans raison serait pire', () => {
    expect(SERVICE).toMatch(/sleepReason: `[^`]*\$\{SLEEP_AFTER_MISSED_YEARS\}/);
  });
});

describe('Aucun écran n’affirme une date qu’il ne connaît pas (amendement 6)', () => {
  it('ne substitue jamais la date de saisie à celle de l’événement', () => {
    // « La montre arrêtée · 3 janvier 2026 », sans étiquette, se lit comme
    // la date de l'histoire. C'était la date où quelqu'un l'a tapée.
    for (const page of PAGES) {
      expect(page.source, page.chemin).not.toMatch(/eventDate\s*\?\?\s*\w+\.createdAt/);
    }
  });

  it('rend la date de l’événement quand elle existe', () => {
    expect(dateDuRecit({ eventDate: new Date(1971, 10, 3), createdAt: new Date(2026, 0, 3) })).toBe(
      '3 novembre 1971',
    );
  });

  it('nomme la date de saisie quand l’événement n’est pas daté', () => {
    const rendu = dateDuRecit({ eventDate: null, createdAt: new Date(2026, 0, 3) });
    expect(rendu).toBe('noté le 3 janvier 2026');
    // Le mot compte autant que la date : sans lui, la substitution est
    // exactement celle qu'on vient de retirer.
    expect(rendu).toMatch(/^noté le /);
  });
});

describe('Une date de tradition se lit en français', () => {
  it('rend le mois en toutes lettres', () => {
    // « Chaque année, le 10-15 » : le format de stockage servi tel quel.
    expect(moisJourEnClair('10-15')).toBe('le 15 octobre');
    expect(moisJourEnClair('01-06')).toBe('le 6 janvier');
  });

  it('dit « 1er » et non « 1 »', () => {
    expect(moisJourEnClair('11-01')).toBe('le 1er novembre');
  });

  it('n’invente pas de mois quand la valeur est illisible', () => {
    // Mieux vaut afficher un code qu'affirmer une date fausse.
    for (const valeur of ['13-45', '00-10', 'octobre', '10-15-2026', '']) {
      expect(moisJourEnClair(valeur)).toBe(`le ${valeur}`);
    }
  });
});

describe('La navigation ne s’allonge pas toute seule', () => {
  it('ne propose pas plus de sept sections en plus d’« Aujourd’hui »', () => {
    // §6.1, parcimonie. La §1 du document en dessine sept ; toute
    // huitième doit coûter le retrait d'une autre, sinon la barre grossit
    // d'une extension à la fois sans que personne n'ait rien décidé.
    expect(SECTIONS.length).toBeLessThanOrEqual(7);
  });

  it('a bien retiré « Transmission » de la barre', () => {
    expect(SECTIONS.map((s) => s.href)).not.toContain('/transmission');
  });

  it('ne la rend pas inatteignable pour autant', () => {
    // Elle descend au pied de page, à côté d'« Exporter la mémoire » : même
    // nature, même fréquence de consultation.
    const layout = sansCommentaires(join(process.cwd(), 'src', 'app', 'layout.tsx'));
    expect(layout).toContain('/transmission');
    expect(layout).toMatch(/export/i);
  });
});
