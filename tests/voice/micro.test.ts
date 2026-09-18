/**
 * LE TÉMOIN NE PEUT PAS MENTIR — ADR-093, `docs/26 §4.17` question 1.
 *
 * Il n'y a pas une ligne de code audio dans ce dépôt. Ce fichier n'éprouve donc
 * pas un micro : il éprouve un **type**, et la propriété qu'on lui demande de
 * rendre impossible.
 *
 *     un micro ouvert avec la lumière éteinte
 *
 * C'est la seule chose qui compte ici, et c'est un problème de modélisation
 * avant d'être un problème de matériel.
 */
import { describe, expect, it } from 'vitest';
import { EtatMicro, Temoin, capte, sortDuTampon, temoin } from '../../src/core/voice/micro.js';

describe('le témoin est dérivé de l\'état, pas posé à côté', () => {
  it.each(EtatMicro.options)(
    '⚠ %s : le témoin est éteint SI ET SEULEMENT SI rien n\'est capté',
    (etat) => {
      /* L'INVARIANT, ET IL EST BICONDITIONNEL.

         Le sens qui protège : capter avec la lumière éteinte est le défaut
         qu'on ferme. L'autre sens compte aussi — une lumière allumée sans
         capture apprendrait à l'utilisateur à ignorer le témoin, et un témoin
         qu'on ignore ne protège plus personne.

         Ce test balaye `EtatMicro.options` : un état ajouté plus tard y passe
         sans qu'on ait pensé à l'y ajouter. C'est le jour de cet ajout que la
         règle risquait de tomber. */
      expect(temoin(etat) === 'ETEINT').toBe(!capte(etat));
    },
  );

  it('les trois états donnent trois témoins distincts', () => {
    /* ⚠ SANS CE TEST, L'INVARIANT CI-DESSUS EST SATISFAIT PAR UN TÉMOIN QUI
       SERAIT TOUJOURS `ACTIF` dès que ça capte — ce qui effacerait la
       distinction entre « ça guette un mot » et « ça t'enregistre ».

       Les deux sont des captures, et elles ne méritent pas le même signal. */
    const vus = new Set(EtatMicro.options.map(temoin));
    expect(vus.size).toBe(EtatMicro.options.length);
    expect(vus).toEqual(new Set(Temoin.options));
  });

  it('⚠ VEILLE n\'est PAS ÉTEINT — c\'est toute la décision', () => {
    /* Le langage courant appelle « éteint » un micro qui écoute un mot
       d'activation, puisque rien n'est enregistré. Le matériel, lui, capte.

       Si ce test rougit parce que `ECOUTE_MOT_CLE` donne `ETEINT`, la réponse
       à « qui d'autre est dans la pièce » a été annulée sans que personne n'ait
       eu à toucher à une règle de sécurité : il aura suffi de trouver la
       lumière de veille agaçante. */
    expect(temoin('ECOUTE_MOT_CLE')).not.toBe('ETEINT');
    expect(capte('ECOUTE_MOT_CLE')).toBe(true);
  });
});

describe('rien ne sort du tampon avant le mot d\'activation', () => {
  it('seul TRANSCRIT laisse l\'audio franchir la frontière', () => {
    expect(sortDuTampon('FERME')).toBe(false);
    expect(sortDuTampon('ECOUTE_MOT_CLE')).toBe(false);
    expect(sortDuTampon('TRANSCRIT')).toBe(true);
  });

  it('ce qui sort du tampon capte forcément — l\'inverse est faux', () => {
    /* Une implication, pas une équivalence. `ECOUTE_MOT_CLE` capte sans rien
       laisser sortir : c'est précisément l'état qui distingue « un micro
       ouvert » de « un micro qui enregistre », et le confondre avec l'un ou
       l'autre ferait perdre la moitié du sujet. */
    for (const etat of EtatMicro.options) {
      if (sortDuTampon(etat)) expect(capte(etat)).toBe(true);
    }
    expect(capte('ECOUTE_MOT_CLE') && !sortDuTampon('ECOUTE_MOT_CLE')).toBe(true);
  });
});

describe('il n\'existe aucun moyen d\'allumer le témoin séparément', () => {
  it('le module n\'exporte que des LECTURES de l\'état', async () => {
    /* ⚠ LE TEST QUI ÉPROUVE UNE ABSENCE, ET POURQUOI IL EST ÉCRIT AINSI.

       Tout ce qui précède serait vrai et sans effet si le module exportait
       aussi un `allumerTemoin()`. La garantie ne vient pas de ce que les
       fonctions rendent, elle vient de ce qui N'EXISTE PAS.

       On liste donc les exports et on exige qu'aucun ne soit un mutateur. Un
       `setTemoin` ajouté demain fait rougir ce test — c'est la seule façon de
       protéger une propriété qui repose sur une absence.

       Même geste que pour `Secret` : la sûreté vient de ce que la classe ne
       peut pas faire, pas de ce qu'elle promet. */
    const module = await import('../../src/core/voice/micro.js');
    const fonctions = Object.keys(module).filter(
      (k) => typeof (module as Record<string, unknown>)[k] === 'function',
    );
    expect(new Set(fonctions)).toEqual(new Set(['temoin', 'capte', 'sortDuTampon']));
  });
});
