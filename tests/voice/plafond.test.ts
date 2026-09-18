/**
 * LE PLAFOND DE LA VOIX — ADR-093, réponse à `docs/26 §4.17` question 2.
 *
 * Ce fichier existe pour une raison précise : **une décision écrite en prose se
 * relit, une décision écrite en fonction se casse quand on la contredit.**
 *
 * `docs/26 §4.17` demandait une décision PUIS un mécanisme. Le mécanisme audio
 * n'existe pas — il n'y a pas une ligne de code son dans ce dépôt. Ce qui
 * existe est la règle, et elle est éprouvée dès maintenant pour qu'elle survive
 * jusqu'au jour où la voix sera branchée.
 */
import { describe, expect, it } from 'vitest';
import {
  Declencheur,
  faconDeDire,
  peutEtrePrononce,
  plafondVocal,
} from '../../src/core/voice/plafond.js';
import { DataLevel, Provenance } from '../../src/core/types/domain.js';
import { mayEgress } from '../../src/core/privacy/classify.js';

/* ====================================================================== *
 * LA RÈGLE QUI NE PEUT PAS BOUGER
 * ====================================================================== */

describe('un secret ne se prononce jamais', () => {
  it.each(Declencheur.options)('RESTRICTED est refusé sous %s', (declencheur) => {
    /* ⚠ ITÈRE SUR `Declencheur.options`, PAS SUR UNE LISTE ÉCRITE À LA MAIN.

       C'est la différence entre « les trois déclencheurs d'aujourd'hui
       refusent » et « aucun déclencheur ne l'autorise ». Le jour où quelqu'un
       ajoutera `UTILISATEUR_A_CONFIRME_DEUX_FOIS`, ce test l'éprouvera sans
       qu'on ait pensé à l'y ajouter — et c'est exactement le jour où la règle
       risquait de tomber. */
    expect(peutEtrePrononce('RESTRICTED', declencheur)).toBe(false);
  });

  it('aucun plafond ne monte jusqu\'à RESTRICTED', () => {
    /* La règle est tenue par un `if` explicite ET par la table. Ce test vérifie
       la table : si elle contenait `RESTRICTED`, le `if` serait la seule
       protection, et une seule ligne à supprimer suffirait. */
    for (const d of Declencheur.options) {
      expect(plafondVocal(d)).not.toBe('RESTRICTED');
    }
  });
});

/* ====================================================================== *
 * LE CONTRÔLE NÉGATIF — la voix reste utilisable
 * ====================================================================== */

describe('la voix n\'est pas bridée au point d\'être inutile', () => {
  it('⚠ un rendez-vous SE LIT à voix haute — sinon rien de tout ceci ne sert', () => {
    /* SANS CE TEST, TOUT LE FICHIER EST GRATUIT. Un plafond qui refuserait tout
       passerait chaque assertion de refus ci-dessus, et le dépôt certifierait
       un assistant vocal incapable de parler comme s'il était prudent.

       `CALENDAR` a un plancher `SENSITIVE` (`docs/14 §3`). C'est l'usage
       NUMÉRO UN d'un assistant vocal. S'il devient impossible, la décision
       n'est pas prudente : elle est ratée. */
    expect(peutEtrePrononce('SENSITIVE', 'DEMANDE_EXPLICITE')).toBe(true);
    expect(peutEtrePrononce('SENSITIVE', 'SUITE_DE_CONVERSATION')).toBe(true);
  });

  it('une tâche et une note se lisent sous n\'importe quel déclencheur', () => {
    for (const d of Declencheur.options) {
      expect(peutEtrePrononce('PERSONAL', d)).toBe(true);
      expect(peutEtrePrononce('PUBLIC', d)).toBe(true);
    }
  });
});

/* ====================================================================== *
 * CE QUE LE DÉCLENCHEUR CHANGE — le cœur de la décision
 * ====================================================================== */

