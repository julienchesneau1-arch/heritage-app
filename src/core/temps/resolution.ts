/**
 * RÉSOUDRE UNE DATE — et c'est la BASE qui calcule. ADR-077.
 *
 * ADR-036 et ADR-037 posent l'invariant : *toute fenêtre temporelle est
 * calculée par PostgreSQL, jamais par l'horloge du processus.* Ce module est
 * l'application de cet invariant au cas le plus visible du produit — la date
 * d'un rappel.
 *
 * `expression.ts` a reconnu « jeudi » sans savoir quel jour on est. Ici, on ne
 * reconnaît rien : on traduit une description symbolique en une requête, et on
 * lit ce que la base répond.
 *
 * AUCUNE INTERPOLATION, JAMAIS
 * ---------------------------------------------------------------------------
 * Une expression temporelle vient de l'utilisateur. `docs/03` traite toute
 * entrée comme hostile jusqu'à validation. Ici la validation est faite par le
 * TYPE : `ExpressionTemporelle` ne porte que des entiers bornés, et chacun part
 * en **paramètre** de requête. Le SQL est un littéral figé dans ce fichier.
 *
 * `make_interval(days => $1)` plutôt que `interval '$1 days'` : le second se
 * construit par concaténation, et une concaténation dans du SQL est une porte.
 */
import { z } from 'zod';
import { err, jarvisError, ok, type Result } from '../types/result.js';
import type { Db } from '../db/client.js';
import type { ExpressionTemporelle } from './expression.js';

/**
 * L'instant rendu par la base.
 *
 * `iso` est destiné aux outils (`remindAt`, `startsAt`) ; `humain` est destiné
 * à la CONFIRMATION, parce que `2026-08-20T09:00:00+02:00` ne se relit pas.
 * L'utilisateur doit pouvoir dire « non, pas jeudi » avant l'écriture, et il ne
 * le peut que s'il comprend ce qu'on lui montre.
 */
export interface InstantResolu {
  readonly iso: string;
  readonly humain: string;
}

const Ligne = z.object({
  iso: z.string().min(1),
  humain: z.string().min(1),
});

/**
 * Le SQL, un cas par forme d'expression.
 *
 * `clock_timestamp()` partout, et jamais la primitive qui fige l'heure au DÉBUT
 * DE LA TRANSACTION — celle-ci rendrait une date née vieille, qui décale le
 * rappel. Ici l'écart serait de quelques millisecondes ; l'uniformité vaut
 * mieux que l'exception justifiée au cas par cas.
 *
 * ⚠ Son nom ne s'écrit nulle part dans ce fichier, commentaires compris : le
 * test la cherche en texte brut, et un fichier qui ne la contient pas ne permet
 * à personne de la recopier depuis la ligne d'à côté.
 */
function requete(expr: ExpressionTemporelle): { sql: string; params: unknown[] } {
  const jour = "date_trunc('day', clock_timestamp())";

  switch (expr.base) {
    case 'AUJOURD_HUI':
      return {
        sql: `${jour} + make_interval(hours => $1::int, mins => $2::int)`,
        params: [expr.heure, expr.minute],
      };

    case 'DEMAIN':
      return {
        sql: `${jour} + make_interval(days => 1, hours => $1::int, mins => $2::int)`,
        params: [expr.heure, expr.minute],
      };

    case 'APRES_DEMAIN':
      return {
        sql: `${jour} + make_interval(days => 2, hours => $1::int, mins => $2::int)`,
        params: [expr.heure, expr.minute],
      };

    case 'DANS_N_JOURS':
      return {
        sql: `${jour} + make_interval(days => $1::int, hours => $2::int, mins => $3::int)`,
        params: [expr.jours, expr.heure, expr.minute],
      };

    case 'HEURE_SEULE': {
      /* LA PROCHAINE OCCURRENCE DE CETTE HEURE — aujourd'hui ou demain, et
         c'est la BASE qui tranche. Le calculer ici demanderait de savoir
         l'heure qu'il est, ce qu'ADR-036/037 interdisent.

         Même convention que `JOUR_SEMAINE` : jamais dans le passé. « Rappelle-moi
         à 9h » dit à 15 h désigne demain matin, pas ce matin — un rappel qui
         serait refusé pour une raison que l'utilisateur ne comprendrait pas. */
      const cible = `${jour} + make_interval(hours => $1::int, mins => $2::int)`;
      return {
        sql:
          `CASE WHEN ${cible} > clock_timestamp() THEN ${cible} ` +
          `ELSE ${cible} + interval '1 day' END`,
        params: [expr.heure, expr.minute],
      };
    }

    case 'DANS_N_HEURES':
      return {
        sql: 'clock_timestamp() + make_interval(hours => $1::int)',
        params: [expr.heures],
      };

    case 'DANS_N_MINUTES':
      return {
        sql: 'clock_timestamp() + make_interval(mins => $1::int)',
        params: [expr.minutes],
      };

    case 'JOUR_SEMAINE':
      /* ⚠ LA PROCHAINE OCCURRENCE EST STRICTEMENT FUTURE, ET C'EST UN CHOIX.

         Dit un jeudi, « jeudi » désigne en français courant le jeudi SUIVANT,
         pas dans cinq minutes. La formule ne rend donc jamais 0 :

             ((cible - aujourd_hui + 6) mod 7) + 1   ∈ [1, 7]

         Le cas limite compte plus que la formule : « rappelle-moi jeudi » dit
         un jeudi à 15 h ne doit pas poser un rappel pour 9 h le matin même,
         c'est-à-dire dans le PASSÉ. `reminder_create` refuserait, et
         l'utilisateur ne comprendrait pas pourquoi. */
      return {
        sql:
          `${jour} + make_interval(` +
          `days => (((($1::int - EXTRACT(ISODOW FROM clock_timestamp())::int) + 6) % 7) + 1), ` +
          `hours => $2::int, mins => $3::int)`,
        params: [expr.jourSemaine, expr.heure, expr.minute],
      };
  }
}

