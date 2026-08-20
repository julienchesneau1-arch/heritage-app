/**
 * UPDATE ENGINE — une mise à jour défectueuse n'atteint jamais la production.
 * `docs/07`, porte de sortie Phase 7.
 *
 * `CLAUDE.md` règle 5. Ce fichier éprouve la moitié DÉCISION du pipeline —
 * la seule qui existe (voir `candidat.ts`).
 *
 * Ce qu'il cherche n'est pas « la bonne version passe » : c'est **qu'aucun
 * chemin ne laisse passer une mauvaise version**. Un moteur de promotion qui
 * refuse tout serait sûr et inutile ; un contrôle négatif garde donc chaque
 * refus honnête.
 */
import { describe, expect, it } from 'vitest';
import { deciderPromotion } from '../../src/core/update/promotion.js';
import type { Candidat, Mesures } from '../../src/core/update/candidat.js';

/** Des mesures IRRÉPROCHABLES. Chaque test n'en dégrade qu'une. */
const PARFAITES: Mesures = {
  testsCritiques: 1,
  testsSecurite: 1,
  testsPolitique: 1,
  regressions: 0,
  qualite: 0.92,
  qualiteReference: 0.9,
  latenceMs: 800,
  latenceSeuilMs: 1200,
  integriteMemoire: true,
  fausseConfirmation: 0,
};

function candidat(o: Partial<Candidat> = {}): Candidat {
  return {
    version: '1.2.3',
    canal: 'STABLE',
    signature: 'VERIFIEE',
    portees: ['DEPENDANCE'],
    mesures: PARFAITES,
    ...o,
  };
}

/* ====================================================================== *
 * LE CONTRÔLE NÉGATIF — sans lui, tout ce qui suit est gratuit
 * ====================================================================== */

describe('une version irréprochable EST promue', () => {
  it('promeut quand tout est vert', () => {
    /* ⚠ CE TEST GARDE TOUS LES AUTRES.

       Un `deciderPromotion` qui rendrait `REFUSER` en toutes circonstances
       passerait chacun des tests de refus ci-dessous. C'est celui-ci, et lui
       seul, qui rend leur verdict informatif. */
    expect(deciderPromotion(candidat()).kind).toBe('PROMOUVOIR');
  });

  it('SECURITY est traité comme STABLE — l\'urgence ne raccourcit pas le pipeline', () => {
    /* `docs/07 §10` : « L'urgence d'un correctif de sécurité raccourcit les
       délais, jamais le pipeline. » Le canal SECURITY passe donc s'il remplit
       les critères — et le test suivant vérifie qu'il ne passe pas sinon. */
    expect(
      deciderPromotion(candidat({ canal: 'SECURITY', portees: ['CORRECTIF_SECURITE'] })).kind,
    ).toBe('PROMOUVOIR');
  });
});

/* ====================================================================== *
 * 1. LA SIGNATURE — `docs/07 §4`
 * ====================================================================== */

describe('une signature non VÉRIFIÉE refuse, sans exception', () => {
  it.each(['INVALIDE', 'ABSENTE', 'NON_VERIFIABLE'] as const)(
    'refuse une signature %s',
    (signature) => {
      const v = deciderPromotion(candidat({ signature }));
      expect(v.kind).toBe('REFUSER');
    },
  );

  it('les trois motifs se RACONTENT différemment', () => {
    /* « Signature invalide » appelle une alerte ; « vérificateur injoignable »
       appelle un réessai. Les confondre ferait traiter une attaque comme une
       panne de réseau — ou l'inverse, ce qui est pire. */
    const dire = (s: Candidat['signature']): string => {
      const v = deciderPromotion(candidat({ signature: s }));
      return v.kind === 'REFUSER' ? v.raisons.join(' ') : '';
    };
    expect(dire('INVALIDE')).toContain('INVALIDE');
    expect(dire('ABSENTE')).toContain('aucune signature');
    expect(dire('NON_VERIFIABLE')).toContain('non vérifiable');
  });

  it('AUCUNE urgence de sécurité ne rachète une signature absente', () => {
    /* Le cas où la tentation est maximale : une faille connue, un correctif
       disponible, et pas de signature. `docs/07 §4` ne prévoit aucun mode
       dégradé — et c'est facile à clouer aujourd'hui, beaucoup moins le jour
       où ça arrivera. */
    const v = deciderPromotion(
      candidat({ canal: 'SECURITY', signature: 'ABSENTE', portees: ['CORRECTIF_SECURITE'] }),
    );
    expect(v.kind).toBe('REFUSER');
  });
});

