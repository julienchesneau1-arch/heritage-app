import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fabriquerCoffre, FORMAT_COFFRE, type CoffreEntree } from '@/lib/coffre';
import { assemblerLivre } from '@/lib/livre';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

/**
 * LE COFFRE — le seul objet du produit qui tienne le point 7 à la lettre.
 *
 * « Le succès ultime est que la famille continue de transmettre sans
 * l'app » (Annexe A, point 7). Le livre s'imprime et l'export rend le JSON,
 * mais les deux exigent que le serveur réponde — donc que quelqu'un le
 * paie, le maintienne, et soit encore là. C'est le risque dominant de ce
 * produit, et rien ne le couvrait.
 *
 * Ces tests portent sur ce qui rend le fichier autonome. Qu'il s'ouvre pour
 * de vrai, réseau coupé, est établi ailleurs : `outils/coffre.mjs`.
 */

const RECIT = (id: string, titre: string, contenu: string) => ({
  id,
  titre,
  contenu,
  createdAt: new Date(2020, 4, 12),
  eventDate: new Date(1971, 2, 3),
  structureType: 'evenement-marquant',
  auteur: { id: 'm1', nom: 'Claire Martin', anonymise: false },
  narrateur: null,
});

function coffre(sur: Partial<CoffreEntree> = {}): string {
  const livre = assemblerLivre(
    [RECIT('s1', 'La montre arrêtée', 'Elle s’est arrêtée le jour de son départ.')],
    [],
    { questionsSansReponse: [], recitsSansDate: [], membresJamaisMentionnes: [] },
  );
  return fabriquerCoffre({
    nomFamille: 'Martin',
    livre,
    donnees: { family: { name: 'Martin' }, stories: [] },
    nonInclus: ['Les octets des photos restent sur le serveur.'],
    fabriqueLe: new Date(2026, 7, 8),
    ...sur,
  });
}

/** Le JSON embarqué, relu comme un programme le relirait. */
function donneesEmbarquees(html: string): unknown {
  const debut = html.indexOf('<script type="application/json" id="heritage-donnees">');
  const ouvrant = html.indexOf('>', debut) + 1;
  const fin = html.indexOf('</script>', ouvrant);
  return JSON.parse(html.slice(ouvrant, fin));
}

