/**
 * RECONNAÎTRE UNE DATE SANS LA CALCULER — ADR-077.
 *
 * Ce module traduit « jeudi », « demain matin », « dans trois jours » en une
 * description **symbolique**. Il ne produit jamais d'instant, et c'est tout son
 * intérêt.
 *
 * POURQUOI LA SÉPARATION EST OBLIGATOIRE, PAS ÉLÉGANTE
 * ---------------------------------------------------------------------------
 * ADR-036 et ADR-037 posent que **toute fenêtre temporelle est calculée par la
 * base**, jamais par l'horloge du processus. La raison n'est pas esthétique :
 * l'horloge de Node et `clock_timestamp()` dans PostgreSQL dérivent l'une de
 * l'autre, et le jour où elles dérivent, un rappel se pose au mauvais moment
 * sans que rien ne le signale.
 *
 * Un module qui reconnaît « demain » n'a donc pas le droit de savoir quel jour
 * on est. Il rend `{ base: 'DEMAIN', heure: 9 }` ; c'est
 * `src/core/temps/resolution.ts` qui demande l'instant à PostgreSQL.
 *
 * ⚠ AUCUN NOM DE PRIMITIVE D'HORLOGE JAVASCRIPT N'EST ÉCRIT DANS CE FICHIER,
 * pas même en commentaire. `tests/temps/resolution.test.ts` les cherche en
 * TEXTE BRUT, et le détecteur reste bête pour deux raisons : le rendre assez
 * malin pour ignorer les commentaires lui ouvrirait un trou, et surtout — un
 * fichier qui ne contient nulle part l'appel interdit ne permet à personne de
 * le recopier depuis la ligne d'à côté.
 *
 * ```text
 * « rappelle-moi jeudi »
 *   ↓  ce module — PUR, aucune horloge
 * { base: 'JOUR_SEMAINE', jourSemaine: 4, heure: 9 }
 *   ↓  resolution.ts — la BASE calcule
 * 2026-08-20T09:00:00+02:00
 * ```
 *
 * C'est le même partage qu'ADR-073 pour les référents : le `Tier 0` reconnaît,
 * la base résout. Reconnaître est une décision de texte ; résoudre demande un
 * état.
 *
 * CE QUE CE MODULE NE FAIT PAS
 * ---------------------------------------------------------------------------
 * Il ne devine pas. Une expression qu'il ne reconnaît pas rend `null`, et
 * l'appelant DEMANDE — il ne pose pas une date par défaut. Poser une date qu'on
 * n'a pas comprise, c'est créer un rappel pour un moment que l'utilisateur n'a
 * jamais dit.
 */

/**
 * L'heure retenue quand l'utilisateur n'en donne aucune.
 *
 * ⚠ C'EST UN CHOIX, PAS UNE DÉDUCTION — et il n'est acceptable que parce qu'il
 * est **montré**. « Rappelle-moi jeudi » ne dit pas d'heure ; refuser serait
 * inutilisable, et choisir en silence serait inventer.
 *
 * La confirmation affiche l'instant résolu en toutes lettres avant toute
 * écriture (`confirmationPrompt` porte les VALEURS concrètes). L'utilisateur
 * voit donc « jeudi à 09:00 » et peut corriger. Un défaut visible n'est pas un
 * mensonge ; un défaut silencieux en serait un.
 */
export const HEURE_PAR_DEFAUT = 9;

/** Moments de la journée que le français nomme sans donner d'heure. */
const MOMENTS: Readonly<Record<string, number>> = {
  matin: 9,
  'après-midi': 14,
  'apres-midi': 14,
  soir: 19,
  midi: 12,
};

/** Jours de la semaine, en numérotation ISO (lundi = 1, dimanche = 7). */
const JOURS: Readonly<Record<string, number>> = {
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
  dimanche: 7,
};

/**
 * Une date DITE, pas une date calculée.
 *
 * Volontairement pauvre : chaque champ est un entier borné, et aucun n'est du
 * texte libre. C'est ce qui permet à `resolution.ts` de construire son SQL avec
 * des paramètres typés plutôt qu'avec de l'interpolation — une expression
 * temporelle vient de l'utilisateur, et `docs/03` traite toute entrée comme
 * hostile jusqu'à validation.
 */
