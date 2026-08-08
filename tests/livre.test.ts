import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assemblerLivre,
  compterImprimes,
  dateDe,
  provenanceDe,
  type LienDeFiliation,
  type RecitDuLivre,
} from '@/lib/livre';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

/**
 * LE LIVRE — Annexe A points 1 et 7.
 *
 * Le seul objet du produit qui serve à la fois la primitive (une histoire
 * en engendre une autre) et la dispensabilité (la famille continue sans
 * l'app). Ces tests tiennent les quatre traits par lesquels il quitte le
 * genre du livre de mémoire ordinaire.
 */

const VIDE = { questionsSansReponse: [], recitsSansDate: [], membresJamaisMentionnes: [] };

function recit(id: string, titre: string, jour: number, extra: Partial<RecitDuLivre> = {}): RecitDuLivre {
  return {
    id,
    titre,
    contenu: 'Texte.',
    createdAt: new Date(2024, 0, jour),
    eventDate: null,
    structureType: 'evenement-marquant',
    auteur: { id: 'claire', nom: 'Claire Martin', anonymise: false },
    narrateur: null,
    ...extra,
  };
}

describe('Par filiation, pas par année', () => {
  const recits = [
    recit('a', 'La montre', 1),
    recit('b', 'La naissance d’Emma', 5),
    recit('c', 'Le buffet', 3),
    recit('d', 'Le déménagement', 2),
  ];
  // « La montre » a engendré « La naissance » puis « Le buffet ».
  const liens: LienDeFiliation[] = [
    { parentStoryId: 'a', childStoryId: 'b' },
    { parentStoryId: 'a', childStoryId: 'c' },
  ];

  it('range sous chaque récit ceux qu’il a engendrés', () => {
    const livre = assemblerLivre(recits, liens, VIDE);
    const montre = livre.branches.find((b) => b.recit.id === 'a')!;
    expect(montre.nes.map((n) => n.recit.id)).toEqual(['c', 'b']); // chronologique
  });

  it('ne fait racines que les récits nés de rien', () => {
    const livre = assemblerLivre(recits, liens, VIDE);
    expect(livre.branches.map((b) => b.recit.id)).toEqual(['a', 'd']);
  });

  it('garde l’ordre chronologique à chaque niveau (amendement 5)', () => {
    // La filiation vient des Passage que la famille a créés, pas d'un
    // classement du produit. À l'intérieur d'un niveau, l'ordre reste celui
    // du temps.
    const livre = assemblerLivre(recits, liens, VIDE);
    const dates = livre.branches.map((b) => b.recit.createdAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('n’imprime jamais deux fois le même récit', () => {
    const livre = assemblerLivre(recits, [...liens, { parentStoryId: 'd', childStoryId: 'b' }], VIDE);
    expect(compterImprimes(livre.branches)).toBe(4);
  });

  it('n’oublie aucun récit, même pris dans un cycle', () => {
    // Deux récits qui se réclament l'un de l'autre n'ont pas de racine.
    // Un livre qui les perdrait serait le pire des manquements.
    const boucle: LienDeFiliation[] = [
      { parentStoryId: 'a', childStoryId: 'b' },
      { parentStoryId: 'b', childStoryId: 'a' },
    ];
    const livre = assemblerLivre([recits[0]!, recits[1]!], boucle, VIDE);
    expect(compterImprimes(livre.branches)).toBe(2);
  });

  it('ne boucle pas à l’infini sur ce cycle', () => {
    const boucle: LienDeFiliation[] = [
      { parentStoryId: 'a', childStoryId: 'b' },
      { parentStoryId: 'b', childStoryId: 'a' },
    ];
    const debut = Date.now();
    assemblerLivre([recits[0]!, recits[1]!], boucle, VIDE);
    expect(Date.now() - debut).toBeLessThan(500);
  });

  it('ignore un lien vers un récit absent — archivé, supprimé', () => {
    const livre = assemblerLivre(recits, [{ parentStoryId: 'a', childStoryId: 'fantome' }], VIDE);
    expect(compterImprimes(livre.branches)).toBe(4);
  });
});

describe('Deux noms par récit : la voix, puis la plume', () => {
  it('crédite le narrateur avant le scribe', () => {
    const dicte = recit('x', 'La montre', 1, {
      narrateur: { id: 'jeanne', nom: 'Jeanne Martin' },
    });
    expect(provenanceDe(dicte)).toBe('Raconté par Jeanne Martin, noté par Claire Martin');
  });

  it('ne dédouble pas quand c’est la même personne', () => {
    const seul = recit('x', 'La montre', 1, {
      narrateur: { id: 'claire', nom: 'Claire Martin' },
    });
    expect(provenanceDe(seul)).toBe('Raconté et noté par Claire Martin');
  });

  it('respecte l’anonymisation d’un membre retiré (§2.1 règle 1)', () => {
    const anonyme = recit('x', 'La montre', 1, {
      auteur: { id: 'claire', nom: 'Claire Martin', anonymise: true },
    });
    expect(provenanceDe(anonyme)).toContain('un auteur anonymisé');
    expect(provenanceDe(anonyme)).not.toContain('Claire');
  });
});

describe('Il dit ce qu’il ne sait pas (amendement 6, en papier)', () => {
  it('n’imprime jamais la date de saisie à la place de celle de l’événement', () => {
    // Un récit saisi en 2026 sur un déménagement de 1971 ne porte pas
    // « 2026 » : il porte le silence, et il figure parmi les trous.
    expect(dateDe(recit('x', 'Le déménagement', 1))).toBeNull();
  });

  it('imprime la date de l’événement quand elle existe', () => {
    const date = dateDe(recit('x', 'Le déménagement', 1, { eventDate: new Date(1971, 10, 3) }));
    expect(date).toContain('1971');
    expect(date).toContain('novembre');
  });

  it('porte les trous jusqu’au livre assemblé', () => {
    const livre = assemblerLivre([recit('a', 'La montre', 1)], [], {
      questionsSansReponse: [{ texte: 'D’où venait ce vélo ?', posePar: 'Emma', aPropos: 'Les vélos' }],
      recitsSansDate: [{ titre: 'La montre' }],
      membresJamaisMentionnes: [{ id: 'lucas', nom: 'Lucas Martin' }],
    });
    expect(livre.trous.questionsSansReponse).toHaveLength(1);
    expect(livre.trous.membresJamaisMentionnes[0]!.nom).toBe('Lucas Martin');
  });

  it('donne de quoi vérifier qu’aucun récit n’a été perdu', () => {
    const livre = assemblerLivre([recit('a', 'A', 1), recit('b', 'B', 2)], [], VIDE);
    expect(livre.compte.recits).toBe(2);
    expect(compterImprimes(livre.branches)).toBe(livre.compte.recits);
  });
});

describe('La page du livre respecte la Constitution', () => {
  /*
   * Le rassemblement des données a quitté la page pour
   * `src/services/livre.service.ts`, que le coffre partage. Ce qui relève
   * de la PAGE — ne pas ramener vers l'écran, énoncer les manques en
   * constats — se lit toujours dans la page ; ce qui relève de la
   * SÉLECTION se lit désormais dans le service, et vaut alors pour les
   * deux sorties.
   */
  const source =
    readFileSync(join(process.cwd(), 'src', 'app', 'livre', 'page.tsx'), 'utf8') +
    readFileSync(join(process.cwd(), 'src', 'services', 'livre.service.ts'), 'utf8');
  const sansCommentaires = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('ne ramène jamais vers l’écran (point 7)', () => {
    // Un QR code ou une adresse imprimée ferait du livre un dépliant
    // publicitaire pour l'application. Le point 7 dit « sans l'app ».
    expect(sansCommentaires).not.toMatch(/QR|qrcode|<Link|href=/i);
  });

  it('énonce les manques en constats, jamais en reproches (§6.2)', () => {
    for (const phrase of [
      'Ce que ce livre ne dit pas',
      'Questions restées sans réponse',
      'Récits dont on ignore la date',
      'Personnes qu’aucun récit ne mentionne',
      'Date de l’événement non renseignée.',
    ]) {
      expect(sansCommentaires).toContain(phrase);
      expect(constitutionEmotionFilter(phrase)).toBe(true);
      expect(isNonCoerciveLanguage(phrase)).toBe(true);
    }
    expect(sansCommentaires).not.toMatch(/vous n[’']avez|il y a longtemps que|pensez à/i);
  });

  it('n’est pas un objet fini : les questions ont de la place pour écrire', () => {
    expect(sansCommentaires).toContain('lignes');
    const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    expect(css).toContain('.livre .lignes span');
  });

  it('exclut de l’impression ce que la famille a retiré de sa vue', () => {
    // Archivés et quarantaine restent dans l'app et dans l'export
    // (amendement 3), mais le livre est ce que la famille assume.
    expect(sansCommentaires).toContain('archived: false, quarantined: false');
  });

  it('ne borne pas le livre : une sortie incomplète ne libère personne', () => {
    // Partout ailleurs le produit limite ce qu'il montre (§6.1). Ici, non.
    const requeteRecits = sansCommentaires.slice(
      sansCommentaires.indexOf('prisma.story.findMany'),
      sansCommentaires.indexOf('prisma.passage.findMany'),
    );
    expect(requeteRecits).not.toContain('take:');
  });
});
