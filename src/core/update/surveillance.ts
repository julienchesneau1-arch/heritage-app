/**
 * UPDATE ENGINE — le rollback automatique. `docs/07 §8`, `§9`. Phase 7.
 *
 * > *« Le rollback automatique se déclenche dès qu'une métrique critique se
 * > dégrade — sans attendre une décision humaine. Une régression détectée à
 * > 3 h du matin ne doit pas attendre le réveil. »*
 *
 * C'est la seule décision de ce dépôt qui agit **contre** l'utilisateur au
 * sens strict : elle retire quelque chose qu'il n'a pas demandé de retirer.
 * Elle est donc bornée par deux propriétés opposées, et l'équilibre entre les
 * deux est tout le sujet :
 *
 * ```text
 * trop timide   une régression tourne en production jusqu'au réveil
 * trop nerveuse un rollback sur du bruit, et plus personne n'y croit
 * ```
 *
 * ⚠ LE PIÈGE PRINCIPAL : « PAS DE DÉGRADATION » ≠ « PAS ASSEZ DE DONNÉES »
 * ---------------------------------------------------------------------------
 * Une version promue il y a trente secondes n'a produit que quelques appels.
 * Comparer leurs taux à une référence établie sur des milliers d'appels ne
 * mesure rien — mais rend un verdict qui *ressemble* à une mesure.
 *
 * `INSUFFISANT` existe donc, et n'est jamais replié sur `RIEN`. C'est la même
 * distinction que `UNKNOWN` contre `FAILED` (`docs/19`) : ne pas savoir n'est
 * pas aller bien.
 *
 * ⚠ CE QUI N'EST PAS ICI
 * ---------------------------------------------------------------------------
 * Ce module **décide** qu'il faut revenir en arrière. Il ne revient pas en
 * arrière : `docs/07 §9` exige de conserver
 * `version_courante · version_précédente · backup · état_de_migration`, et
 * rien de tout cela n'existe. Voir `candidat.ts` — décision construite,
 * exécution non.
 */

/**
 * Ce qu'on observe d'une version en production — `docs/07 §8`.
 *
 * Sept métriques, recopiées du document. Toutes ne sont pas critiques, et
 * c'est le point suivant.
 */
export interface Metriques {
  /** Nombre d'appels observés. Sous le minimum, aucun taux ne veut rien dire. */
  readonly appels: number;
  readonly tauxSucces: number;
  readonly tauxVerification: number;
  readonly latenceP95Ms: number;
  readonly coutEur: number;
  readonly tauxClarification: number;
  readonly erreursOutils: number;
  readonly tauxFausseConfirmation: number;
}

export type Verdict =
  | { readonly kind: 'RIEN' }
  | { readonly kind: 'INSUFFISANT'; readonly detail: string }
  | { readonly kind: 'ROLLBACK'; readonly raisons: readonly string[] };

/**
 * Le nombre d'appels sous lequel on refuse de conclure.
 *
 * ⚠ CE SEUIL EST UN CHOIX, PAS UN RÉSULTAT — et il faut le dire. Trente n'est
 * pas dérivé d'un calcul de puissance statistique : c'est un ordre de grandeur
 * qui écarte le cas manifeste (« trois appels, dont un raté, donc 33 % d'échec
 * et rollback »).
 *
 * Ce qui est en revanche établi, c'est qu'un seuil DOIT exister : sans lui, la
 * première seconde de trafic décide du sort de la version.
 *
 * Condition de révision : la première mise à jour réellement surveillée. On
 * saura alors ce que « assez d'appels » veut dire ici, au lieu de le supposer.
 */
export const APPELS_MINIMUM = 30;

