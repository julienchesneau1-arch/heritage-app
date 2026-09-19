/**
 * LE MODEL ROUTER — il choisit une CAPACITÉ, jamais un produit.
 *
 * Référence : `docs/15 §2-§4`, `docs/04 §10-§11`, `docs/14 §4`, ADR-102.
 * Dernier livrable de code de la Phase 4 (`docs/02`).
 *
 * LE PIÈGE QUE LE MANDAT NOMME LUI-MÊME
 * ---------------------------------------------------------------------------
 *   > « Je ne veux surtout pas 17 modèles + 42 routes + benchmark permanent. »
 *
 * Le noyau ne connaît donc **aucun modèle**. Il connaît sept capacités, et un
 * fournisseur déclare celles qu'il sert. Aucune chaîne `'gpt-…'`,
 * `'claude-…'` ou `'llama…'` n'apparaît hors de `src/providers/` — et un test
 * le vérifie sur ce fichier.
 *
 * L'ORDRE EST LA SÉCURITÉ — `docs/15 §R3`
 * ---------------------------------------------------------------------------
 * ```text
 * 1. CAPACITÉ          qui sait faire cette chose ?
 * 2. CONFIDENTIALITÉ   qui a le droit de VOIR cette donnée ?     docs/14
 * 3. POLITIQUE         le cloud est-il autorisé ?                ADR-069
 * 4. BUDGET            délégué au CostGate, qui reçoit l'allowance
 *                      DÉJÀ tranchée — « le coût ne la rouvre jamais »
 * ```
 *
 * ⚠ AUCUNE ÉTAPE NE PEUT ÊTRE RATTRAPÉE PAR UNE SUIVANTE. Un fournisseur écarté
 * par la confidentialité ne revient pas parce qu'il est disponible, rapide ou
 * gratuit. C'est la même mécanique que `strictest()` dans le Policy Gate : **il
 * n'existe ici aucune fonction capable de réintégrer un candidat éliminé.**
 *
 * ⚠ R4 — UN MODÈLE NON AUTORISÉ N'EXISTE PAS COMME REPLI
 * ---------------------------------------------------------------------------
 * C'est la règle qui distingue un routeur d'un système de secours. Quand plus
 * aucun candidat n'est éligible, la réponse correcte est **une phrase**, pas
 * une escalade :
 *
 *   > « Le moteur local est indisponible. Je n'envoie pas ce document à un
 *   >   service externe. »
 *
 * Un routeur qui, faute de local, essaierait le cloud « juste cette fois »
 * transformerait une panne en fuite. Et personne ne le verrait, parce que
 * l'utilisateur aurait obtenu sa réponse.
 *
 * ⚠ FONCTION PURE, SANS ENTRÉE-SORTIE — et c'est un choix
 * ---------------------------------------------------------------------------
 * Le routeur ne sonde pas la santé des fournisseurs et n'interroge pas la base.
 * Il reçoit ce que l'appelant sait, et décide. Même geste que
 * `intent/engine.ts` : la décision ne doit pas pouvoir échouer pour une raison
 * d'infrastructure, et elle doit s'éprouver sans rien démarrer.
 */
import { z } from 'zod';
import { mayEgress } from '../privacy/classify.js';
/* `import type` et pas `import` : seul le TYPE est utilisé ici. Avec
   `verbatimModuleSyntax`, un import de valeur non utilisée resterait dans le
   JS émis et chargerait `domain.js` pour rien. */
import type { DataLevel } from '../types/domain.js';

/**
 * Les sept capacités de `docs/15 §2`. Sept, pas dix-sept modèles.
 *
 * Écrites en toutes lettres : une capacité ajoutée doit provoquer une erreur de
 * compilation là où elle n'est pas traitée, pas un repli silencieux.
 */
export const Capacite = z.enum([
  /** Classification, extraction, intention — quelques millisecondes. */
  'FAST_LOCAL',
  /** Raisonnement court, résumé — local. */
  'LOCAL_REASONING',
  /** Raisonnement long, documents volumineux — distant. */
  'CLOUD_REASONING',
  /** Lecture d'image sur l'appareil. */
  'VISION_LOCAL',
  /** Analyse d'image distante. */
  'VISION_CLOUD',
  /** Transcription et synthèse à faible latence. */
  'VOICE_REALTIME',
  /** Vecteurs pour la voie sémantique. */
  'EMBEDDING_LOCAL',
]);
export type Capacite = z.infer<typeof Capacite>;

