/**
 * LA FILE D'ATTENTE DE CONFIRMATIONS — le téléphone prépare, la machine décide.
 *
 * Référence : ADR-099, `docs/26 §4.18`. Renverse une partie d'ADR-023.
 *
 * LE PROBLÈME
 * ---------------------------------------------------------------------------
 * ADR-090 refuse toute action `L3`/`L4` venue d'une surface distante, et le
 * motif est juste : *qui détient le jeton peut se confirmer à lui-même*. Une
 * confirmation renvoyée par le même canal que la demande n'est pas un second
 * facteur, c'est un second appel HTTP.
 *
 * Conséquence mesurée : **dix-huit capacités sur vingt-et-une** répondent depuis
 * le téléphone. Les trois qui manquent sont les suppressions définitives.
 *
 * LA RÉPONSE
 * ---------------------------------------------------------------------------
 * ```text
 * jeton détenu           → droit de METTRE EN FILE
 * présence à la machine  → droit d'EXÉCUTER
 * ```
 *
 * C'est exactement le second facteur qu'ADR-090 constatait manquant. Un
 * attaquant qui détient le jeton peut remplir cette file ; il ne peut pas se
 * tenir devant l'ordinateur de Julien.
 *
 * ⚠⚠ UNE LIGNE DE CETTE FILE N'EST PAS UNE AUTORISATION
 * ---------------------------------------------------------------------------
 * **C'est la propriété qui rend tout l'édifice sûr**, et elle est
 * architecturale plutôt qu'écrite dans un commentaire :
 *
 *     ce module STOCKE une intention. Il n'en exécute aucune, et il n'a aucun
 *     moyen d'en exécuter une.
 *
 * `confirmer()` ne touche à aucun outil. Elle marque une ligne et rend son
 * contenu. C'est l'appelant — sur la surface LOCALE — qui rejoue la chaîne
 * complète, Policy Gate compris. Une action refusée par une politique Cedar
 * sera refusée **de nouveau**.
 *
 * Sans cette séparation, la file deviendrait un contournement de politique : il
 * suffirait d'y écrire une ligne pour obtenir demain ce qui est interdit
 * aujourd'hui. C'est pour la même raison que seuls les refus portant
 * `motif: 'SURFACE_DISTANTE'` peuvent y entrer — la distinction est faite sur
 * un champ typé, jamais sur une phrase française.
 *
 * ⚠ CE QUI EST RENVERSÉ D'ADR-023, ET CE QUI NE L'EST PAS
 * ---------------------------------------------------------------------------
 * ADR-023 a refusé l'état de confirmation : *« aucune session à stocker, donc
 * aucune session à détourner »*. Le motif reste juste, et il ne s'applique pas
 * ici :
 *
 * ```text
 * une SESSION porte une IDENTITÉ  — la détourner, c'est devenir quelqu'un
 * une INTENTION porte un ACTE     — la détourner, c'est obtenir CET acte,
 *                                   et seulement après qu'un humain l'a
 *                                   approuvé devant la machine
 * ```
 *
 * Ce qui est renversé est plus étroit qu'il n'y paraît : la confirmation n'est
 * plus *toujours* sans état. Elle l'est encore sur la surface locale ; elle
 * devient différée quand la demande vient d'ailleurs.
 */
import { z } from 'zod';
import { Provenance, Surface } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { Db } from '../db/client.js';

/**
 * Combien de temps une intention reste approuvable.
 *
 * ⚠ C'EST UN CHOIX, et il est écrit comme tel plutôt qu'enfoui.
 *
 * Trente minutes : le temps de poser son téléphone et de rejoindre son bureau.
 * Au-delà, une demande ne décrit plus l'état d'esprit de personne — l'approuver
 * reviendrait à exécuter ce que quelqu'un voulait il y a longtemps, sur une base
 * qui a changé depuis.
 *
 * Rien ne l'établit par le calcul. Ce qui est établi, c'est qu'un délai doit
 * exister. Condition de révision : le premier usage réel où trente minutes
 * s'avèrent trop courtes — ou trop longues.
 */
export const MINUTES_AVANT_EXPIRATION = 30;

/**
 * CE QUE LA FILE PORTE — ADR-105.
 *
 * ⚠ LA FILE NE GAGNE AUCUN POUVOIR D'EXÉCUTION EN GAGNANT CE CHAMP. Elle ne
 * sait toujours rien exécuter ; elle sait désormais **à qui rendre** ce
 * qu'elle garde.
 *
 * ```text
 * OUTIL       l'appelant rejoue gateway.invoke
 * ANNULATION  l'appelant rejoue undo.undoOperation
 * ```
 *
 * L'autre option était de donner à ce module une étape « marquer la capture
 * annulée » après exécution. C'est précisément ce qu'on refuse : sa sûreté
 * vient de ce qu'il n'a **aucun moyen** d'exécuter quoi que ce soit, et un
 * test le vérifie par l'absence d'import.
 */
