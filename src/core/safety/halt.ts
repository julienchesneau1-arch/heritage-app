/**
 * ARRÊT D'URGENCE — scénario doré **C2**, `CRITIQUE`.
 *
 *   > **Entrée :** « Jarvis, stop. »
 *   > **Attendu :** sorties interrompues, actions en attente annulées, actions
 *   > externes bloquées, **journal conservé**.
 *
 * CE N'EST PAS UN OUTIL, ET C'EST LA PREMIÈRE DÉCISION
 * -----------------------------------------------------
 * Un outil franchit le Policy Gate, qui peut le refuser. **Un arrêt d'urgence
 * que la politique peut refuser n'est pas un arrêt d'urgence** — et le cas où
 * l'on appuie sur le bouton est précisément celui où quelque chose ne va pas,
 * donc celui où la politique peut se comporter autrement qu'attendu.
 *
 * `engage()` est donc une primitive du noyau, appelable directement. Elle
 * n'échappe pas au journal pour autant : l'appelant l'y inscrit, et
 * `docs/05 §C2` exige que le journal soit **conservé**, pas alimenté.
 *
 * LA DISSYMÉTRIE EST DÉLIBÉRÉE
 * -----------------------------
 *   ENGAGER  va dans le sens sûr. Un modèle manipulé qui déclencherait un
 *            arrêt n'obtient qu'un Jarvis arrêté — bruyant, visible, sans
 *            dommage. On ne le contraint donc pas.
 *   LEVER    va dans le sens dangereux. C'est la seule opération qui rend à
 *            Jarvis sa capacité d'agir, et elle exige une décision humaine
 *            EXPLICITE (`releasedBy: 'USER'` refusé à tout autre acteur).
 *
 * Sans cette dissymétrie, une injection indirecte pourrait enchaîner
 * arrêt → levée et n'aurait fait que du bruit. Avec elle, la levée est un
 * point de contrôle humain qu'aucun contenu externe ne franchit.
 *
 * CE QU'UN ARRÊT NE PEUT PAS FAIRE, ET QUI EST ÉCRIT PLUTÔT QUE TU
 * -----------------------------------------------------------------
 * Il n'annule **pas** une requête déjà partie. `docs/26 §5` l'établit comme
 * irréductible : rien dans la pile ne l'offre — ni `withTimeout`, ni le bail,
 * ni le cloisonnement. Une opération déjà `COMMITTED_TO_EXECUTION` a peut-être
 * produit son effet, et un arrêt qui prétendrait l'effacer mentirait.
 *
 * `docs/05 §C2` dit « actions **en attente** annulées » — pas « en vol ». Le
 * document et la limite disent la même chose, et c'est heureux.
 */
import type { Db } from '../db/client.js';
import type { Actor } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

/** L'état courant, tel qu'il est DÉRIVÉ de l'histoire des arrêts. */
export interface HaltState {
  readonly halted: boolean;
  /** Renseignés si et seulement si `halted` est vrai. */
  readonly since?: string;
  readonly by?: Actor;
  readonly reason?: string;
}

export interface EngageResult {
  readonly haltId: string;
  /**
   * Opérations annulées parce qu'elles n'avaient pas encore été engagées.
   *
   * ⚠ Ne compte QUE ce qui n'était pas parti. Une opération déjà
   * `COMMITTED_TO_EXECUTION` reste telle quelle : son effet existe peut-être,
   * et l'annuler dans le journal serait effacer la seule trace qu'une requête
   * est partie (`docs/26 §5`).
   */
  readonly cancelledPending: number;
  /**
   * Opérations laissées EN L'ÉTAT parce qu'elles étaient déjà engagées.
   *
   * Rendu séparément, et jamais fondu dans le précédent : c'est exactement ce
   * que l'utilisateur doit savoir après avoir dit « stop ».
   */
  readonly inFlightUntouched: number;
}

interface HaltRow {
  id: string;
  engaged_at: Date;
  engaged_by: string;
  reason: string;
}

export interface EmergencyHalt {
  state(): Promise<Result<HaltState>>;
  engage(by: Actor, reason: string): Promise<Result<EngageResult>>;
  release(by: Actor, note: string): Promise<Result<void>>;
}

