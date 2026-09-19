/**
 * LE MODE PRIVÉ — « cloud OFF, réseau externe OFF, indicateur visible ».
 *
 * ADR-106. Livrable de la Phase 4 (`docs/02`), règle de `docs/03 §7`.
 *
 * ⚠ LA RÈGLE EXISTAIT, PERSONNE NE POUVAIT L'ATTEINDRE
 * ---------------------------------------------------------------------------
 * `gate.ts` refuse toute égression quand `context.mode === 'PRIVATE'`. C'est
 * écrit, testé, et **rien ne posait jamais ce mode** : les deux surfaces
 * envoyaient `NORMAL`.
 *
 *     Un régime de confidentialité qu'aucune phrase n'active n'est pas un
 *     régime. C'est une branche de code.
 *
 * Troisième fois de ce chantier (ADR-104 pour l'arrêt d'urgence, ADR-105 pour
 * l'annulation) : le mécanisme est complet, et le chemin qui y mène n'existe
 * pas.
 *
 * ⚠ LA DISSYMÉTRIE EST REPRISE D'`halt.ts`, ET POUR LA MÊME RAISON
 * ---------------------------------------------------------------------------
 * ```text
 * ACTIVER      va dans le sens sûr. Au pire Jarvis refuse de sortir — bruyant,
 *              visible, réparable. Aucune contrainte ajoutée.
 * DÉSACTIVER   va dans le sens dangereux : c'est la seule opération qui rend à
 *              Jarvis le droit de parler à l'extérieur.
 * ```
 *
 * Sans elle, quelqu'un qui détiendrait le jeton du téléphone pourrait
 * **désactiver le mode privé à distance**, puis faire sortir ce qu'il veut. La
 * levée est donc réservée à la surface locale — c'est l'appelant qui la tient,
 * exactement comme `/confirmer` (ADR-099) et `/reprendre` (ADR-104).
 *
 * ⚠ ET CE MODULE NE DÉCIDE RIEN
 * ---------------------------------------------------------------------------
 * Il ne refuse aucune égression. Il répond à une seule question — *le mode
 * privé est-il actif ?* — et c'est le Tool Gateway qui en tire les
 * conséquences, en durcissant le contexte AVANT le Policy Gate. La décision
 * reste là où elle a toujours été.
 */
import type { Db } from '../db/client.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

/** L'état courant, DÉRIVÉ de l'histoire des activations. */
export interface EtatModePrive {
  readonly actif: boolean;
  /** Renseignés si et seulement si `actif` est vrai. */
  readonly depuis?: string;
  readonly motif?: string;
}

export interface ModePrive {
  etat(): Promise<Result<EtatModePrive>>;
  /** Sens sûr : aucune contrainte de surface. */
  activer(motif: string): Promise<Result<EtatModePrive>>;
  /** Sens dangereux : l'appelant garantit la présence humaine locale. */
  lever(note: string): Promise<Result<void>>;
}

interface Ligne {
  active_at: Date;
  motif: string;
}

export function createModePrive(db: Db): ModePrive {
  return {
    async etat(): Promise<Result<EtatModePrive>> {
      const rows = await db.query<Ligne>(
        `SELECT active_at, motif FROM mode_prive
          WHERE levee_at IS NULL
          ORDER BY active_at DESC
          LIMIT 1`,
      );
      /* ⚠ AUCUN REPLI ICI — mais le repli de l'APPELANT est l'inverse de celui
         de l'arrêt d'urgence, et la différence est raisonnée.

         `halt.ts` refuse toute action quand son état est illisible : un arrêt
         inconnu affecte TOUT, donc refuser est la seule réponse sûre.

         Un mode privé inconnu n'affecte qu'une chose : le droit de SORTIR. La
         réponse sûre est donc de se croire privé — ça bloque l'égression et
         rien d'autre. Refuser toute action serait plus strict sans être plus
         sûr, et transformerait une panne de lecture en panne totale.

         Ce module rend quand même l'erreur : c'est au Gateway de choisir, et
         il le fait explicitement. */
      if (!rows.ok) return rows;

      const row = rows.value.rows[0];
      if (row === undefined) return ok({ actif: false });
      return ok({
        actif: true,
        depuis: row.active_at.toISOString(),
        motif: row.motif,
      });
    },

    async activer(motif: string): Promise<Result<EtatModePrive>> {
      if (motif.trim().length === 0) {
        return err(
          jarvisError('VALIDATION', 'Une activation du mode privé doit porter un motif.'),
        );
      }

      /* IDEMPOTENT PAR CONSTRUCTION, et il FAUT qu'il le soit.

         « Passe en mode privé » dit deux fois ne doit pas échouer sur une
         violation d'unicité — l'utilisateur qui répète n'est pas en faute, il
         n'est pas sûr. On rend l'état existant plutôt que d'en tenter un
         second. Même geste qu'`halt.engage`. */
      return db.transaction(async (tx) => {
        const existant = await tx.query<Ligne>(
          `SELECT active_at, motif FROM mode_prive
            WHERE levee_at IS NULL LIMIT 1`,
        );
        if (!existant.ok) return existant;

        const deja = existant.value.rows[0];
        if (deja !== undefined) {
          return ok({
            actif: true,
            depuis: deja.active_at.toISOString(),
            motif: deja.motif,
          });
        }

        const insere = await tx.query<Ligne>(
          `INSERT INTO mode_prive (active_par, motif) VALUES ($1, $2)
           RETURNING active_at, motif`,
          ['USER', motif],
        );
        if (!insere.ok) return insere;
        const ligne = insere.value.rows[0];
        if (ligne === undefined) {
          return err(jarvisError('INTERNAL', 'Mode privé non inscrit.'));
        }
        return ok({
          actif: true,
          depuis: ligne.active_at.toISOString(),
          motif: ligne.motif,
        });
      });
    },

    async lever(note: string): Promise<Result<void>> {
      if (note.trim().length === 0) {
        return err(
          jarvisError('VALIDATION', 'La levée du mode privé doit porter une note.'),
        );
      }

      const leve = await db.query<{ id: string }>(
        `UPDATE mode_prive
            SET levee_at = now(), levee_par = $1, levee_note = $2
          WHERE levee_at IS NULL
          RETURNING id`,
        ['USER', note],
      );
      if (!leve.ok) return leve;

      /* LEVER UN MODE QUI N'EST PAS ACTIF EST UNE ERREUR, PAS UN SUCCÈS MUET.

         Rendre `ok` laisserait croire qu'on vient de rétablir quelque chose.
         L'utilisateur doit savoir que Jarvis n'était PAS en mode privé —
         sinon il repart en croyant avoir agi, et il se trompe sur l'état de sa
         propre confidentialité. Même raison qu'`halt.release`. */
      if (leve.value.rows.length === 0) {
        return err(jarvisError('NOT_FOUND', 'Le mode privé n’est pas actif.'));
      }
      return ok(undefined);
    },
  };
}