export type ExpressionTemporelle =
  | { readonly base: 'AUJOURD_HUI'; readonly heure: number; readonly minute: number }
  | { readonly base: 'DEMAIN'; readonly heure: number; readonly minute: number }
  | { readonly base: 'APRES_DEMAIN'; readonly heure: number; readonly minute: number }
  /** Prochaine occurrence STRICTEMENT future de ce jour (ISO 1–7). */
  | {
      readonly base: 'JOUR_SEMAINE';
      readonly jourSemaine: number;
      readonly heure: number;
      readonly minute: number;
    }
  | {
      readonly base: 'DANS_N_JOURS';
      readonly jours: number;
      readonly heure: number;
      readonly minute: number;
    }
  /**
   * Une heure SANS jour : « rappelle-moi à 14h ».
   *
   * Désigne la PROCHAINE occurrence de cette heure — aujourd'hui si elle est
   * encore devant, demain sinon. Même convention que `JOUR_SEMAINE` : un rappel
   * ne se pose jamais dans le passé.
   *
   * Ce cas manquait, et son absence produisait le défaut inverse : « à 14h »
   * n'étant pas reconnu, la règle des tâches s'en saisissait et créait une tâche
   * INTITULÉE « à 14h d'appeler Paul », sans échéance (ADR-079).
   */
  | { readonly base: 'HEURE_SEULE'; readonly heure: number; readonly minute: number }
  /** Décalage à partir de MAINTENANT, pas du début de journée. */
  | { readonly base: 'DANS_N_HEURES'; readonly heures: number }
  | { readonly base: 'DANS_N_MINUTES'; readonly minutes: number };

/** Retire les accents pour la CLÉ seulement — jamais pour l'affichage. */
function sansAccent(valeur: string): string {
  return valeur
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '');
}

/**
 * L'heure explicite d'un énoncé : « à 14h », « à 8h30 ».
 *
 * Rend `null` si aucune n'est donnée — l'appelant décidera s'il retient
 * `HEURE_PAR_DEFAUT` ou le moment de la journée.
 */
/* ⚠ PAS DE `\b` EN TÊTE — ET C'EST LA QUATRIÈME FOIS QUE CE PIÈGE MORD.

   En JavaScript, `\b` se fonde sur `\w`, c'est-à-dire l'ASCII. « à » n'en fait
   pas partie : entre une espace et « à », il n'y a donc AUCUNE frontière de
   mot, et `\b[àa]` ne matche jamais le « à » accentué.

   Mesuré : « jeudi à 14h de rappeler le carreleur » ne retirait que « 14h »,
   laissait « à », et le texte du rappel devenait « de rappeler le carreleur ».

   Le piège est documenté depuis longtemps dans ce dépôt — règle
   `memory_search_decision`, « piège systématique dès qu'on écrit des règles en
   français » — puis re-documenté en ADR-074 et ADR-075. Il continue de mordre
   parce qu'un commentaire ne voyage pas : seul un mécanisme le ferait. */
const RE_HEURE = /(?:[àa]\s*)?(\d{1,2})\s*h(?:\s*(\d{2}))?(?![\p{L}\p{N}_])/iu;

/** Les moments nommés, en un seul motif — pour détecter ET pour retirer. */
const RE_MOMENT = /(?<![\p{L}\p{N}_])(?:matin|apr[èe]s-midi|soir|midi)(?![\p{L}\p{N}_])/iu;

/**
 * L'heure ET LA MINUTE d'un énoncé.
 *
 * ⚠ LA MINUTE ÉTAIT CAPTURÉE PUIS JETÉE. Le motif portait déjà `(\d{2})` en
 * second groupe, et la fonction ne lisait que le premier :
 *
 *     « jeudi à 8h30 »  →  8 h 00
 *
 * L'utilisateur disait 8 h 30, Jarvis posait 8 h 00, et ne le disait pas. Une
 * demi-heure d'écart sur un rendez-vous médical, c'est un rendez-vous manqué —
 * et c'est le motif « une action DIFFÉRENTE de celle demandée » qui a déjà
 * justifié de restreindre `memory_search` (HIGH-4).
 *
 * Trouvé en s'auditant, pas en lisant : la capture inutilisée ne saute pas aux
 * yeux, et aucun test ne portait de minutes.
 */
/**
 * Trois issues, et la troisième est celle qui manquait.
 *
 * ⚠ DISTINGUER « ABSENTE » DE « ILLISIBLE » N'EST PAS UN RAFFINEMENT.
 *
 * La première version n'en avait que deux — un nombre ou `null` — et repliait
 * l'illisible sur l'absent. Mesuré :
 *
 *     « rappelle-moi jeudi à 8h75 de X »
 *       → un rappel à 9 h 00, INTITULÉ « 8h75 »
 *
 * L'heure fautive était **avalée en silence**, exactement le défaut HIGH-5 que
 * `TEMPORAL_QUALIFIER` avait été écrit pour fermer, revenu par une autre porte.
 *
 * Ne rien dire d'une heure est une information : on prend le défaut. Dire une
 * heure qui n'existe pas en est une autre : on ne comprend pas, et on demande.
 * C'est la même distinction que `POSITIVE_ABSENCE` contre `INCONCLUSIVE` dans
 * le Verification Engine — une absence constatée n'est pas une ignorance.
 */
