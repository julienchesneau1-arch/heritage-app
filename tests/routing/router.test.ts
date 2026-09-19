/**
 * LE MODEL ROUTER — ADR-102, dernier livrable de code de la Phase 4.
 *
 * DEUX PROPRIÉTÉS, ET TOUT LE RESTE EN DÉCOULE
 * ---------------------------------------------------------------------------
 *   1. **L'ordre.** Capacité → confidentialité → politique → disponibilité.
 *      Aucune étape ne peut être rattrapée par une suivante : un fournisseur
 *      écarté par la confidentialité ne revient pas parce qu'il est rapide,
 *      gratuit ou le seul en vie.
 *
 *   2. **R4 — un modèle non autorisé n'existe pas comme repli.** Quand plus
 *      rien n'est éligible, la réponse est une PHRASE, jamais une escalade.
 *      Un routeur qui essaierait le cloud « juste cette fois » faute de local
 *      transformerait une panne en fuite — et personne ne le verrait, parce
 *      que l'utilisateur aurait obtenu sa réponse.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sansCommentaires } from '../helpers/source.js';
import {
  Capacite,
  router,
  type CandidatDeRoutage,
  type DemandeDeRoutage,
} from '../../src/core/routing/router.js';
import { DataLevel } from '../../src/core/types/domain.js';
import { mayEgress } from '../../src/core/privacy/classify.js';

/**
 * La source SANS ses commentaires.
 *
 * ⚠ POURQUOI LA GARDE DEVIENT PLUS FINE PLUTÔT QUE MON TEXTE PLUS VAGUE.
 *
 * Les deux assertions de ce fichier portent sur le CODE : « le routeur
 * n'importe pas le CostGate », « aucun nom de produit n'y apparaît ». Un test
 * qui lit le fichier entier échoue dès qu'un commentaire *explique* la règle
 * en citant ce qu'elle interdit — et il force alors la documentation à devenir
 * évasive, ce qui est un mauvais échange.
 *
 * C'est la troisième fois de ce chantier qu'une garde textuelle mord sur ma
 * propre documentation (ADR-096 sur un nom de variable, ADR-098 sur une liste
 * citée). Les deux premières fois j'ai reformulé. Ici la distinction
 * commentaire / code est RÉELLE et mécanique, donc c'est la garde qui doit la
 * faire.
 *
 * ⚠ ET ELLE NE S'AFFAIBLIT PAS : un contrôle négatif, plus bas, vérifie que le
 * dépouillement laisse toujours passer un nom de produit écrit dans du code.
 */

const LOCAL: CandidatDeRoutage = {
  id: 'moteur-local',
  capacites: ['FAST_LOCAL', 'LOCAL_REASONING'],
  local: true,
  disponible: true,
  coutParMillionEur: 0,
  latenceTypiqueMs: 400,
};

const DISTANT: CandidatDeRoutage = {
  id: 'moteur-distant',
  capacites: ['FAST_LOCAL', 'LOCAL_REASONING', 'CLOUD_REASONING'],
  local: false,
  disponible: true,
  coutParMillionEur: 3,
  /* PLUS RAPIDE que le local, exprès : si le routeur triait d'abord par
     latence, il choisirait celui-ci. Le test du §« local d'abord » n'aurait
     alors aucune force. */
  latenceTypiqueMs: 120,
};

function demande(o: Partial<DemandeDeRoutage> = {}): DemandeDeRoutage {
  return {
    capacite: 'LOCAL_REASONING',
    niveauDesDonnees: 'PERSONAL',
    cloudAutorise: true,
    ...o,
  };
}

/* ====================================================================== *
 * LA PROPRIÉTÉ CENTRALE — la confidentialité prime sur tout
 * ====================================================================== */

