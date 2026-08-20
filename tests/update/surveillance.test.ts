/**
 * UPDATE ENGINE — le rollback automatique. `docs/07 §8`, `§9`.
 *
 * Porte de sortie Phase 7 : *« Le rollback automatique se déclenche sur
 * régression d'une métrique critique. »*
 *
 * Deux propriétés opposées à tenir en même temps, et c'est tout le sujet :
 * il doit se déclencher **sans attendre un humain**, et ne PAS se déclencher
 * sur du bruit. Un rollback intempestif se paie en confiance, et un système de
 * sécurité auquel personne ne croit est un système de sécurité désactivé.
 */
import { describe, expect, it } from 'vitest';
import {
  APPELS_MINIMUM,
  surveiller,
  type Metriques,
} from '../../src/core/update/surveillance.js';

const REFERENCE: Metriques = {
  appels: 5000,
  tauxSucces: 0.9,
  tauxVerification: 0.95,
  latenceP95Ms: 900,
  coutEur: 0,
  tauxClarification: 0.12,
  erreursOutils: 3,
  tauxFausseConfirmation: 0,
};

/** Le courant, identique à la référence sauf ce qu'on dégrade. */
function courant(patch: Partial<Metriques> = {}): Metriques {
  return { ...REFERENCE, appels: 500, ...patch };
}

/* ====================================================================== *
 * LE CONTRÔLE NÉGATIF, D'ABORD
 * ====================================================================== */

describe('une version saine n\'est pas retirée', () => {
  it('ne déclenche rien quand rien ne se dégrade', () => {
    /* Sans ce test, un `surveiller` qui rendrait ROLLBACK en toutes
       circonstances passerait tous les tests de déclenchement ci-dessous. */
    expect(surveiller(REFERENCE, courant()).kind).toBe('RIEN');
  });

  it('tolère une variation faible — le bruit n\'est pas une régression', () => {
    /* 1 % de succès en moins sur un échantillon réel n'est pas un signal.
       Déclencher là-dessus rendrait le mécanisme inutilisable, donc désactivé
       — la façon la plus courante de perdre une protection. */
    expect(surveiller(REFERENCE, courant({ tauxSucces: 0.891 })).kind).toBe('RIEN');
  });

  it('une AMÉLIORATION ne déclenche jamais rien', () => {
    expect(
      surveiller(REFERENCE, courant({ tauxSucces: 0.99, latenceP95Ms: 400 })).kind,
    ).toBe('RIEN');
  });
});

/* ====================================================================== *
 * « PAS ASSEZ DE DONNÉES » N'EST PAS « TOUT VA BIEN »
 * ====================================================================== */

describe('le piège de l\'échantillon minuscule', () => {
  it('rend INSUFFISANT, jamais RIEN, sous le minimum d\'appels', () => {
    /* ⚠ LA DISTINCTION QUI COMPTE, et celle qu'on serait le plus tenté
       d'écraser : trente secondes après une promotion, le tableau de bord est
       vert parce qu'il n'y a rien dedans.

       C'est `UNKNOWN` contre `FAILED` (`docs/19`) appliqué à la surveillance :
       ne pas savoir n'est pas aller bien. */
    const v = surveiller(REFERENCE, courant({ appels: 3 }));
    expect(v.kind).toBe('INSUFFISANT');
    expect(v.kind).not.toBe('RIEN');
  });

  it('ne déclenche PAS de rollback sur trois appels dont un raté', () => {
    /* 33 % d'échec sur trois appels n'est pas une régression, c'est un
       échantillon. Retirer une version là-dessus serait aussi faux que ne rien
       faire pendant une vraie panne. */
    const v = surveiller(REFERENCE, courant({ appels: 3, tauxSucces: 0.66 }));
    expect(v.kind).toBe('INSUFFISANT');
  });

  it('bascule dès le minimum atteint', () => {
    /* Contrôle de frontière : le seuil est un choix assumé, il doit au moins
       être appliqué là où il est écrit. */
    expect(surveiller(REFERENCE, courant({ appels: APPELS_MINIMUM - 1 })).kind).toBe(
      'INSUFFISANT',
    );
    expect(surveiller(REFERENCE, courant({ appels: APPELS_MINIMUM })).kind).toBe('RIEN');
  });
});

/* ====================================================================== *
 * LES MÉTRIQUES CRITIQUES DÉCLENCHENT
 * ====================================================================== */