export const GenreDIntention = z.enum(['OUTIL', 'ANNULATION']);
export type GenreDIntention = z.infer<typeof GenreDIntention>;

export const DemandeEnAttente = z.object({
  /**
   * ⚠ POUR UNE `ANNULATION`, C'EST L'OPÉRATION À DÉFAIRE.
   *
   * Et c'est ce qui rend la confirmation différée sûre : la file porte une
   * opération **nommée**, jamais « la dernière ». « La dernière » change avec
   * le temps — entre la demande sur le téléphone et la confirmation devant la
   * machine, une autre action peut avoir eu lieu, et on défferait alors autre
   * chose que ce qui a été montré à l'écran.
   */
  operationId: z.string().min(1),
  genre: GenreDIntention,
  toolId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  /**
   * ⚠ `Provenance`, PAS `z.string()`.
   *
   * La première rédaction relisait la provenance comme du texte, et l'appelant
   * la remettait en forme par `as Record<string, Provenance>` — un `as` sur une
   * frontière, ce que `CLAUDE.md` appelle un défaut sans nuance.
   *
   * Ce n'est pas du purisme : le Policy Gate DURCIT sur la provenance. Une
   * valeur illisible relue comme fiable ferait disparaître le durcissement au
   * moment précis où il compte — la confirmation d'une action irréversible.
   */
  provenance: z.record(z.string(), Provenance),
  /** Ce que l'utilisateur LIRA. Déjà passé par `libelleSur` (ADR-096). */
  resume: z.string().min(1),
  demandeeDe: Surface,
});
export type DemandeEnAttente = z.infer<typeof DemandeEnAttente>;

export interface EnAttente extends DemandeEnAttente {
  readonly id: string;
  /** Rendue pour l'affichage : « il te reste 22 minutes ». */
  readonly minutesRestantes: number;
}

const Ligne = z.object({
  id: z.string().min(1),
  operation_id: z.string().min(1),
  genre: GenreDIntention,
  tool_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), Provenance),
  resume: z.string().min(1),
  demandee_de: Surface,
  minutes_restantes: z.number(),
});

export interface FileDeConfirmations {
  /**
   * Enregistre une intention. **N'accorde rien.**
   *
   * Idempotent par `operationId` (ADR-030) : un client qui renvoie la même
   * demande après une coupure ne crée pas deux lignes.
   */
  mettreEnFile(demande: DemandeEnAttente): Promise<Result<EnAttente>>;

  /** Ce qui attend, non résolu et non expiré. L'horloge est celle de la BASE. */
  enAttente(): Promise<Result<readonly EnAttente[]>>;

  /**
   * Marque une intention approuvée et rend son contenu.
   *
   * ⚠ N'EXÉCUTE RIEN. L'appelant rejoue la chaîne complète — c'est ce qui
   * empêche cette file de devenir un contournement de politique.
   */
  confirmer(id: string): Promise<Result<EnAttente>>;

  /** Marque une intention refusée. */
  refuser(id: string): Promise<Result<boolean>>;
}

/**
 * Les colonnes lues, et le calcul du temps restant.
 *
 * `clock_timestamp()` et non la primitive qui fige l'heure au début de la
 * transaction : ADR-036/037 veulent l'horloge de la BASE, et la même partout.
 */
/* ⚠ `::double precision` N'EST PAS DÉCORATIF, et la frontière l'a appris à mes
   dépens. `EXTRACT(EPOCH …) / 60` rend un `numeric`, que le pilote PostgreSQL
   remet en JavaScript sous forme de CHAÎNE — parce qu'un `numeric` peut
   dépasser la précision d'un nombre flottant, et que le pilote refuse de
   perdre des chiffres en silence.

   Zod a refusé la ligne, ce qui est exactement son travail : le défaut est mort
   à la frontière plutôt que d'afficher « il te reste [object] minutes ». Deux
   corrections étaient possibles — accepter une chaîne et la convertir en
   TypeScript, ou demander à la base le type qu'on veut. On demande à la base :
   une conversion côté client serait un second endroit où le type se décide. */
const COLONNES = `id::text AS id, operation_id, genre, tool_id, input, provenance,
       resume, demandee_de,
       GREATEST(0, EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) / 60)
         ::double precision AS minutes_restantes`;

function versEnAttente(brut: unknown): Result<EnAttente> {
  const lu = Ligne.safeParse(brut);
  if (!lu.success) {
    return err(
      jarvisError('INTERNAL', `ligne de file illisible : ${lu.error.message}`),
    );
  }
  return ok({
    id: lu.data.id,
    operationId: lu.data.operation_id,
    genre: lu.data.genre,
    toolId: lu.data.tool_id,
    input: lu.data.input,
    provenance: lu.data.provenance,
    resume: lu.data.resume,
    demandeeDe: lu.data.demandee_de,
    minutesRestantes: Math.floor(lu.data.minutes_restantes),
  });
}