describe('une donnée qui ne sort pas ne sort pas', () => {
  it.each(DataLevel.options)(
    '%s : un fournisseur distant n’est éligible que si le niveau l’autorise',
    (niveau) => {
      /* ⚠ BALAYAGE SUR `DataLevel.options`, et comparaison à `mayEgress` —
         la MÊME fonction que le Policy Gate.

         Écrire ici un second prédicat « à peu près équivalent » aurait produit
         deux registres de « qu'est-ce qui a le droit de sortir » (ADR-041), et
         le jour où ils divergent, c'est le plus permissif qui décide. */
      const r = router([DISTANT], demande({ niveauDesDonnees: niveau }));
      expect(r.kind === 'ROUTE', `${niveau}`).toBe(mayEgress(niveau));
    },
  );

  it('⚠ même SEUL, même DISPONIBLE, même GRATUIT — il reste écarté', () => {
    /* LE CŒUR DU FICHIER.

       C'est la situation qui produit une fuite dans tout système qui a un
       « mode dégradé » : le local est mort, le distant marche, l'utilisateur
       attend. La tentation d'envoyer « juste cette fois » est maximale, et
       elle est exactement ce que `docs/15 §R4` interdit. */
    const gratuitEtSeul: CandidatDeRoutage = {
      ...DISTANT,
      coutParMillionEur: 0,
      latenceTypiqueMs: 1,
    };
    const r = router([gratuitEtSeul], demande({ niveauDesDonnees: 'SENSITIVE' }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    expect(r.ecartes[0]?.motif).toBe('CONFIDENTIALITE');
  });

  it('⚠ la disponibilité ne RATTRAPE jamais la confidentialité', () => {
    /* Le local est en panne ; le distant est en vie. Un routeur qui
       évaluerait la disponibilité en premier écarterait le local, puis se
       retrouverait avec le distant comme « seul survivant » — et la phrase de
       refus dirait « indisponible » au lieu de « ça ne sort pas ».

       L'ordre n'est donc pas une question de style : il détermine ce que
       l'utilisateur CROIT. */
    const localMort: CandidatDeRoutage = { ...LOCAL, disponible: false };
    const r = router([localMort, DISTANT], demande({ niveauDesDonnees: 'HIGHLY_SENSITIVE' }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    const motifs = Object.fromEntries(r.ecartes.map((e) => [e.id, e.motif]));
    expect(motifs['moteur-distant']).toBe('CONFIDENTIALITE');
    expect(motifs['moteur-local']).toBe('INDISPONIBLE');
  });
});

/* ====================================================================== *
 * R4 — LE REFUS EST UNE PHRASE, PAS UNE ESCALADE
 * ====================================================================== */

describe('un modèle non autorisé n’existe pas comme repli', () => {
  it('le refus DIT ce qui a bloqué, et que ce n’est pas une panne', () => {
    /* « Aucun fournisseur disponible » ferait réessayer l'utilisateur
       indéfiniment. La vraie raison — une décision — lui dit que réessayer ne
       changera rien. */
    const r = router([DISTANT], demande({ niveauDesDonnees: 'RESTRICTED' }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    expect(r.raison).toContain('RESTRICTED');
    expect(r.raison).toContain('pas une panne');
  });

  it('le cloud DÉSACTIVÉ produit sa propre phrase, actionnable', () => {
    /* Ce refus-ci se résout : l'utilisateur peut activer le cloud. Le dire
       change la réponse de « impossible » à « pas encore ». */
    const r = router([DISTANT], demande({ cloudAutorise: false }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    expect(r.ecartes[0]?.motif).toBe('POLITIQUE');
    expect(r.raison).toContain('désactivé');
  });

  it('aucun moteur ne SAIT faire — et on le dit sans inventer une autre raison', () => {
    const r = router([LOCAL], demande({ capacite: 'VISION_CLOUD' }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    expect(r.ecartes[0]?.motif).toBe('CAPACITE_ABSENTE');
    expect(r.raison).toContain('VISION_CLOUD');
  });

  it('⚠ UN SEUL motif par candidat — le PREMIER', () => {
    /* Accumuler les motifs laisserait croire qu'un fournisseur écarté par la
       confidentialité l'est « aussi » par la politique — donc qu'en activant
       le cloud on le récupère. On ne le récupère pas. */
    const r = router([DISTANT], demande({ niveauDesDonnees: 'SENSITIVE', cloudAutorise: false }));
    expect(r.kind).toBe('REFUS');
    if (r.kind !== 'REFUS') return;
    expect(r.ecartes).toHaveLength(1);
    expect(r.ecartes[0]?.motif).toBe('CONFIDENTIALITE');
  });
});

/* ====================================================================== *
 * LE CONTRÔLE NÉGATIF — le routeur route vraiment
 * ====================================================================== */

describe('le routeur n’est pas un refus déguisé', () => {
  it('⚠ SANS CE TEST, TOUT CE QUI PRÉCÈDE EST GRATUIT', () => {
    /* Un routeur qui refuserait TOUT passerait chaque assertion de refus
       ci-dessus — et le dépôt certifierait un système incapable de router
       comme s'il était prudent. */
    const r = router([LOCAL, DISTANT], demande());
    expect(r.kind).toBe('ROUTE');
    if (r.kind !== 'ROUTE') return;
    expect(r.fournisseur.id).toBe('moteur-local');
  });

  it('⚠ le LOCAL passe devant, même quand le distant est trois fois plus rapide', () => {
    /* `docs/04 §11` : « le pourcentage local augmente continûment ». C'est une
       préférence de PRINCIPE, pas une conséquence du prix — d'où un tri qui ne
       regarde le coût nulle part. Le distant de ce fichier est volontairement
       plus rapide que le local. */
    const r = router([DISTANT, LOCAL], demande());
    expect(r.kind).toBe('ROUTE');
    if (r.kind !== 'ROUTE') return;
    expect(r.fournisseur.local).toBe(true);
    expect(r.raison).toContain('rien ne sort');
  });

  it('entre deux LOCAUX, le plus rapide gagne', () => {
    const lent: CandidatDeRoutage = { ...LOCAL, id: 'local-lent', latenceTypiqueMs: 900 };
    const vif: CandidatDeRoutage = { ...LOCAL, id: 'local-vif', latenceTypiqueMs: 80 };
    const r = router([lent, vif], demande());
    expect(r.kind).toBe('ROUTE');
    if (r.kind !== 'ROUTE') return;
    expect(r.fournisseur.id).toBe('local-vif');
  });

  it('le distant passe quand AUCUN local ne sert la capacité', () => {
    const r = router([LOCAL, DISTANT], demande({ capacite: 'CLOUD_REASONING' }));
    expect(r.kind).toBe('ROUTE');
    if (r.kind !== 'ROUTE') return;
    expect(r.fournisseur.id).toBe('moteur-distant');
    expect(r.allowance).toBe('LOCAL_OR_CLOUD');
  });
});

/* ====================================================================== *
 * LA FRONTIÈRE AVEC LE COSTGATE — un seul registre
 * ====================================================================== */

describe('le routeur tranche, le CostGate compte', () => {
  it('un choix LOCAL rend `LOCAL_ONLY` — le coût n’a rien à arbitrer', () => {
    /* `docs/04 §10` : « le coût ne rouvre jamais ce que la politique a
       tranché ». Le routeur transmet donc l'allowance DÉJÀ décidée, au lieu de
       laisser le CostGate redécider — ce qui serait un second registre de la
       même question. */
    const r = router([LOCAL], demande());
    expect(r.kind).toBe('ROUTE');
    if (r.kind !== 'ROUTE') return;
    expect(r.allowance).toBe('LOCAL_ONLY');
  });

  it('⚠ le routeur ne calcule AUCUN budget', () => {
    /* La garde par l'absence. Le jour où ce module importerait le CostGate, il
       y aurait deux endroits qui décident du budget — et le jour où ils
       divergent, aucun ne fait autorité (ADR-041). */
    const src = sansCommentaires(readFileSync('src/core/routing/router.ts', 'utf8'));
    for (const interdit of ['cost/gate', 'CostGate', 'Micros']) {
      expect(src, `le routeur ne doit pas connaître « ${interdit} »`).not.toContain(interdit);
    }
  });
});

/* ====================================================================== *
 * SEPT CAPACITÉS, ZÉRO NOM DE PRODUIT
 * ====================================================================== */

/** Les marques qu'aucun fichier du noyau ne doit nommer — `docs/15 §2`. */
const MARQUES = ['gpt-', 'claude-', 'llama', 'mistral', 'qwen', 'gemini', 'openai'] as const;

describe('le noyau ne connaît aucun modèle', () => {
  it('les sept capacités de `docs/15 §2`, ni plus ni moins', () => {
    expect(Capacite.options).toHaveLength(7);
  });

  it('⚠ AUCUN nom de produit dans le routeur — `docs/15 §2`', () => {
    /* « Aucune chaîne gpt-…, claude-… ou llama… ne doit apparaître hors de
       src/providers/. » Le routeur est le fichier où la tentation est la plus
       forte : c'est lui qui choisit, et un cas particulier par modèle y
       paraîtrait naturel.

       Le jour où un nom de produit y entre, le noyau connaît un catalogue de
       modèles — et le mandat nomme exactement ce piège : « 17 modèles +
       42 routes + benchmark permanent ». */
    const src = sansCommentaires(
      readFileSync('src/core/routing/router.ts', 'utf8'),
    ).toLowerCase();
    for (const marque of MARQUES) {
      expect(src, `« ${marque} » ne doit pas apparaître dans le routeur`).not.toContain(marque);
    }
  });

  it('CONTRÔLE — le dépouillement laisse passer un nom de produit DANS DU CODE', () => {
    /* ⚠ SANS CE TEST, `sansCommentaires` pourrait tout dépouiller et les deux
       assertions ci-dessus passeraient sur du vide.

       On lui donne du code qui contient ce qu'on interdit, dans les deux
       formes qui comptent : une constante, et un import. */
    const faux = [
      '/* un commentaire qui cite gpt-4 sans conséquence */',
      '// et une ligne qui parle de claude-3',
      "const MODELE = 'gpt-4-turbo';",
      "import { x } from '../cost/gate.js';",
    ].join('\n');
    const nu = sansCommentaires(faux);

    expect(nu, 'le commentaire doit avoir disparu').not.toContain('sans conséquence');
    expect(nu, 'le commentaire en ligne doit avoir disparu').not.toContain('claude-3');
    expect(nu.toLowerCase(), 'le CODE doit rester lisible').toContain('gpt-4-turbo');
    expect(nu, 'un import réel doit rester visible').toContain('cost/gate');
  });
});