describe('une régression critique déclenche le rollback', () => {
  it('la fausse confirmation n\'a AUCUNE tolérance', () => {
    /* Les autres métriques décrivent une qualité et ont une marge. Celle-ci
       décrit une VÉRITÉ : Jarvis a dit « c'est fait » quand ce ne l'était pas.
       Négocier un taux acceptable reviendrait à négocier un taux de mensonge. */
    const v = surveiller(REFERENCE, courant({ tauxFausseConfirmation: 0.001 }));
    expect(v.kind).toBe('ROLLBACK');
    if (v.kind !== 'ROLLBACK') return;
    expect(v.raisons.join(' ')).toContain('aucune tolérance');
  });

  it('déclenche sur une chute du taux de VÉRIFICATION', () => {
    /* Une version qui agit autant mais prouve moins est plus dangereuse qu'une
       version qui agit moins : elle affirme sans pouvoir montrer. */
    expect(surveiller(REFERENCE, courant({ tauxVerification: 0.7 })).kind).toBe('ROLLBACK');
  });

  it('déclenche sur une chute du taux de succès', () => {
    expect(surveiller(REFERENCE, courant({ tauxSucces: 0.6 })).kind).toBe('ROLLBACK');
  });

  it('déclenche sur une envolée de la latence p95', () => {
    expect(surveiller(REFERENCE, courant({ latenceP95Ms: 4000 })).kind).toBe('ROLLBACK');
  });

  it('rend TOUTES les raisons — un diagnostic, pas une alarme', () => {
    const v = surveiller(
      REFERENCE,
      courant({ tauxSucces: 0.5, tauxVerification: 0.5, tauxFausseConfirmation: 0.02 }),
    );
    expect(v.kind).toBe('ROLLBACK');
    if (v.kind !== 'ROLLBACK') return;
    expect(v.raisons.length).toBeGreaterThanOrEqual(3);
  });
});

/* ====================================================================== *
 * CE QUI NE DÉCLENCHE PAS, ET POURQUOI C'EST DÉLIBÉRÉ
 * ====================================================================== */

describe('les métriques surveillées mais NON critiques', () => {
  it('⚠ une hausse des CLARIFICATIONS ne déclenche pas — elle peut être un progrès', () => {
    /* Le choix le plus discutable du module, donc celui qu'il faut figer.

       Une version qui pose plus de questions RESSEMBLE à une régression et
       peut être exactement l'inverse : `docs/05 §A3` interdit de deviner quand
       deux lectures diffèrent. En faire un déclencheur pousserait le système à
       préférer, version après version, celles qui devinent. */
    expect(surveiller(REFERENCE, courant({ tauxClarification: 0.4 })).kind).toBe('RIEN');
  });

  it('une hausse du COÛT ne déclenche pas — le CostGate le borne déjà', () => {
    /* Et il le borne mieux : il BLOQUE la dépense au lieu de retirer une
       version. Deux mécanismes sur le même fait finiraient par diverger
       (ADR-041) ; celui qui agit le plus tôt garde la main. */
    expect(surveiller(REFERENCE, courant({ coutEur: 50 })).kind).toBe('RIEN');
  });

  it('une hausse des ERREURS D\'OUTILS ne déclenche pas', () => {
    /* Souvent imputable au fournisseur, pas à la version. Un Google en panne
       ferait sinon retirer une version parfaitement saine — et le rollback ne
       réparerait rien. */
    expect(surveiller(REFERENCE, courant({ erreursOutils: 200 })).kind).toBe('RIEN');
  });
});

/* ====================================================================== *
 * ROBUSTESSE
 * ====================================================================== */

describe('une référence dégénérée ne fait pas dérailler la décision', () => {
  it('une référence à zéro ne produit pas de division par zéro', () => {
    const zero: Metriques = {
      ...REFERENCE,
      tauxSucces: 0,
      tauxVerification: 0,
      latenceP95Ms: 0,
    };
    const v = surveiller(zero, courant({ tauxSucces: 0, tauxVerification: 0 }));
    expect(['RIEN', 'ROLLBACK', 'INSUFFISANT']).toContain(v.kind);
  });

  it('est déterministe', () => {
    const c = courant({ tauxSucces: 0.6 });
    expect(surveiller(REFERENCE, c)).toEqual(surveiller(REFERENCE, c));
  });
});