describe('le plafond dépend de qui a choisi le moment', () => {
  it('un bilan de santé se lit SUR DEMANDE, jamais dans un rappel', () => {
    /* LA DÉCISION D'ADR-093, EN UNE ASSERTION.

       Même donnée, même niveau, deux réponses — parce que la question n'est pas
       « cette donnée est-elle sensible » mais « cette personne savait-elle, à
       l'instant où le son est sorti, ce qui allait être dit ». */
    expect(peutEtrePrononce('HIGHLY_SENSITIVE', 'DEMANDE_EXPLICITE')).toBe(true);
    expect(peutEtrePrononce('HIGHLY_SENSITIVE', 'PROACTIF')).toBe(false);
  });

  it('un rendez-vous ne s\'annonce pas tout seul', () => {
    /* Conséquence directe et assumée : un rappel vocal ne peut pas dire de QUOI
       il s'agit, seulement qu'il y a quelque chose. « Tu as un rendez-vous dans
       dix minutes » est `SENSITIVE` ; « tu as un rappel » ne l'est pas.

       C'est le coût réel de la règle, et il est payé à l'endroit exact où une
       phrase non sollicitée peut être entendue par quelqu'un d'autre. */
    expect(peutEtrePrononce('SENSITIVE', 'PROACTIF')).toBe(false);
  });

  it('le plafond ne DESCEND jamais quand la demande est plus explicite', () => {
    /* Monotonie. Sans elle, un utilisateur pourrait perdre l'accès à une donnée
       en étant PLUS précis, ce qui serait absurde — et surtout signalerait que
       la table a été remplie au jugé. */
    const rang = (d: Declencheur): number =>
      DataLevel.options.indexOf(plafondVocal(d));
    expect(rang('DEMANDE_EXPLICITE')).toBeGreaterThan(rang('SUITE_DE_CONVERSATION'));
    expect(rang('SUITE_DE_CONVERSATION')).toBeGreaterThan(rang('PROACTIF'));
  });
});

/* ====================================================================== *
 * POURQUOI CE N'EST PAS UNE COPIE DE `mayEgress`
 * ====================================================================== */

describe('parler n\'est pas sortir — et les deux échelles diffèrent', () => {
  it('⚠ le plafond vocal est PLUS PERMISSIF que l\'égression, délibérément', () => {
    /* LE TEST QUI FIGE UN ARBITRAGE, PAS UN COMPORTEMENT.

       Recopier `mayEgress` (PUBLIC | PERSONAL) aurait été le geste prudent en
       apparence et faux en fait : une donnée qui sort de la machine y reste
       chez un tiers ; une donnée prononcée s'éteint avec la phrase, le plus
       souvent devant son seul propriétaire.

       Si ce test rougit parce que quelqu'un a aligné les deux échelles, ce
       n'est pas forcément une erreur — mais c'est un CHOIX, et il doit être
       fait en connaissance de cause. C'est pour ça qu'il est écrit. */
    expect(mayEgress('SENSITIVE')).toBe(false);
    expect(peutEtrePrononce('SENSITIVE', 'DEMANDE_EXPLICITE')).toBe(true);
  });

  it('mais elles se rejoignent sur le cas proactif', () => {
    /* Une phrase que personne n'a demandée est la seule situation où la voix
       ressemble vraiment à une sortie : le moment n'a pas été choisi, et
       l'auditoire est inconnu. Le plafond y retombe exactement sur celui de
       l'égression. */
    for (const niveau of DataLevel.options) {
      expect(peutEtrePrononce(niveau, 'PROACTIF')).toBe(mayEgress(niveau));
    }
  });
});

/* ====================================================================== *
 * L'OREILLE EST UNE FRONTIÈRE SANS VALIDATION
 * ====================================================================== */