type LectureHeure =
  | { readonly kind: 'ABSENTE' }
  | { readonly kind: 'LUE'; readonly heure: number; readonly minute: number }
  | { readonly kind: 'ILLISIBLE' };

/**
 * L'heure ET LA MINUTE d'un énoncé.
 *
 * ⚠ LA MINUTE ÉTAIT CAPTURÉE PUIS JETÉE. Le motif portait déjà `(\d{2})` en
 * second groupe, et la fonction ne lisait que le premier :
 *
 *     « jeudi à 8h30 »  →  8 h 00
 *
 * L'utilisateur disait 8 h 30, Jarvis posait 8 h 00, et ne le disait pas. Une
 * demi-heure d'écart sur un rendez-vous médical, c'est un rendez-vous manqué —
 * et c'est le motif « une action DIFFÉRENTE de celle demandée » qui a déjà
 * justifié de restreindre `memory_search` (HIGH-4).
 *
 * Trouvé en s'auditant, pas en lisant : une capture inutilisée ne saute pas aux
 * yeux, et aucun test ne portait de minutes.
 */
function heureExplicite(texte: string): LectureHeure {
  const m = RE_HEURE.exec(texte);
  if (m === null) return { kind: 'ABSENTE' };

  const heure = Number(m[1]);
  // Une heure hors bornes n'est pas une heure. On préfère ne rien comprendre
  // plutôt que de poser un rappel à 25 h en le repliant sur 1 h du matin.
  if (!Number.isInteger(heure) || heure < 0 || heure > 23) return { kind: 'ILLISIBLE' };

  const brut = m[2];
  if (brut === undefined) return { kind: 'LUE', heure, minute: 0 };
  const minute = Number(brut);
  // Même refus : « 8h75 » replié sur 9 h 15 inventerait un moment que personne
  // n'a dit — et l'ignorer laisserait « 8h75 » dans le TITRE du rappel.
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { kind: 'ILLISIBLE' };
  return { kind: 'LUE', heure, minute };
}

/** Le moment de la journée nommé, s'il y en a un. */
function moment(texte: string): number | null {
  const nu = sansAccent(texte);
  for (const [nom, heure] of Object.entries(MOMENTS)) {
    if (new RegExp(`\\b${sansAccent(nom)}\\b`, 'u').test(nu)) return heure;
  }
  return null;
}

/**
 * Ce qu'une expression temporelle laisse derrière elle.
 *
 * ⚠ `reste` N'EST PAS UN CONFORT, C'EST UNE CONSÉQUENCE D'ADR-041.
 *
 * La première version laissait l'appelant retirer la date lui-même, avec SA
 * propre idée de ce qu'est une expression temporelle. Il y avait donc deux
 * registres du même fait, et ils ont divergé aussitôt : « rappelle-moi demain
 * matin de sortir la poubelle » rendait la date « demain » et le texte
 * « matin de sortir la poubelle ». L'heure était perdue ET le texte abîmé.
 *
 * Le module qui décide ce qu'est une date est donc le seul à dire ce qu'il en
 * a consommé.
 */
export interface Reconnaissance {
  readonly expression: ExpressionTemporelle;
  /** L'énoncé DÉBARRASSÉ de l'expression temporelle, normalisé. */
  readonly reste: string;
}

/** Retire une portion du texte d'origine et recompacte les espaces. */
function sans(texte: string, portion: RegExp): string {
  return texte.replace(portion, ' ').replace(/\s{2,}/gu, ' ').trim();
}

/**
 * Reconnaît une expression temporelle dans un énoncé français.
 *
 * `null` = **je n'ai pas compris**, et c'est une réponse. L'appelant demande ;
 * il ne complète pas.
 */