/* ====================================================================== *
 * 2. LES CANAUX — `docs/07 §10`
 * ====================================================================== */

describe('les canaux de LAB n\'atteignent jamais la production', () => {
  it.each(['BETA', 'EXPERIMENTAL'] as const)('refuse le canal %s', (canal) => {
    const v = deciderPromotion(candidat({ canal }));
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.join(' ')).toContain(canal);
  });
});

/* ====================================================================== *
 * 3. PAS DE LAB, PAS DE PROMOTION — `docs/07 §1`
 * ====================================================================== */

describe('l\'absence de mesure n\'est pas une absence de problème', () => {
  it('refuse une version qui n\'a traversé aucune étape', () => {
    /* `mesures: null` ne dit pas « rien à signaler » : il dit que personne n'a
       regardé. Le traiter comme un succès serait la réussite non vérifiée que
       `CLAUDE.md` règle 3 interdit — appliquée au pipeline lui-même. */
    const v = deciderPromotion(candidat({ mesures: null }));
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.join(' ')).toContain('aucune mesure');
  });
});

/* ====================================================================== *
 * 4. LES HUIT CRITÈRES — `docs/07 §6`
 * ====================================================================== */

describe('un seuil manqué n\'est jamais « acceptable pour cette fois »', () => {
  const degrade = (patch: Partial<Mesures>): ReturnType<typeof deciderPromotion> =>
    deciderPromotion(candidat({ mesures: { ...PARFAITES, ...patch } }));

  it('refuse 99,9 % de tests de sécurité', () => {
    /* Il n'y a pas d'arrondi : « 99,9 % » signifie qu'un test de sécurité
       échoue, et le document exige 100 %. */
    const v = degrade({ testsSecurite: 0.999 });
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.join(' ')).toContain('sécurité');
  });

  it.each([
    ['tests critiques', { testsCritiques: 0.98 }],
    ['tests de politique', { testsPolitique: 0.5 }],
    ['une régression', { regressions: 1 }],
    ['qualité sous la référence', { qualite: 0.89, qualiteReference: 0.9 }],
    ['latence au-dessus du seuil', { latenceMs: 1300, latenceSeuilMs: 1200 }],
    ['intégrité mémoire fausse', { integriteMemoire: false }],
  ])('refuse : %s', (_libelle, patch) => {
    expect(degrade(patch).kind).toBe('REFUSER');
  });

  it('UNE SEULE fausse confirmation suffit à refuser', () => {
    /* Le critère le plus sévère du document, et il le mérite : c'est le seul
       défaut qui fait MENTIR Jarvis sans qu'il le sache. Ce n'est pas une
       métrique qu'on optimise, c'est une propriété qu'on a ou pas. */
    const v = degrade({ fausseConfirmation: 1 });
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.join(' ')).toContain('fausse');
  });

  it('rend TOUTES les raisons, pas la première', () => {
    /* Un pipeline qui s'arrête au premier défaut fait corriger une version en
       autant d'allers-retours qu'elle a de problèmes. */
    const v = degrade({ regressions: 2, integriteMemoire: false, fausseConfirmation: 1 });
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.length).toBeGreaterThanOrEqual(3);
  });
});

/* ====================================================================== *
 * 5. LA PORTÉE — `docs/07 §3`
 * ====================================================================== */

describe('ce qui touche §3 exige un humain, même tout vert', () => {
  it.each([
    'POLITIQUE_SECURITE',
    'MODELE_PERMISSIONS',
    'MIGRATION_BASE',
    'SEMANTIQUE_OUTIL',
    'ROUTAGE_MODELE',
    'EFFET_EXTERNE',
  ] as const)('%s → décision humaine', (portee) => {
    const v = deciderPromotion(candidat({ portees: [portee] }));
    expect(v.kind).toBe('DECISION_HUMAINE_REQUISE');
  });

  it('DECISION_HUMAINE_REQUISE n\'est NI un oui NI un non', () => {
    /* La confondre avec `PROMOUVOIR` donnerait au système le droit de modifier
       ses propres politiques de sécurité. La confondre avec `REFUSER` rendrait
       ces politiques immuables — donc incorrigibles. */
    const v = deciderPromotion(candidat({ portees: ['POLITIQUE_SECURITE'] }));
    expect(v.kind).not.toBe('PROMOUVOIR');
    expect(v.kind).not.toBe('REFUSER');
  });

  it('⚠ UN DÉFAUT REFUSE AVANT QU\'ON DÉRANGE L\'HUMAIN — l\'ordre est la propriété', () => {
    /* Le point central du module. Une version qui touche une politique de
       sécurité ET échoue aux tests doit être REFUSÉE, pas soumise à
       signature : demander à Julien d'approuver une version défectueuse
       reviendrait à lui faire couvrir un défaut que la machine a déjà vu. */
    const v = deciderPromotion(
      candidat({
        portees: ['POLITIQUE_SECURITE'],
        mesures: { ...PARFAITES, testsSecurite: 0.9 },
      }),
    );
    expect(v.kind).toBe('REFUSER');
  });

  it('une portée mêlée : une seule sensible suffit', () => {
    const v = deciderPromotion(candidat({ portees: ['DEPENDANCE', 'MIGRATION_BASE'] }));
    expect(v.kind).toBe('DECISION_HUMAINE_REQUISE');
  });
});