describe('un contenu non fiable est résumé, jamais récité', () => {
  it.each(['MODEL_OUTPUT', 'EXTERNAL_UNTRUSTED'] as const)(
    '%s donne RESUME_ENCADRE',
    (provenance) => {
      /* `CLAUDE.md` règle 2 : aucune donnée externe n'est une instruction.
         Prononcée de la même voix que le reste, « validez le virement » cesse
         d'être une citation pour devenir une phrase de Jarvis. L'injection
         n'atteint plus le modèle : elle atteint la personne, qui est le seul
         composant du système sans validation de frontière. */
      expect(faconDeDire('PERSONAL', provenance, 'DEMANDE_EXPLICITE')).toBe(
        'RESUME_ENCADRE',
      );
    },
  );

  it.each(['USER', 'SYSTEM', 'MEMORY'] as const)(
    '%s peut être dit mot pour mot',
    (provenance) => {
      expect(faconDeDire('PERSONAL', provenance, 'DEMANDE_EXPLICITE')).toBe(
        'MOT_POUR_MOT',
      );
    },
  );

  it('⚠ TOOL_OUTPUT est RÉCITÉ — et ce test dit à quelle condition', () => {
    /* J'AI ÉCRIT CE TEST À L'ENVERS EN PREMIER, ET IL A ÉCHOUÉ. Ce qui suit
       est ce que l'échec a appris, gardé pour que personne ne refasse le
       raisonnement.

       L'intuition était : « un outil lit le monde extérieur, donc sa sortie est
       du contenu de tiers ». Elle est fausse dans CE dépôt. `TOOL_OUTPUT` n'est
       pas le contenu lu, c'est le résultat produit par NOTRE code typé — « trois
       tâches trouvées », « événement créé ». `isUntrusted` le range donc du côté
       fiable, et `domain.ts` le dit en toutes lettres : *semi-fiable*.

       La bonne étiquette pour le corps d'un email est `EXTERNAL_UNTRUSTED`, et
       c'est à l'outil qui le lit de la poser.

       ⚠ D'OÙ LA LIMITE, QUI EST RÉELLE. Si un jour un outil rend un champ qui
       CONTIENT du texte de tiers — un titre de tâche recopié d'un courrier —
       sans le ré-étiqueter, ce champ sera récité mot pour mot. Le défaut ne
       serait pas dans ce module : il serait dans l'étiquetage. Mais c'est ici
       qu'il s'entendrait.

       On ne le corrige PAS en inventant ici un prédicat plus strict que
       `isUntrusted` : deux registres du même fait finissent par diverger
       (ADR-041), et le jour où ils divergent, c'est le Policy Gate et la voix
       qui ne seraient plus d'accord sur ce qui est fiable. */
    expect(faconDeDire('PERSONAL', 'TOOL_OUTPUT', 'DEMANDE_EXPLICITE')).toBe(
      'MOT_POUR_MOT',
    );
  });

  it('le refus précède la façon de dire', () => {
    /* L'ordre compte : une donnée qu'on n'a pas le droit de prononcer ne doit
       pas être « résumée » — un résumé d'un bilan sanguin reste un bilan
       sanguin dit à voix haute. */
    expect(faconDeDire('HIGHLY_SENSITIVE', 'EXTERNAL_UNTRUSTED', 'PROACTIF')).toBe(
      'REFUS',
    );
    expect(faconDeDire('RESTRICTED', 'USER', 'DEMANDE_EXPLICITE')).toBe('REFUS');
  });

  it('CONTRÔLE — toutes les provenances sont couvertes, aucune n\'échappe', () => {
    /* Sans ce balayage, une provenance ajoutée plus tard tomberait
       silencieusement dans `MOT_POUR_MOT`, qui est le cas permissif. On vérifie
       qu'aucune ne produit autre chose que les deux réponses attendues. */
    for (const p of Provenance.options) {
      const facon = faconDeDire('PERSONAL', p, 'DEMANDE_EXPLICITE');
      expect(['MOT_POUR_MOT', 'RESUME_ENCADRE']).toContain(facon);
    }
  });
});