export function reconnaitre(texte: string): Reconnaissance | null {
  const nu = sansAccent(texte);

  /* L'heure et le moment sont retirés du texte AVANT tout, parce qu'ils
     peuvent être n'importe où : « rappelle-moi jeudi à 14h » comme
     « rappelle-moi à 14h jeudi ». */
  const lue = heureExplicite(texte);
  /* UNE HEURE DITE MAIS ILLISIBLE ARRÊTE TOUT. La replier sur le défaut
     poserait un rappel à une heure que l'utilisateur n'a pas donnée, en
     laissant sa faute de frappe dans le titre. */
  if (lue.kind === 'ILLISIBLE') return null;

  const momentDit = moment(texte);
  const heure = lue.kind === 'LUE' ? lue.heure : (momentDit ?? HEURE_PAR_DEFAUT);
  /* Un moment de la journée ne porte pas de minute : « demain matin » est 9 h
     pile, et prétendre 9 h 07 serait inventer une précision. */
  const minute = lue.kind === 'LUE' ? lue.minute : 0;

  let reste = texte;
  if (lue.kind === 'LUE') reste = sans(reste, RE_HEURE);
  if (momentDit !== null) reste = sans(reste, RE_MOMENT);

  const rendre = (
    expression: ExpressionTemporelle,
    portion: RegExp,
  ): Reconnaissance => ({ expression, reste: nettoyerReste(sans(reste, portion)) });

  /* L'ORDRE COMPTE : « après-demain » contient « demain ». Le tester d'abord
     évite qu'une expression précise soit avalée par une plus large — la même
     faute que la règle des tâches commettait sur « ajoute ça » (ADR-073). */
  if (/\bapres-demain\b/u.test(nu)) {
    return rendre({ base: 'APRES_DEMAIN', heure, minute }, /(?<![\p{L}\p{N}_])apr[èe]s-demain(?![\p{L}\p{N}_])/iu);
  }
  if (/\bdemain\b/u.test(nu)) {
    return rendre({ base: 'DEMAIN', heure, minute }, /\bdemain\b/iu);
  }

  const dansJours = /\bdans\s+(\d+)\s*jours?\b/u.exec(nu);
  if (dansJours !== null) {
    const jours = Number(dansJours[1]);
    // Deux ans est déjà absurde pour un rappel ; au-delà, c'est une faute de
    // frappe qu'il vaut mieux ne pas comprendre que d'exécuter.
    if (jours > 0 && jours <= 730) {
      return rendre(
        { base: 'DANS_N_JOURS', jours, heure, minute },
        /\bdans\s+\d+\s*jours?\b/iu,
      );
    }
    return null;
  }

  const dansHeures = /\bdans\s+(\d+)\s*heures?\b/u.exec(nu);
  if (dansHeures !== null) {
    const heures = Number(dansHeures[1]);
    if (heures > 0 && heures <= 8_760) {
      return rendre({ base: 'DANS_N_HEURES', heures }, /\bdans\s+\d+\s*heures?\b/iu);
    }
    return null;
  }

  const dansMinutes = /\bdans\s+(\d+)\s*(?:minutes?|min)\b/u.exec(nu);
  if (dansMinutes !== null) {
    const minutes = Number(dansMinutes[1]);
    if (minutes > 0 && minutes <= 525_600) {
      return rendre(
        { base: 'DANS_N_MINUTES', minutes },
        /\bdans\s+\d+\s*(?:minutes?|min)\b/iu,
      );
    }
    return null;
  }

  for (const [nom, jourSemaine] of Object.entries(JOURS)) {
    if (new RegExp(`\\b${nom}\\b`, 'u').test(nu)) {
      return rendre(
        { base: 'JOUR_SEMAINE', jourSemaine, heure, minute },
        new RegExp(`\\b${nom}\\b`, 'iu'),
      );
    }
  }

  /* UNE HEURE EXPLICITE SANS JOUR — « rappelle-moi à 14h ».
     Placée APRÈS les jours : « jeudi à 14h » doit rester un jeudi. Ici il n'y a
     plus de jour possible, donc l'heure désigne sa prochaine occurrence. */
  if (lue.kind === 'LUE') {
    return { expression: { base: 'HEURE_SEULE', heure, minute }, reste: nettoyerReste(reste) };
  }

  /* « ce soir », « ce matin » : un moment SANS jour désigne aujourd'hui. On ne
     l'accepte que si un moment a réellement été nommé — sinon « appelle Paul »
     deviendrait un rappel pour ce matin. */
  if (momentDit !== null && /\bce\s|cet\s|cette\s/u.test(nu)) {
    return {
      expression: { base: 'AUJOURD_HUI', heure, minute },
      reste: nettoyerReste(sans(reste, /\b(?:ce|cet|cette)\b/iu)),
    };
  }

  return null;
}

/**
 * Nettoie ce qui reste une fois la date retirée.
 *
 * Une préposition orpheline — « de », « à », « pour » — reste souvent collée au
 * début : « rappelle-moi demain **de** sortir la poubelle » laisse « de sortir
 * la poubelle ». Le rappel se relira dans l'agenda ; il doit se lire comme une
 * phrase, pas comme un fragment.
 */
function nettoyerReste(valeur: string): string {
  return valeur
    .replace(/^(?:de\s+|d(?:'|’)|[àa]\s+|pour\s+|que\s+)/iu, '')
    .replace(/[.!?;,\s]+$/u, '')
    .trim();
}