/* ====================================================================== *
 * LE MOTEUR NE PEUT QUE RESTREINDRE
 * ====================================================================== */

describe('aucun chemin ne transforme un refus en promotion', () => {
  it('la mise à jour volontairement défectueuse de la porte de sortie', () => {
    /* `docs/02`, porte Phase 7 : « Une mise à jour volontairement défectueuse
       est bloquée avant la production. » La voici, cumulant tout ce qu'une
       mise à jour hostile aurait de plausible. */
    const defectueuse: Candidat = {
      version: '9.9.9',
      canal: 'SECURITY',
      signature: 'ABSENTE',
      portees: ['POLITIQUE_SECURITE', 'MODELE_PERMISSIONS'],
      mesures: {
        ...PARFAITES,
        testsSecurite: 0.5,
        fausseConfirmation: 3,
        integriteMemoire: false,
      },
    };
    const v = deciderPromotion(defectueuse);
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    // Elle échoue pour plusieurs raisons indépendantes, et chacune suffirait.
    expect(v.raisons.length).toBeGreaterThanOrEqual(4);
  });

  it('est déterministe — deux fois la même entrée, deux fois le même verdict', () => {
    /* Une décision de promotion non déterministe rendrait tout audit impossible :
       « pourquoi cette version est-elle passée ? » n'aurait pas de réponse. */
    const c = candidat({ portees: ['ADAPTATEUR'] });
    expect(deciderPromotion(c)).toEqual(deciderPromotion(c));
  });
});

/* ====================================================================== *
 * L'INVARIANT S11 — `docs/03`
 *
 * ⚠ IL ÉTAIT EXEMPTÉ, ET L'EXEMPTION S'EST AUTODÉTRUITE.
 *
 * `invariants-contract.test.ts` déclarait S11 « non exigible » avec ce motif :
 * *« Update Engine — docs/07 est spécifié, aucun module canary/rollback/twin
 * n'existe »*, et une garde : `absent: 'src/core/update'`.
 *
 * Créer ce répertoire a fait rougir la garde le jour même, sans que personne
 * ait eu à s'en souvenir. C'est exactement ce qu'on attend d'une dette
 * déclarée — et la différence avec un commentaire.
 *
 * S11 sort donc de la liste des exemptions et entre dans celle des invariants
 * NOMMÉS. Le compte passe de neuf à dix.
 * ====================================================================== */

describe('S11 — une mise à jour en production exige des tests de non-régression', () => {
  it('une régression observée interdit la promotion', () => {
    /* La lecture littérale de l'invariant : des tests de non-régression ont
       tourné, ils ont trouvé quelque chose, la version ne passe pas. */
    const v = deciderPromotion(
      candidat({ mesures: { ...PARFAITES, regressions: 1 } }),
    );
    expect(v.kind).toBe('REFUSER');
    if (v.kind !== 'REFUSER') return;
    expect(v.raisons.join(' ')).toContain('régression');
  });

  it('⚠ et l\'ABSENCE de tests interdit la promotion tout autant', () => {
    /* La moitié qu'on oublie, et la plus dangereuse. « Exige des tests de
       non-régression » ne veut pas dire « exige qu'aucune régression ne soit
       rapportée » : une version qui n'a été testée par personne ne rapporte
       aucune régression non plus.

       Zéro régression mesurée et zéro régression cherchée produisent le même
       chiffre. Seul `mesures === null` les distingue. */
    const v = deciderPromotion(candidat({ mesures: null }));
    expect(v.kind).toBe('REFUSER');
  });

  it('S11 ne dépend pas du canal — même un correctif de sécurité y est soumis', () => {
    const v = deciderPromotion(
      candidat({
        canal: 'SECURITY',
        portees: ['CORRECTIF_SECURITE'],
        mesures: { ...PARFAITES, regressions: 2 },
      }),
    );
    expect(v.kind).toBe('REFUSER');
  });
});