/**
 * LES MÉTRIQUES CRITIQUES, ET POURQUOI CELLES-LÀ.
 *
 * `docs/07 §8` en surveille sept. `§9` déclenche sur « une métrique
 * critique », sans dire lesquelles. Le choix est donc ici, et il s'explique :
 *
 * | métrique | critique ? | pourquoi |
 * |---|---|---|
 * | fausse confirmation | **oui** | Jarvis affirme un succès qui n'a pas eu lieu — `CLAUDE.md` règle 3 |
 * | taux de vérification | **oui** | il agit sans pouvoir prouver l'effet |
 * | taux de succès | **oui** | la capacité elle-même se dégrade |
 * | latence p95 | **oui** | au-delà d'un seuil, l'assistant devient inutilisable |
 * | coût | non | grave, mais le CostGate le borne DÉJÀ, et il bloque au lieu de retirer |
 * | taux de clarification | non | une hausse peut être une AMÉLIORATION — demander plutôt que deviner |
 * | erreurs d'outils | non | souvent imputables au fournisseur, pas à la version |
 *
 * La ligne « clarification » mérite d'être lue deux fois. Une version qui pose
 * plus de questions ressemble à une régression et peut être exactement
 * l'inverse : `docs/05 §A3` interdit de deviner quand deux lectures diffèrent.
 * Faire d'elle un déclencheur de rollback pousserait le système à préférer les
 * versions qui devinent.
 */

/** Une dégradation relative en deçà de laquelle on ne bouge pas. */
const TOLERANCE_RELATIVE = 0.05;

export function surveiller(
  reference: Metriques,
  courant: Metriques,
): Verdict {
  if (courant.appels < APPELS_MINIMUM) {
    /* ⚠ JAMAIS `RIEN`. « Trop tôt pour dire » n'est pas « tout va bien » — et
       c'est précisément à ce moment-là qu'on serait tenté de l'écrire, parce
       que le tableau de bord est vert. */
    return {
      kind: 'INSUFFISANT',
      detail:
        `${String(courant.appels)} appel(s) observés, minimum ${String(APPELS_MINIMUM)} — ` +
        'aucun taux n’est interprétable sur cet échantillon',
    };
  }

  const raisons: string[] = [];

  /* --- La fausse confirmation : AUCUNE tolérance ----------------------- */
  /* Les autres métriques ont une marge relative parce qu'elles décrivent une
     qualité. Celle-ci décrit une VÉRITÉ : Jarvis a dit « c'est fait » quand ce
     ne l'était pas. Une seule de plus que la référence suffit.

     Traiter une fausse confirmation comme un pourcentage à optimiser
     reviendrait à négocier le taux de mensonge acceptable. */
  if (courant.tauxFausseConfirmation > reference.tauxFausseConfirmation) {
    raisons.push(
      `fausse confirmation en hausse (${fmt(reference.tauxFausseConfirmation)} → ` +
        `${fmt(courant.tauxFausseConfirmation)}) — aucune tolérance sur ce critère`,
    );
  }

  /* --- Les trois autres critiques, avec tolérance ---------------------- */
  if (baisseSignificative(reference.tauxVerification, courant.tauxVerification)) {
    raisons.push(
      `taux de vérification en baisse (${fmt(reference.tauxVerification)} → ` +
        `${fmt(courant.tauxVerification)}) — Jarvis agit sans pouvoir prouver l’effet`,
    );
  }
  if (baisseSignificative(reference.tauxSucces, courant.tauxSucces)) {
    raisons.push(
      `taux de succès en baisse (${fmt(reference.tauxSucces)} → ${fmt(courant.tauxSucces)})`,
    );
  }
  if (
    reference.latenceP95Ms > 0 &&
    courant.latenceP95Ms > reference.latenceP95Ms * (1 + TOLERANCE_RELATIVE)
  ) {
    raisons.push(
      `latence p95 en hausse (${String(reference.latenceP95Ms)} ms → ` +
        `${String(courant.latenceP95Ms)} ms)`,
    );
  }

  if (raisons.length > 0) return { kind: 'ROLLBACK', raisons };
  return { kind: 'RIEN' };
}

function baisseSignificative(reference: number, courant: number): boolean {
  if (reference <= 0) return false;
  return courant < reference * (1 - TOLERANCE_RELATIVE);
}

function fmt(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}