export function createEmergencyHalt(db: Db): EmergencyHalt {
  return {
    async state(): Promise<Result<HaltState>> {
      const rows = await db.query<HaltRow>(
        `SELECT id, engaged_at, engaged_by, reason
           FROM emergency_halt
          WHERE released_at IS NULL
          ORDER BY engaged_at DESC
          LIMIT 1`,
      );
      /* AUCUN REPLI SUR « PAS ARRÊTÉ ».

         Si la base ne répond pas, on ne SAIT pas si un arrêt est actif. Rendre
         `halted: false` transformerait une panne de lecture en autorisation
         d'agir — le mode de panne le plus coûteux qu'on puisse écrire ici.
         L'erreur remonte, et c'est l'appelant qui refuse (`gateway.ts`). */
      if (!rows.ok) return rows;

      const row = rows.value.rows[0];
      if (row === undefined) return ok({ halted: false });

      return ok({
        halted: true,
        since: row.engaged_at.toISOString(),
        by: row.engaged_by as Actor,
        reason: row.reason,
      });
    },

    async engage(by: Actor, reason: string): Promise<Result<EngageResult>> {
      if (reason.trim().length === 0) {
        return err(
          jarvisError('VALIDATION', 'Un arrêt d’urgence doit porter un motif.'),
        );
      }

      return db.transaction(async (tx) => {
        /* IDEMPOTENT PAR CONSTRUCTION, et il FAUT qu'il le soit.

           « Jarvis, stop » répété trois fois par quelqu'un qui panique ne doit
           pas échouer sur une violation d'unicité. L'index partiel unique en
           base garantit qu'il n'y a qu'un arrêt actif ; ici on rend celui qui
           existe déjà plutôt que d'en tenter un second. */
        const existant = await tx.query<{ id: string }>(
          'SELECT id FROM emergency_halt WHERE released_at IS NULL LIMIT 1',
        );
        if (!existant.ok) return existant;

        let haltId = existant.value.rows[0]?.id;
        if (haltId === undefined) {
          const inséré = await tx.query<{ id: string }>(
            `INSERT INTO emergency_halt (engaged_by, reason)
             VALUES ($1, $2) RETURNING id`,
            [by, reason],
          );
          if (!inséré.ok) return inséré;
          haltId = inséré.value.rows[0]?.id;
          if (haltId === undefined) {
            return err(jarvisError('INTERNAL', 'Arrêt non inscrit.'));
          }
        }

        /* ANNULATION DES ACTIONS EN ATTENTE.

           ⚠ L'ÉTAT S'APPELLE `PLANNED`, PAS `PENDING`, ET J'AVAIS SUPPOSÉ LE
             SECOND. Une hypothèse non vérifiée ici n'aurait annulé
             strictement RIEN — l'`UPDATE` aurait trouvé zéro ligne, le test
             nominal serait passé, et l'arrêt d'urgence n'aurait annulé aucune
             action en attente sans que rien ne le signale.

           `PLANNED` est le seul état où rien n'est parti. Dès
           `COMMITTED_TO_EXECUTION`, l'appel a pu franchir la frontière de la
           machine, et le marquer terminal réécrirait le passé — le motif que
           ce dépôt traque partout ailleurs.

           `status` est renseigné en même temps que `observed_at` : la
           contrainte `terminal_states_are_observed` lie l'un à l'autre, et
           `verdict_only_when_observed` interdit un verdict sans observation.
           On dit donc `FAILED` — l'action n'a pas eu lieu, et on le SAIT,
           puisqu'elle n'était pas partie. C'est le seul endroit du dépôt où
           `FAILED` s'écrit sans vérification, et il est légitime : l'absence
           d'effet est établie par l'état, pas par une observation du monde. */
        const annulées = await tx.query<{ operation_id: string }>(
          `UPDATE tool_operations
              SET state = 'FAILED',
                  status = 'FAILED',
                  observed_at = clock_timestamp(),
                  recovery_detail = 'annulée par arrêt d’urgence (docs/05 §C2)'
            WHERE state = 'PLANNED'
            RETURNING operation_id`,
        );
        if (!annulées.ok) return annulées;

        const enVol = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM tool_operations
            WHERE state IN ('COMMITTED_TO_EXECUTION','EXECUTING')`,
        );
        if (!enVol.ok) return enVol;

        return ok({
          haltId,
          cancelledPending: annulées.value.rows.length,
          inFlightUntouched: Number(enVol.value.rows[0]?.n ?? '0'),
        });
      });
    },

    async release(by: Actor, note: string): Promise<Result<void>> {
      /* LA SEULE OPÉRATION QUI REND À JARVIS SA CAPACITÉ D'AGIR.

         Elle exige un humain, littéralement. Un `AUTOMATION` qui lèverait un
         arrêt annulerait tout l'intérêt du bouton : ce qui a déclenché l'arrêt
         pourrait le lever. Et `docs/03 §3` est explicite — une sortie de LLM
         n'est jamais une autorisation. */
      if (by !== 'USER') {
        return err(
          jarvisError(
            'POLICY_DENIED',
            `Seul l’utilisateur peut lever un arrêt d’urgence (acteur reçu : ${by}). ` +
              'Ce qui a déclenché l’arrêt ne peut pas le lever.',
          ),
        );
      }
      if (note.trim().length === 0) {
        return err(
          jarvisError('VALIDATION', 'La levée d’un arrêt doit porter une note.'),
        );
      }

      const levé = await db.query<{ id: string }>(
        `UPDATE emergency_halt
            SET released_at = now(), released_by = $1
          WHERE released_at IS NULL
          RETURNING id`,
        [by],
      );
      if (!levé.ok) return levé;

      /* LEVER UN ARRÊT QUI N'EXISTE PAS EST UNE ERREUR, PAS UN SUCCÈS SILENCIEUX.

         Rendre `ok` laisserait croire qu'on vient de rétablir quelque chose.
         L'utilisateur doit savoir que Jarvis n'était pas arrêté — sinon il
         repart en croyant avoir agi. */
      if (levé.value.rows.length === 0) {
        return err(
          jarvisError('NOT_FOUND', 'Aucun arrêt d’urgence actif à lever.'),
        );
      }
      return ok(undefined);
    },
  };
}
