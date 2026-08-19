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
      return { sql: `${jour} + make_interval(hours => $1::int)`, params: [expr.heure] };

    case 'DEMAIN':
      return {
        sql: `${jour} + make_interval(days => 1, hours => $1::int)`,
        params: [expr.heure],
      };

    case 'APRES_DEMAIN':
      return {
        sql: `${jour} + make_interval(days => 2, hours => $1::int)`,
        params: [expr.heure],
      };

    case 'DANS_N_JOURS':
      return {
        sql: `${jour} + make_interval(days => $1::int, hours => $2::int)`,
        params: [expr.jours, expr.heure],
      };

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
          `hours => $2::int)`,
        params: [expr.jourSemaine, expr.heure],
      };
  }
}

export interface ResolveurTemporel {
  resoudre(expr: ExpressionTemporelle): Promise<Result<InstantResolu>>;
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
  };
}