export function createFileDeConfirmations(db: Db): FileDeConfirmations {
  return {
    async mettreEnFile(demande: DemandeEnAttente): Promise<Result<EnAttente>> {
      const valide = DemandeEnAttente.safeParse(demande);
      if (!valide.success) {
        return err(
          jarvisError('VALIDATION', `demande invalide : ${valide.error.message}`),
        );
      }

      /* L'ÉCHÉANCE EST CALCULÉE PAR LA BASE — ADR-036/037.
         La poser depuis Node ferait dépendre l'expiration d'une horloge qui
         n'est pas celle qui la relira. */
      const insere = await db.query(
        `INSERT INTO confirmations_en_attente
           (operation_id, genre, tool_id, input, provenance, resume, demandee_de, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7,
                 clock_timestamp() + make_interval(mins => $8::int))
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING ${COLONNES}`,
        [
          valide.data.operationId,
          valide.data.genre,
          valide.data.toolId,
          JSON.stringify(valide.data.input),
          JSON.stringify(valide.data.provenance),
          valide.data.resume,
          valide.data.demandeeDe,
          MINUTES_AVANT_EXPIRATION,
        ],
      );
      if (!insere.ok) return insere;

      const ligne = insere.value.rows[0];
      if (ligne !== undefined) return versEnAttente(ligne);

      /* REJEU : la clé existait déjà. On relit la ligne existante plutôt que
         d'échouer — c'est exactement ce que fait `note_create`, et pour la
         même raison : un client qui renvoie sa demande après une coupure fait
         ce qu'il faut. */
      const relu = await db.query(
        `SELECT ${COLONNES} FROM confirmations_en_attente WHERE operation_id = $1`,
        [valide.data.operationId],
      );
      if (!relu.ok) return relu;
      const existante = relu.value.rows[0];
      if (existante === undefined) {
        return err(jarvisError('INTERNAL', 'file : ligne introuvable après conflit'));
      }
      return versEnAttente(existante);
    },

    async enAttente(): Promise<Result<readonly EnAttente[]>> {
      /* NON RÉSOLUE **ET** NON EXPIRÉE. Omettre la seconde condition
         proposerait d'exécuter une intention périmée — et la proposer, c'est
         déjà inviter à l'approuver. */
      const rows = await db.query(
        `SELECT ${COLONNES} FROM confirmations_en_attente
          WHERE resolue_at IS NULL AND expires_at > clock_timestamp()
          ORDER BY created_at ASC`,
      );
      if (!rows.ok) return rows;

      const sortie: EnAttente[] = [];
      for (const ligne of rows.value.rows) {
        const lu = versEnAttente(ligne);
        if (!lu.ok) return lu;
        sortie.push(lu.value);
      }
      return ok(sortie);
    },

    async confirmer(id: string): Promise<Result<EnAttente>> {
      /* LA CONDITION D'EXPIRATION EST DANS LE `WHERE` DE L'ÉCRITURE.

         La vérifier d'abord puis écrire laisserait une fenêtre entre les deux :
         une intention pourrait expirer pendant qu'on décide. Ici, une ligne
         expirée n'est tout simplement pas mise à jour, et `rows[0]` est vide.

         Même discipline que `task_complete`, qui fusionne mutation et capture
         dans une seule instruction plutôt que de lire puis écrire. */
      const maj = await db.query(
        `UPDATE confirmations_en_attente
            SET resolue_at = clock_timestamp(), resolution = 'CONFIRMEE'
          WHERE id = $1::uuid
            AND resolue_at IS NULL
            AND expires_at > clock_timestamp()
          RETURNING ${COLONNES}`,
        [id],
      );
      if (!maj.ok) return maj;

      const ligne = maj.value.rows[0];
      if (ligne === undefined) {
        return err(
          jarvisError(
            'NOT_FOUND',
            'Cette demande n’attend plus : elle a expiré, ou elle a déjà été '
              + 'traitée. Refais-la si tu la veux toujours.',
          ),
        );
      }
      return versEnAttente(ligne);
    },

    async refuser(id: string): Promise<Result<boolean>> {
      /* Refuser une intention EXPIRÉE reste permis — elle n'a plus d'effet
         possible, et l'utilisateur doit pouvoir nettoyer sa file. C'est la
         seule asymétrie entre `confirmer` et `refuser`, et elle va dans le sens
         qui ne peut rien exécuter. */
      const maj = await db.query(
        `UPDATE confirmations_en_attente
            SET resolue_at = clock_timestamp(), resolution = 'REFUSEE'
          WHERE id = $1::uuid AND resolue_at IS NULL
          RETURNING id`,
        [id],
      );
      if (!maj.ok) return maj;
      return ok(maj.value.rows.length > 0);
    },
  };
}
