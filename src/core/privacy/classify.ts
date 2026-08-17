/**
 * CLASSIFICATION DE CONFIDENTIALITÉ — `docs/14 §3`.
 *
 * Étape F1 du Data Firewall : **une pure fonction, branchée à rien.**
 *
 * POURQUOI COMMENCER PAR DU CALCUL SANS APPELANT
 * -----------------------------------------------
 * Tout ce que ce dépôt a construit jusqu'ici RÉTRÉCIT : le cloisonnement refuse
 * plus, le bail refuse plus, `UNKNOWN` affirme moins. Le Data Firewall est le
 * premier chantier dont un pas ÉLARGIT — faire passer une donnée `GREEN` en
 * `PUBLIC`, c'est-à-dire *envoyable*.
 *
 * On isole donc le calcul, qui n'accorde ni ne retire aucune permission, du
 * branchement, qui en accorde. Ce fichier ne peut rien casser : il ne décide
 * de rien, il répond à une question.
 *
 * LA RÈGLE QUE `docs/14` SOULIGNE ET QU'IL FAUT RÉPÉTER
 * -----------------------------------------------------
 *   > Le LLM ne choisit jamais lui-même son niveau de confidentialité.
 *   > Le système le détermine **avant** lui.
 *
 * Aucune fonction de ce module ne prend une sortie de modèle. Le niveau se
 * déduit de la CATÉGORIE, que la base impose à l'écriture.
 */
import {
  strictestLevel,
  type DataCategory,
  type DataLevel,
  type PrivacyClass,
  type Provenance,
} from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

/**
 * `DataCategory` → **plancher** de confidentialité (`docs/14 §3`).
 *
 * Plancher, pas valeur : l'utilisateur peut monter, jamais descendre.
 *
 * La table est écrite en toutes lettres plutôt que déduite d'une heuristique.
 * Une catégorie oubliée doit provoquer une erreur de compilation, pas un repli
 * silencieux vers le niveau le plus bas — c'est la différence entre un défaut
 * visible et une fuite.
 */
const PLANCHER: Readonly<Record<DataCategory, DataLevel>> = {
  /* Jamais négociable. Un secret n'entre dans aucun contexte de modèle, pas
     même local (`docs/14 §2`). */
  CREDENTIAL: 'RESTRICTED',

  HEALTH: 'HIGHLY_SENSITIVE',
  FINANCIAL: 'HIGHLY_SENSITIVE',

  EMAIL: 'SENSITIVE',
  MESSAGE: 'SENSITIVE',
  CALENDAR: 'SENSITIVE',
  CONTACT: 'SENSITIVE',
  DOCUMENT: 'SENSITIVE',
  LOCATION: 'SENSITIVE',

  TASK: 'PERSONAL',
  PROJECT: 'PERSONAL',
  PERSONAL_MEMORY: 'PERSONAL',

  WEATHER: 'PUBLIC',

  /* DÉFAUT FERMÉ, et c'est le seul choix de cette table qui mérite un
     commentaire. Une catégorie inconnue tombe sur `PERSONAL`, pas sur
     `PUBLIC` : ce qu'on ne sait pas nommer, on ne l'envoie pas. */
  OTHER: 'PERSONAL',
};

/** Le plancher imposé par la catégorie. Rien ne descend en dessous. */
export function floorFor(category: DataCategory): DataLevel {
  return PLANCHER[category];
}

export interface ClassifyInput {
  readonly category: DataCategory;
  /**
   * Niveau demandé par l'utilisateur. Il peut MONTER, jamais descendre sous le
   * plancher — une demande plus basse est ignorée, pas refusée : refuser
   * ferait échouer une opération légitime pour une intention qui, de toute
   * façon, n'a aucun effet.
   */
  readonly requested?: DataLevel;
  /**
   * Provenance de la valeur. Une donnée `EXTERNAL_UNTRUSTED` ne peut jamais
   * ABAISSER le niveau (`docs/14 §3`, source 2).
   */
  readonly provenance?: Provenance;
}

/**
 * Le niveau d'une valeur, déterminé par le système.
 *
 * Trois sources dans l'ordre de `docs/14 §3`, et chacune ne peut que MONTER.
 */