describe('Le coffre se lit sans rien d’autre que lui-même', () => {
  it('contient les récits, en toutes lettres', () => {
    const html = coffre();
    expect(html).toContain('La montre arrêtée');
    expect(html).toContain('Elle s’est arrêtée le jour de son départ.');
  });

  it('n’appelle aucune ressource distante — police, image, feuille de style', () => {
    const html = coffre();
    // Une police Google, une image sur un CDN, et le fichier ne s'ouvre
    // plus correctement le jour où le réseau, ou le CDN, n'est plus là.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });

  it('n’exécute aucun code', () => {
    const html = coffre();
    // La seule balise `script` porte `type="application/json"` : le
    // navigateur ne l'exécute pas, c'est une zone de données. Un fichier
    // qui exécute du code est un fichier dont on ignore ce qu'il fera dans
    // vingt ans.
    const balises = html.match(/<script\b[^>]*>/g) ?? [];
    expect(balises).toHaveLength(1);
    expect(balises[0]).toContain('type="application/json"');
    expect(html).not.toMatch(/\bon[a-z]+=/i);
  });

  it('ne ramène jamais vers l’application (point 7)', () => {
    // Un livre qui renvoie vers l'écran est un dépliant publicitaire. Le
    // point 7 dit « sans l'app » — le coffre encore plus que le livre,
    // puisqu'il existe précisément pour le jour où l'adresse ne répond plus.
    const html = coffre();
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/QR|qrcode/i);
  });
});

describe('Le coffre se relit par une machine', () => {
  it('embarque les données, et elles se reparsent', () => {
    const lu = donneesEmbarquees(coffre()) as Record<string, unknown>;
    expect(lu.format).toBe(FORMAT_COFFRE);
    expect(lu.famille).toBe('Martin');
    expect(lu.donnees).toEqual({ family: { name: 'Martin' }, stories: [] });
  });

  it('survit à un récit qui contient « </script> »', () => {
    /*
     * La faute classique, et elle est SILENCIEUSE : le fichier s'ouvre, le
     * livre s'affiche, et seul le programme qui viendra relire les données
     * dans vingt ans découvrira qu'elles étaient tronquées depuis le début.
     */
    const piege = 'Il avait écrit </script> sur le carnet, en grand.';
    const html = coffre({ donnees: { texte: piege } });
    const lu = donneesEmbarquees(html) as { donnees: { texte: string } };
    expect(lu.donnees.texte).toBe(piege);
    expect((html.match(/<\/script>/g) ?? []).length).toBe(1);
  });

  it('porte sa propre version de format', () => {
    // Un JSON sans version, dans vingt ans, est un fichier que plus
    // personne ne sait lire. La version voyage AVEC le fichier, pas dans
    // une documentation restée sur un serveur éteint.
    expect(coffre()).toContain(FORMAT_COFFRE);
    expect(FORMAT_COFFRE).toMatch(/^heritage-coffre-\d+$/);
  });

  it('explique où sont les données, dans le fichier lui-même', () => {
    expect(coffre()).toContain('heritage-donnees');
  });
});

describe('Le coffre n’échappe pas aux règles du produit', () => {
  it('échappe le HTML des récits — un chevron n’est pas une balise', () => {
    const html = coffre({
      livre: assemblerLivre(
        [RECIT('s1', 'Le <b>carnet</b>', 'Il écrivait <script>alert(1)</script> partout.')],
        [],
        { questionsSansReponse: [], recitsSansDate: [], membresJamaisMentionnes: [] },
      ),
    });
    expect(html).toContain('&lt;b&gt;carnet&lt;/b&gt;');
    expect(html).not.toContain('<b>carnet</b>');
    expect((html.match(/<script\b/g) ?? []).length).toBe(1);
  });

  it('dit ce qu’il ne contient pas, plutôt que de le taire', () => {
    expect(coffre()).toContain('Les octets des photos restent sur le serveur.');
  });

  it('n’infère aucune émotion et ne presse personne (§12, §6.2)', () => {
    // Avec une question ouverte : sinon la section des manques n'est pas
    // rendue du tout, et le contrôle porterait sur un titre absent — vert
    // sans avoir rien regardé.
    const avecTrous = coffre({
      livre: assemblerLivre(
        [RECIT('s1', 'La montre arrêtée', 'Elle s’est arrêtée le jour de son départ.')],
        [],
        {
          questionsSansReponse: [{ texte: 'D’où venait ce vélo ?', posePar: 'Emma Martin', aPropos: null }],
          recitsSansDate: [{ titre: 'Le déménagement' }],
          membresJamaisMentionnes: [{ id: 'm9', nom: 'Lucas Martin' }],
        },
      ),
    });

    for (const phrase of [
      'Ce fichier se suffit à lui-même.',
      'Ce que ce coffre ne contient pas',
      'Les récits, par filiation',
      'Ce que personne n’a encore raconté',
      'Récits dont la date de l’événement manque',
      'Personnes qu’aucun récit ne mentionne',
    ]) {
      expect(avecTrous).toContain(phrase);
      expect(constitutionEmotionFilter(phrase)).toBe(true);
      expect(isNonCoerciveLanguage(phrase)).toBe(true);
    }

    // Et la question est imprimée avec de quoi y répondre à la main
    // (§5.2 ter, point 4 : le livre n'est pas fini).
    expect(avecTrous).toContain('D’où venait ce vélo ?');
    expect(avecTrous).toContain('class="lignes"');
  });

  it('la page qui l’offre ne fait pas porter la faute à la famille (§6.2)', () => {
    /*
     * « Vous n'avez pas fait de copie depuis 14 mois » ferait porter à la
     * famille la responsabilité d'une décision du produit — un anti-pattern
     * nommé. Le sujet de ces phrases est l'application, qui s'accuse.
     */
    // Sans retirer les commentaires, ce contrôle échouait sur le
    // commentaire qui CITE la phrase interdite pour expliquer qu'elle ne
    // sera pas écrite. L'instrument lisait sa propre explication.
    const page = readFileSync(join(process.cwd(), 'src', 'app', 'sortie', 'page.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(page).not.toMatch(/vous n’avez pas|vous n'avez pas|il est temps|pensez à|n’oubliez pas/i);
    expect(page).toContain('un serveur s’arrête');
  });
});