/**
 * Un fournisseur, vu par le routeur.
 *
 * ⚠ `local` EST LE CHAMP QUI DÉCIDE DE TOUT, et il n'est pas déclaratif : la
 * boucle locale est une ADRESSE, pas une intention (ADR-082). Un fournisseur
 * qui se dirait local sans l'être ferait sortir une donnée `SENSITIVE` sans
 * qu'aucune règle ne s'y oppose — c'est l'adaptateur, pas le routeur, qui doit
 * rendre ce mensonge impossible.
 */
export interface CandidatDeRoutage {
  readonly id: string;
  readonly capacites: readonly Capacite[];
  readonly local: boolean;
  /** Sondée par l'appelant. Le routeur ne fait aucune entrée-sortie. */
  readonly disponible: boolean;
  readonly coutParMillionEur: number;
  readonly latenceTypiqueMs: number;
}

export interface DemandeDeRoutage {
  readonly capacite: Capacite;
  /**
   * Le niveau le plus élevé de ce qui sera **envoyé au fournisseur**.
   *
   * Pas le niveau de la question : celui de l'ENSEMBLE transmis. Trois tâches
   * `PERSONAL` et un bulletin de salaire forment un ensemble
   * `HIGHLY_SENSITIVE` (`docs/14 §3`), et c'est `levelOfSet` qui le calcule.
   */
  readonly niveauDesDonnees: DataLevel;
  /** L'interrupteur de `config`, honoré depuis ADR-069. */
  readonly cloudAutorise: boolean;
}

/** Pourquoi un candidat a été écarté. Une seule raison par candidat : la PREMIÈRE. */
export const MotifDEcart = z.enum([
  'CAPACITE_ABSENTE',
  'CONFIDENTIALITE',
  'POLITIQUE',
  'INDISPONIBLE',
]);
export type MotifDEcart = z.infer<typeof MotifDEcart>;

export interface Ecart {
  readonly id: string;
  readonly motif: MotifDEcart;
}

export type Routage =
  | {
      readonly kind: 'ROUTE';
      readonly fournisseur: CandidatDeRoutage;
      readonly raison: string;
      /** Ce qui a été écarté, et pourquoi. `docs/04 §10` exige la raison. */
      readonly ecartes: readonly Ecart[];
      /**
       * Ce que le CostGate doit recevoir — déjà tranché par la politique.
       *
       * Le routeur ne décide PAS du budget : il dit au CostGate ce que la
       * confidentialité et la politique ont déjà établi, et le coût ne le
       * rouvre jamais (`docs/04 §10`).
       */
      readonly allowance: 'LOCAL_ONLY' | 'LOCAL_OR_CLOUD';
    }
  | {
      readonly kind: 'REFUS';
      /** Une PHRASE, jamais une escalade — `docs/15 §R4`. */
      readonly raison: string;
      readonly ecartes: readonly Ecart[];
    };

/**
 * La phrase du refus, construite depuis le motif DOMINANT.
 *
 * ⚠ ELLE DIT CE QUI A BLOQUÉ, PAS « INDISPONIBLE ». L'utilisateur qui lit
 * « aucun fournisseur disponible » croit à une panne et réessaie ; celui qui
 * lit « je n'envoie pas ça dehors » comprend que c'est une décision, et que
 * réessayer ne changera rien.
 *
 * L'ordre de priorité suit celui des étapes : la confidentialité prime, parce
 * qu'elle est la seule raison qui ne se résoudra jamais d'elle-même.
 */
function phraseDeRefus(
  capacite: Capacite,
  niveau: DataLevel,
  ecartes: readonly Ecart[],
): string {
  const motifs = new Set(ecartes.map((e) => e.motif));

  if (motifs.has('CONFIDENTIALITE')) {
    return (
      `Le moteur local ne peut pas répondre, et cette donnée est classée `
      + `${niveau} : je ne l'envoie pas à un service externe. C'est une `
      + `décision, pas une panne.`
    );
  }
  if (motifs.has('POLITIQUE')) {
    return (
      'Le moteur local ne peut pas répondre, et le cloud est désactivé. '
      + 'Rien ne sort de la machine tant que tu ne l’as pas activé.'
    );
  }
  if (motifs.has('INDISPONIBLE')) {
    return (
      'Le moteur qui sait faire ça ne répond pas. Je préfère te le dire '
      + 'plutôt que d’envoyer ta demande ailleurs.'
    );
  }
  return `Aucun moteur installé ne sait faire ça (${capacite}).`;
}

