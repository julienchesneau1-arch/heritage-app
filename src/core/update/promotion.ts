/**
 * UPDATE ENGINE — décider si une version a le droit d'atteindre la production.
 * `docs/07 §3`, `§4`, `§6`, `§10`. Phase 7.
 *
 * `CLAUDE.md` règle 5, appliquée littéralement : *« Aucune mise à jour ne va
 * directement en production. »*
 *
 * L'ORDRE DES REFUS EST LA PROPRIÉTÉ, PAS UNE OPTIMISATION
 * ---------------------------------------------------------------------------
 * ```text
 * 1. signature       une signature non VÉRIFIÉE refuse, sans exception (§4)
 * 2. canal           BETA et EXPERIMENTAL ne vont jamais en production (§10)
 * 3. mesures         pas de LAB = pas de promotion (§1 : aucune étape n'est
 *                    optionnelle)
 * 4. critères        un seuil manqué refuse (§6)
 * 5. portée          ce qui touche §3 exige un HUMAIN — même tout vert
 * ```
 *
 * **Le rang 5 vient en dernier, et c'est tout le raisonnement.** Un humain ne
 * doit jamais être invité à approuver une version qui a échoué : lui poser la
 * question reviendrait à lui demander de couvrir un défaut que la machine a
 * déjà vu. On ne demande une signature humaine que sur ce qui est, par
 * ailleurs, irréprochable.
 *
 * LA SYMÉTRIE AVEC LE COSTGATE
 * ---------------------------------------------------------------------------
 * Comme lui (ADR-040), **cette fonction ne peut que RESTREINDRE**. Aucun
 * chemin ne transforme un refus en promotion : ni l'urgence d'un correctif de
 * sécurité, ni une décision humaine, ni un canal privilégié.
 *
 * `docs/07 §10` le dit pour le cas le plus tentant : *« L'urgence d'un
 * correctif de sécurité raccourcit les délais, jamais le pipeline. »*
 *
 * ⚠ CE QUI N'EST PAS ICI
 * ---------------------------------------------------------------------------
 * Cette fonction **décide**. Elle n'installe rien, ne télécharge rien, ne
 * vérifie aucune signature — elle LIT un état de signature qu'un vérificateur
 * TUF/Sigstore devra produire (`docs/07 §4`, ADR-011 : on assemble, on
 * n'invente pas la cryptographie de distribution).
 *
 * Tant que ce vérificateur n'existe pas, aucun appelant ne peut produire
 * `VERIFIEE` honnêtement — ce qui signifie que le système entier refuse toute
 * mise à jour. **C'est le bon état par défaut**, et il est délibéré.
 */
import {
  canalAdmisEnProduction,
  exigeDecisionHumaine,
  type Candidat,
  type Mesures,
} from './candidat.js';

/**
 * Le verdict.
 *
 * Trois issues, et `DECISION_HUMAINE_REQUISE` n'est ni un oui ni un non : la
 * confondre avec `PROMOUVOIR` donnerait au système le droit de modifier ses
 * propres politiques de sécurité ; la confondre avec `REFUSER` rendrait
 * impossible toute évolution de ces politiques.
 */
export type Verdict =
  | { readonly kind: 'PROMOUVOIR' }
  | { readonly kind: 'REFUSER'; readonly raisons: readonly string[] }
  | {
      readonly kind: 'DECISION_HUMAINE_REQUISE';
      readonly raisons: readonly string[];
    };