/**
 * UNE FENÊTRE DE JOURS — ADR-097.
 *
 * `calendar_read` ne prend pas un instant mais deux bornes. « Qu'ai-je demain »
 * ne désigne pas 9 h : il désigne **la journée entière**.
 *
 * ⚠ LES DEUX BORNES VIENNENT DU MÊME CALCUL, dans la même requête — exactement
 * pour la raison qui fait déjà venir `iso` et `humain` ensemble. Deux requêtes
 * séparées à minuit moins une seconde encadreraient DEUX JOURS DIFFÉRENTS, et
 * l'agenda affiché ne serait celui d'aucune journée réelle. ADR-041, sur un
 * intervalle de quelques millisecondes.
 *
 * ⚠ ET C'EST LA BASE QUI AJOUTE LE JOUR, PAS NOUS. `+ 24 heures` en TypeScript
 * serait faux deux fois par an : au changement d'heure, une journée dure 23 ou
 * 25 heures. `+ interval '1 day'` connaît les fuseaux ; l'arithmétique en
 * millisecondes ne les connaît pas.
 */
export interface FenetreResolue {
  readonly debutIso: string;
  readonly finIso: string;
  /** La phrase que l'utilisateur relit — « jeudi 20 août ». */
  readonly humain: string;
}

const LigneFenetre = z.object({
  debut: z.string().min(1),
  fin: z.string().min(1),
  humain: z.string().min(1),
});

export interface ResolveurTemporel {
  resoudre(expr: ExpressionTemporelle): Promise<Result<InstantResolu>>;
  /**
   * La fenêtre qui COUVRE le jour désigné, sur `jours` journées.
   *
   * L'expression est ramenée au début de journée quoi qu'elle porte : « qu'ai-je
   * jeudi à 14 h » demande l'agenda de jeudi, pas celui de 14 h à 14 h.
   */
  resoudreFenetre(
    expr: ExpressionTemporelle,
    jours: number,
  ): Promise<Result<FenetreResolue>>;
}

