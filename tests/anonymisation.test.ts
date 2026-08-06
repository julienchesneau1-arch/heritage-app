import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nommer, nomAffiche, QUI } from '@/lib/deces';

/**
 * « ANONYMISÉ » NE S'ARRÊTE À AUCUNE PAGE.
 *
 * La §2.1 règle 1 se précise elle-même : « la règle ne dit pas anonymisé
 * dans les récits, elle dit anonymisé. » `voixDe()` la tenait dans les
 * fils ; partout ailleurs, chaque endroit qui chargeait une personne
 * refaisait le geste — ou l'oubliait.
 *
 * `outils/oubli.mts` a trouvé CINQ sorties où le nom d'un membre retiré
 * ressortait en clair : la page Archives, et les routes du détail d'un
 * récit, des archives, des fils et de la liste des récits. Aucune ne
 * plantait ; toutes servaient un prénom que la famille croyait effacé.
 *
 * La cause n'était pas l'oubli : trois de ces sorties ne POUVAIENT pas
 * anonymiser, leur `select` ne chargeant pas `isDeleted`. Une règle rendue
 * inapplicable par une sélection, sans que rien ne le signale.
 *
 * Ces tests tiennent les deux bouts : la fonction, et l'impossibilité de
 * charger une personne sans de quoi la nommer.
 */

describe('nommer — le point de passage', () => {
  it('rend le nom tel quel pour quelqu’un qui est toujours là', () => {
    expect(nommer({ id: 'm1', name: 'Jeanne Martin', isDeleted: false }).name).toBe('Jeanne Martin');
  });

  it('et « Membre anonymisé » pour quelqu’un qui a été retiré', () => {
    expect(nommer({ id: 'm1', name: 'Jeanne Martin', isDeleted: true }).name).toBe('Membre anonymisé');
  });

  it('laisse passer l’absence de personne — un message peut n’avoir aucun narrateur', () => {
    expect(nommer(null)).toBeNull();
  });

  it('ne touche à rien d’autre que le nom', () => {
    const avant = { id: 'm1', name: 'Jeanne', isDeleted: true, generation: 2 };
    expect(nommer(avant)).toEqual({ ...avant, name: 'Membre anonymisé' });
  });

  it('dit la même chose que `nomAffiche`, qui existait déjà', () => {
    const retire = { id: 'm1', name: 'Jeanne', isDeleted: true };
    expect(nommer(retire).name).toBe(nomAffiche(retire));
  });

  it('`QUI` charge de quoi appliquer la règle', () => {
    // Sans `isDeleted`, `nommer` ne peut rien décider : c'est cette
    // sélection-là qui rendait la règle inapplicable.
    expect(QUI).toEqual({ id: true, name: true, isDeleted: true });
  });
});

/**
 * Le balayage du source. Il vaut mieux qu'un test par fichier : ce qui a
 * manqué la première fois, ce n'est aucune de ces cinq sorties en
 * particulier, c'est le fait que personne ne les avait comptées ensemble.
 */
function fichiers(racine: string): string[] {
  const trouves: string[] = [];
  for (const entree of readdirSync(racine)) {
    const chemin = join(racine, entree);
    if (statSync(chemin).isDirectory()) trouves.push(...fichiers(chemin));
    else if (/\.tsx?$/.test(entree)) trouves.push(chemin);
  }
  return trouves;
}

/** Les relations qui désignent une PERSONNE, et non une entité ou une famille. */
const PERSONNES = ['author', 'narrator', 'uploader', 'openedBy', 'reviewer', 'spokenBy', 'member'];

describe('aucune sélection ne peut rendre la règle inapplicable', () => {
  const sources = fichiers(join(process.cwd(), 'src', 'app'));

  it('partout où une personne est chargée pour être affichée, `isDeleted` l’est aussi', () => {
    const manques: string[] = [];

    for (const chemin of sources) {
      const texte = readFileSync(chemin, 'utf8');
      for (const personne of PERSONNES) {
        // `<relation>: { select: … }` — soit `QUI`, soit un objet qui doit
        // porter `isDeleted`.
        const motif = new RegExp(`\\b${personne}:\\s*\\{\\s*select:\\s*(QUI|\\{[^}]*\\})`, 'g');
        for (const trouve of texte.matchAll(motif)) {
          const selection = trouve[1]!;
          if (selection === 'QUI') continue;
          if (selection.includes('isDeleted')) continue;
          // Une sélection qui ne prend pas le nom ne peut pas le divulguer.
          if (!selection.includes('name')) continue;
          manques.push(`${chemin.replace(process.cwd() + '/', '')} — ${personne}: ${selection}`);
        }
      }
    }

    expect(manques).toEqual([]);
  });

  it('et ce balayage regarde bien quelque chose', () => {
    // Sans cette ligne, un `fichiers()` qui rendrait une liste vide ferait
    // passer le test précédent en n'ayant rien lu — la faute même que
    // `outils/` poursuit.
    expect(sources.length).toBeGreaterThan(20);
    const avecPersonnes = sources.filter((c) =>
      PERSONNES.some((p) => readFileSync(c, 'utf8').includes(`${p}: { select:`)),
    );
    expect(avecPersonnes.length).toBeGreaterThan(3);
  });
});