export function classify(input: ClassifyInput): DataLevel {
  let level = floorFor(input.category);

  // 3. UTILISATEUR — peut monter. `strictestLevel` rend le plus protecteur,
  //    donc une demande plus basse est sans effet, par construction.
  if (input.requested !== undefined) {
    level = strictestLevel(level, input.requested);
  }

  /* 2. PROVENANCE — une valeur venue d'un tiers ne peut pas ABAISSER un
     niveau. Elle ne le monte pas non plus mécaniquement : ce serait confondre
     « qui l'a écrite » avec « de quoi elle parle ». Le plancher fait le
     travail, et cette ligne existe pour que la propriété soit VÉRIFIABLE
     plutôt que déduite de l'absence de code. */
  if (input.provenance === 'EXTERNAL_UNTRUSTED') {
    level = strictestLevel(level, floorFor(input.category));
  }

  return level;
}

/**
 * Le niveau d'un ENSEMBLE : le maximum de ses éléments.
 *
 * > Trois tâches `PERSONAL` et un bulletin de salaire forment un ensemble
 * > `HIGHLY_SENSITIVE`.
 *
 * `docs/14 §3` nomme ça « l'erreur classique du RAG, qui agrège des fragments
 * et perd leur classification en route ». Un ensemble vide vaut `PUBLIC` — il
 * ne contient rien à protéger, et prétendre le contraire rendrait la fonction
 * inutilisable sur un résultat de recherche sans résultat.
 */
export function levelOfSet(levels: readonly DataLevel[]): DataLevel {
  return levels.reduce<DataLevel>((acc, l) => strictestLevel(acc, l), 'PUBLIC');
}

/**
 * Conversion depuis l'ancien domaine — ET ELLE REFUSE DE DEVINER.
 *
 * `docs/14 §5` fixe la correspondance et l'assortit d'un avertissement qui est
 * la raison d'être de cette fonction :
 *
 *   > `GREEN → PUBLIC` : ⚠ **à vérifier ligne par ligne avant migration.** Une
 *   > donnée aujourd'hui `GREEN` par défaut d'attention deviendrait
 *   > publiquement envoyable. **La migration doit défaillir plutôt que
 *   > deviner.**
 *
 * D'où le `Result` : `RED` et `ORANGE` se convertissent seuls, parce qu'ils ne
 * peuvent que rester au moins aussi protégés. `GREEN` n'est accepté que si la
 * CATÉGORIE le confirme — sinon la conversion échoue, bruyamment, et la ligne
 * remonte à un humain.
 *
 * C'est le seul endroit du chantier où l'erreur exposerait une donnée. Il rend
 * donc une erreur là où il serait tentant de rendre une valeur.
 */
export function fromLegacy(
  legacy: PrivacyClass,
  category: DataCategory,
): Result<DataLevel> {
  const plancher = floorFor(category);

  if (legacy === 'RED') {
    /* `RED → HIGHLY_SENSITIVE`, sauf si la catégorie exige davantage. Un
       `CREDENTIAL` classé RED devient `RESTRICTED`, pas `HIGHLY_SENSITIVE` :
       `docs/14 §5` le dit explicitement — « les CREDENTIAL devront être
       re-classés RESTRICTED par leur catégorie, pas par leur ancienne
       classe ». */
    return ok(strictestLevel('HIGHLY_SENSITIVE', plancher));
  }

  if (legacy === 'ORANGE') {
    return ok(strictestLevel('PERSONAL', plancher));
  }

  // GREEN — le seul cas qui pourrait ÉLARGIR.
  if (plancher === 'PUBLIC') return ok('PUBLIC');

  return err(
    jarvisError(
      'VALIDATION',
      `Conversion refusée : une donnée GREEN de catégorie ${category} deviendrait `
        + `PUBLIC alors que son plancher est ${plancher}. `
        + 'docs/14 §5 exige une vérification ligne par ligne — la migration '
        + 'doit défaillir plutôt que deviner.',
      { legacy, category, plancher },
    ),
  );
}

/**
 * Ce niveau autorise-t-il une sortie de la machine ?
 *
 * Exporté maintenant, appelé par personne : c'est F2 qui branchera le Policy
 * Gate, et ce sera un `forbid` AJOUTÉ à l'existant — donc un changement qui ne
 * peut que refuser davantage.
 */
export function mayEgress(level: DataLevel): boolean {
  return level === 'PUBLIC' || level === 'PERSONAL';
}