export function createResolveurTemporel(db: Db): ResolveurTemporel {
  return {
    async resoudre(expr: ExpressionTemporelle): Promise<Result<InstantResolu>> {
      const { sql, params } = requete(expr);

      /* Les DEUX formes viennent du MÊME calcul, dans la même requête.
         Les demander séparément laisserait un instant s'écouler entre les deux
         — et à minuit moins une seconde, l'affichage et la valeur écrite
         désigneraient deux jours différents. ADR-041 : deux registres du même
         fait finissent par diverger. */
      const lu = await db.query<{ iso: string; humain: string }>(
        /* ⚠ LES NOMS FRANÇAIS SONT ÉCRITS ICI, PAS DEMANDÉS À LA LOCALE.

           La première version employait `TMDay` / `TMMonth`, qui suivent le
           `lc_time` de la base. Mesuré : elle rendait « Wednesday 19 August ».
           La phrase que l'utilisateur doit relire AVANT d'écrire un rappel
           s'affichait donc en anglais — et elle se serait affichée
           différemment sur sa machine et sur la mienne, sans que rien ne le
           signale.

           Un produit français ne délègue pas ses mots à une variable
           d'environnement. Le tableau est explicite, donc identique partout. */
        /* ⚠ `iso` EN UTC AVEC « Z », ET C'EST LA FRONTIÈRE QUI L'A EXIGÉ.

           La première version rendait un décalage — `…+00:00`. `reminder_create`
           valide son entrée par `z.string().datetime()`, dont le défaut REFUSE
           les décalages : l'outil répondait « Entrée invalide », sans que rien
           n'indique pourquoi.

           C'est exactement le rôle que ADR-016 donne à la validation de
           frontière, et elle a joué : le défaut est mort à l'entrée de l'outil
           plutôt que d'écrire un rappel à une heure fausse.

           `humain` reste en heure LOCALE : c'est la phrase que l'utilisateur
           relit. Les deux formes désignent le même instant `t`. */
        `SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso,
                (ARRAY['lundi','mardi','mercredi','jeudi','vendredi','samedi',
                       'dimanche'])[EXTRACT(ISODOW FROM t)::int]
                || ' ' || to_char(t, 'FMDD') || ' ' ||
                (ARRAY['janvier','février','mars','avril','mai','juin','juillet',
                       'août','septembre','octobre','novembre','décembre'
                      ])[EXTRACT(MONTH FROM t)::int]
                || ' à ' || to_char(t, 'HH24:MI') AS humain
           FROM (SELECT ${sql} AS t) AS calcul`,
        params,
      );
      if (!lu.ok) return lu;

      const brut = lu.value.rows[0];
      if (brut === undefined) {
        return err(jarvisError('INTERNAL', 'la base n’a rendu aucune date'));
      }

      /* Validation à la frontière, même si la source est notre propre base :
         ADR-016 en fait une règle sans exception, et `to_char` peut rendre une
         chaîne vide sur une entrée inattendue. */
      const valide = Ligne.safeParse(brut);
      if (!valide.success) {
        return err(jarvisError('INTERNAL', `date illisible : ${valide.error.message}`));
      }

      return ok({ iso: valide.data.iso, humain: valide.data.humain });
    },

    async resoudreFenetre(
      expr: ExpressionTemporelle,
      jours: number,
    ): Promise<Result<FenetreResolue>> {
      /* Une fenêtre de zéro jour ou moins ne couvre rien : `calendar_read`
         rendrait une liste vide en laissant croire que l'agenda l'est. */
      if (!Number.isInteger(jours) || jours < 1) {
        return err(jarvisError('VALIDATION', `fenêtre invalide : ${String(jours)} jour(s)`));
      }

      /* L'HEURE EST ÉCRASÉE À ZÉRO, dans l'expression et pas après coup.
         `date_trunc` en SQL le ferait aussi — mais réutiliser `requete()` tel
         quel garde UN seul endroit qui sait traduire chaque forme
         d'expression. Deux traducteurs finiraient par diverger sur la forme
         ajoutée l'année prochaine. */
      const auJour: ExpressionTemporelle =
        'heure' in expr ? { ...expr, heure: 0, minute: 0 } : expr;
      const { sql, params } = requete(auJour);

      const lu = await db.query<{ debut: string; fin: string; humain: string }>(
        `SELECT to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS debut,
                to_char((d + make_interval(days => $${String(params.length + 1)}::int))
                        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fin,
                (ARRAY['lundi','mardi','mercredi','jeudi','vendredi','samedi',
                       'dimanche'])[EXTRACT(ISODOW FROM d)::int]
                || ' ' || to_char(d, 'FMDD') || ' ' ||
                (ARRAY['janvier','février','mars','avril','mai','juin','juillet',
                       'août','septembre','octobre','novembre','décembre'
                      ])[EXTRACT(MONTH FROM d)::int] AS humain
           FROM (SELECT date_trunc('day', ${sql}) AS d) AS calcul`,
        [...params, jours],
      );
      if (!lu.ok) return lu;

      const brut = lu.value.rows[0];
      if (brut === undefined) {
        return err(jarvisError('INTERNAL', 'la base n’a rendu aucune fenêtre'));
      }
      const valide = LigneFenetre.safeParse(brut);
      if (!valide.success) {
        return err(jarvisError('INTERNAL', `fenêtre illisible : ${valide.error.message}`));
      }

      return ok({
        debutIso: valide.data.debut,
        finIso: valide.data.fin,
        humain:
          jours === 1
            ? valide.data.humain
            : `${valide.data.humain}, sur ${String(jours)} jours`,
      });
    },
  };
}