/** Les huit critères de `docs/07 §6`, chacun rendant sa raison ou rien. */
function critauxManques(m: Mesures): readonly string[] {
  const manques: string[] = [];

  /* Les trois suites doivent être à 100 %. On compare à 1 exactement : « 99,9 %
     de tests de sécurité » signifie qu'un test de sécurité échoue, et le
     document ne connaît pas d'arrondi. */
  if (m.testsCritiques < 1) {
    manques.push(`tests critiques à ${pourcent(m.testsCritiques)} — exigé : 100 %`);
  }
  if (m.testsSecurite < 1) {
    manques.push(`tests de sécurité à ${pourcent(m.testsSecurite)} — exigé : 100 %`);
  }
  if (m.testsPolitique < 1) {
    manques.push(`tests de politique à ${pourcent(m.testsPolitique)} — exigé : 100 %`);
  }
  if (m.regressions > 0) {
    manques.push(`${String(m.regressions)} régression(s) — exigé : aucune`);
  }
  if (m.qualite < m.qualiteReference) {
    manques.push(
      `qualité ${String(m.qualite)} sous la référence ${String(m.qualiteReference)}`,
    );
  }
  if (m.latenceMs > m.latenceSeuilMs) {
    manques.push(
      `latence ${String(m.latenceMs)} ms au-dessus du seuil ${String(m.latenceSeuilMs)} ms`,
    );
  }
  if (!m.integriteMemoire) {
    manques.push('intégrité mémoire non vérifiée');
  }
  /* ⚠ LE CRITÈRE LE PLUS SÉVÈRE, ET IL LE MÉRITE.

     Une fausse confirmation est le seul défaut qui fait MENTIR Jarvis sans
     qu'il le sache (`CLAUDE.md` règle 3). Une seule suffit à refuser : ce
     n'est pas une métrique de qualité qu'on optimise, c'est une propriété
     qu'on a ou qu'on n'a pas. */
  if (m.fausseConfirmation > 0) {
    manques.push(
      `${String(m.fausseConfirmation)} fausse(s) confirmation(s) — exigé : zéro`,
    );
  }

  return manques;
}

function pourcent(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}

/**
 * Décide du sort d'une version candidate.
 *
 * Fonction **pure** : mêmes entrées, même verdict. C'est ce qui la rend
 * éprouvable sans installer quoi que ce soit — et ce qui permet d'écrire
 * l'enveloppe de sûreté avant le mécanisme qu'elle encadre.
 */
export function deciderPromotion(candidat: Candidat): Verdict {
  const raisons: string[] = [];

  /* --- 1. SIGNATURE — `docs/07 §4` ------------------------------------- */
  /* « Une mise à jour non vérifiable est refusée. Sans exception, sans mode
     dégradé, sans option de configuration pour l'ignorer. »

     Ce refus est le premier parce qu'il ne dépend de rien : une version dont
     on ne sait pas d'où elle vient ne mérite pas qu'on lise ses résultats de
     tests — ils viennent de la même source. */
  if (candidat.signature !== 'VERIFIEE') {
    raisons.push(
      candidat.signature === 'INVALIDE'
        ? 'signature INVALIDE — l’artefact n’est pas celui qui a été signé'
        : candidat.signature === 'ABSENTE'
          ? 'aucune signature — l’origine de l’artefact est inconnue'
          : 'signature non vérifiable — le vérificateur n’a pas pu se prononcer',
    );
  }

  /* --- 2. CANAL — `docs/07 §10` ---------------------------------------- */
  if (!canalAdmisEnProduction(candidat.canal)) {
    raisons.push(
      `canal ${candidat.canal} — réservé au LAB, jamais à la production`,
    );
  }

  /* --- 3. LE LAB A-T-IL SEULEMENT TOURNÉ ? — `docs/07 §1` -------------- */
  /* « Aucune étape n'est optionnelle. » `mesures === null` ne signifie pas
     « rien à signaler » : il signifie que personne n'a regardé. Traiter
     l'absence de mesure comme un succès serait la définition même de la
     réussite non vérifiée que `CLAUDE.md` règle 3 interdit. */
  if (candidat.mesures === null) {
    raisons.push('aucune mesure du LAB — la version n’a traversé aucune étape de test');
  } else {
    /* --- 4. LES HUIT CRITÈRES — `docs/07 §6` -------------------------- */
    raisons.push(...critauxManques(candidat.mesures));
  }

  if (raisons.length > 0) return { kind: 'REFUSER', raisons };

  /* --- 5. LA PORTÉE — `docs/07 §3` ------------------------------------ */
  /* On n'arrive ici QUE si tout le reste est irréprochable. Ce qui suit
     n'est donc pas un doute sur la qualité : c'est un domaine où la qualité
     ne suffit pas à autoriser.

     Une mise à jour qui modifie une politique de sécurité peut passer tous
     les tests — les tests qu'elle a elle-même le droit de redéfinir. */
  const humaines = candidat.portees.filter(exigeDecisionHumaine);
  if (humaines.length > 0) {
    return {
      kind: 'DECISION_HUMAINE_REQUISE',
      raisons: humaines.map(
        (p) => `touche ${p} — décision humaine explicite exigée (docs/07 §3)`,
      ),
    };
  }

  return { kind: 'PROMOUVOIR' };
}