/**
 * Choisit un fournisseur, ou refuse.
 *
 * ⚠ L'ORDRE DES FILTRES EST LA PROPRIÉTÉ. Il est écrit en séquence plutôt
 * qu'en un seul prédicat composé, pour que chaque étape soit éprouvable
 * séparément — et pour qu'on VOIE, à la lecture, que la confidentialité passe
 * avant la disponibilité.
 */
export function router(
  candidats: readonly CandidatDeRoutage[],
  demande: DemandeDeRoutage,
): Routage {
  const ecartes: Ecart[] = [];
  const garde = (c: CandidatDeRoutage, motif: MotifDEcart): false => {
    /* UN SEUL MOTIF PAR CANDIDAT — LE PREMIER. Les accumuler laisserait croire
       qu'un fournisseur écarté par la confidentialité l'est « aussi » par le
       budget, ce qui suggérerait qu'en corrigeant le budget on le récupère.
       On ne le récupère pas. */
    ecartes.push({ id: c.id, motif });
    return false;
  };

  const eligibles = candidats.filter((c) => {
    /* 1. CAPACITÉ. */
    if (!c.capacites.includes(demande.capacite)) {
      return garde(c, 'CAPACITE_ABSENTE');
    }

    /* 2. CONFIDENTIALITÉ — `docs/14`, et elle passe AVANT tout le reste.

       Un fournisseur non local ne voit jamais une donnée qui n'a pas le droit
       de sortir, quel que soit son coût, sa latence ou sa disponibilité.
       `mayEgress` est la MÊME fonction que celle du Policy Gate : un second
       prédicat « à peu près équivalent » finirait par diverger (ADR-041). */
    if (!c.local && !mayEgress(demande.niveauDesDonnees)) {
      return garde(c, 'CONFIDENTIALITE');
    }

    /* 3. POLITIQUE — l'interrupteur de l'utilisateur (ADR-069). */
    if (!c.local && !demande.cloudAutorise) {
      return garde(c, 'POLITIQUE');
    }

    /* 4. DISPONIBILITÉ — en DERNIER, et c'est délibéré.

       Placée plus haut, elle écarterait un fournisseur local en panne avant
       que la confidentialité n'ait éliminé les distants — et le journal des
       écarts dirait alors « indisponible » là où la vraie raison est « cette
       donnée ne sort pas ». La phrase de refus s'en trouverait fausse. */
    if (!c.disponible) return garde(c, 'INDISPONIBLE');

    return true;
  });

  if (eligibles.length === 0) {
    /* R4 — AUCUNE ESCALADE. On n'essaie pas « le moins pire » : un modèle non
       autorisé n'existe pas comme repli. */
    return {
      kind: 'REFUS',
      raison: phraseDeRefus(demande.capacite, demande.niveauDesDonnees, ecartes),
      ecartes,
    };
  }

  /* LE CHOIX — local d'abord, puis le plus rapide.

     ⚠ ET PAS « LE MOINS CHER ». Le local coûte zéro : trier par coût donnerait
     le même résultat aujourd'hui et le mauvais demain, le jour où un cloud
     gratuit apparaîtrait. `docs/04 §11` veut que « le pourcentage local
     augmente continûment » — c'est une préférence de PRINCIPE, pas une
     conséquence du prix. */
  const choisi = [...eligibles].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.latenceTypiqueMs - b.latenceTypiqueMs;
  })[0];

  /* `eligibles.length > 0` vient d'être établi ; ce garde existe parce que
     `noUncheckedIndexedAccess` a raison de ne pas me croire sur parole. */
  if (choisi === undefined) {
    return {
      kind: 'REFUS',
      raison: phraseDeRefus(demande.capacite, demande.niveauDesDonnees, ecartes),
      ecartes,
    };
  }

  return {
    kind: 'ROUTE',
    fournisseur: choisi,
    raison: choisi.local
      ? `Moteur local « ${choisi.id} » : rien ne sort de la machine.`
      : `Aucun moteur local ne sert ${demande.capacite} ; « ${choisi.id} » est `
        + `autorisé pour une donnée ${demande.niveauDesDonnees}.`,
    ecartes,
    /* CE QUE LE COSTGATE RECEVRA. Un fournisseur local ne peut pas dépasser un
       budget : `LOCAL_ONLY` dit au CostGate qu'il n'a rien à arbitrer, et que
       rouvrir la question du cloud ne lui appartient pas. */
    allowance: choisi.local ? 'LOCAL_ONLY' : 'LOCAL_OR_CLOUD',
  };
}
