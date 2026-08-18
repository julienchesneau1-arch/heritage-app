import type { DataLevel } from '../types/domain.js';
/**
 * Event Ledger — écriture et vérification.
 *
 * Référence : ADR-012, 03 §2.
 *
 * L'immuabilité est garantie par la base (permissions + triggers, migration
 * 0002). Ce module garantit la propriété complémentaire : la **continuité** de
 * la chaîne. Une ligne supprimée ou réordonnée devient détectable même si
 * quelqu'un parvenait à contourner les deux premières barrières.
 */
import type { Db } from '../db/client.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import {
  computeHash,
  GENESIS_HASH,
  newEventId,
  NewEvent,
  SealedEvent,
  type PolicyDecision,
} from './event.js';

/**
 * Clé de verrou consultatif sérialisant les ajouts.
 *
 * Sans elle, deux transactions concurrentes liraient la même tête de chaîne et
 * produiraient deux événements avec le même `prevHash` : la chaîne
 * bifurquerait. Le verrou est transactionnel, donc relâché au COMMIT.
 */
const LEDGER_LOCK_KEY = 0x4a415256; // "JARV"

interface LedgerRow {
  event_id: string;
  occurred_at: Date;
  actor: string;
  event_type: string;
  intent: string | null;
  tool: string | null;
  policy_decision: string | null;
  autonomy_level: string | null;
  status: string;
  proof: string | null;
  model: string | null;
  cost_eur: string;
  operation_id: string | null;
  payload_digest: string;
  egress_destination: string | null;
  egress_data_level: string | null;
  egress_reason: string | null;
  prev_hash: string;
  hash: string;
}

function toSealed(row: LedgerRow): Result<SealedEvent> {
  const parsed = SealedEvent.safeParse({
    eventId: row.event_id,
    occurredAt: row.occurred_at.toISOString(),
    actor: row.actor,
    eventType: row.event_type,
    intent: row.intent,
    tool: row.tool,
    policyDecision: row.policy_decision,
    autonomyLevel: row.autonomy_level,
    status: row.status,
    proof: row.proof,
    model: row.model,
    costEur: Number(row.cost_eur),
    operationId: row.operation_id,
    payloadDigest: row.payload_digest,
    /* RECONSTITUÉ À LA RELECTURE, et ce n'est pas cosmétique : `verifyChain`
       recalcule le hachage à partir de ce qu'elle relit. Oublier ce champ
       ferait échouer la vérification de toute ligne portant une égression —
       une chaîne déclarée rompue alors qu'elle est intacte. */
    egress:
      row.egress_destination === null || row.egress_destination === undefined
        ? null
        : {
            destination: row.egress_destination,
            dataLevel: row.egress_data_level as DataLevel,
            reason: row.egress_reason ?? '',
          },
    prevHash: row.prev_hash,
    hash: row.hash,
  });
  if (!parsed.success) {
    return err(
      jarvisError('INTEGRITY', 'Ligne de journal illisible', {
        eventId: row.event_id,
      }),
    );
  }
  return ok(parsed.data);
}

export interface ChainReport {
  readonly valid: boolean;
  readonly checked: number;
  /** Renseigné uniquement si `valid` est faux. */
  readonly brokenAt?: { readonly eventId: string; readonly reason: string };
}

/** Une ligne du décompte de la journée : combien de fois ce couple est survenu. */
export interface DayTallyEntry {
  readonly eventType: string;
  readonly status: string;
  readonly count: number;
}

export interface DayTally {
  /** Le jour tel que LA BASE le voit, `YYYY-MM-DD`. */
  readonly day: string;
  readonly entries: readonly DayTallyEntry[];
  /** Le total, indépendant du détail — il ne peut pas être tronqué. */
  readonly total: number;
}

export interface Ledger {
  append(event: unknown): Promise<Result<SealedEvent>>;
  verifyChain(): Promise<Result<ChainReport>>;
  recent(limit?: number): Promise<Result<readonly SealedEvent[]>>;
  /**
   * Ce qui s'est passé AUJOURD'HUI — agrégé par la base, jamais par le
   * processus.
   *
   * POURQUOI CETTE MÉTHODE EXISTE — ADR-064
   * ----------------------------------------
   * `auditReport` répondait à « qu'as-tu fait aujourd'hui ? » en lisant
   * `recent(200)` puis en filtrant sur `new Date().toISOString().slice(0,10)`.
   * Deux défauts dans une seule ligne :
   *
   * **La fenêtre était calculée par le PROCESSUS.** C'est exactement ce
   * qu'ADR-036 et ADR-037 ont tranché : un appelant dont l'horloge dérive voit
   * « aujourd'hui » ailleurs qu'aujourd'hui. L'outil `audit_query` bornait déjà
   * par `date_trunc('day', clock_timestamp())` ; le rapport de l'application,
   * lui, ne l'avait jamais fait.
   *
   * **Le décompte était SILENCIEUSEMENT plafonné à 200.** Au-delà, la réponse
   * omettait des événements sans le dire. Un audit incomplet qui se présente
   * comme complet est pire qu'un audit absent : il rassure.
   *
   * L'agrégation est faite en SQL, donc le total ne dépend d'aucune limite de
   * lignes. On ne signale pas une troncature — on la rend impossible.
   */
  dayTally(): Promise<Result<DayTally>>;
  /**
   * L'événement qui porte l'ISSUE d'une opération — le DERNIER, pas le premier.
   *
   * Une opération n'a plus un seul événement depuis qu'I13 fait journaliser
   * l'appel lui-même (`…_REQUEST_SENT`, `docs/22 §10`). « Trouver l'événement
   * d'une opération » est donc devenu ambigu, et le premier — celui qui dit
   * « la requête part, l'issue est inconnue » — est précisément le moins
   * informatif.
   *
   * Qui pose cette question veut savoir CE QUI S'EST PASSÉ. On rend donc le
   * dernier maillon. La chaîne complète se lit par `verifyChain` ou
   * directement au journal.
   */
  findByOperationId(operationId: string): Promise<Result<SealedEvent | null>>;
}

export function createLedger(db: Db): Ledger {
  return {
    /**
     * Ajoute un événement. `event` est délibérément typé `unknown` : c'est une
     * frontière, elle est validée à l'exécution (ADR-016).
     */
    async append(event: unknown): Promise<Result<SealedEvent>> {
      const parsed = NewEvent.safeParse(event);
      if (!parsed.success) {
        return err(
          jarvisError('VALIDATION', 'Événement de journal invalide', {
            issues: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(' | '),
          }),
        );
      }
      const candidate = parsed.data;

      return db.transaction(async (tx) => {
        const locked = await tx.query('SELECT pg_advisory_xact_lock($1)', [
          LEDGER_LOCK_KEY,
        ]);
        if (!locked.ok) return locked;

        const head = await tx.query<{ hash: string }>(
          'SELECT hash FROM event_ledger ORDER BY seq DESC LIMIT 1',
        );
        if (!head.ok) return head;

        const prevHash = head.value.rows[0]?.hash ?? GENESIS_HASH;
        const eventId = newEventId();
        const occurredAt = new Date().toISOString();
        const hash = computeHash({ ...candidate, eventId, occurredAt }, prevHash);

        const inserted = await tx.query<LedgerRow>(
          `INSERT INTO event_ledger (
             event_id, occurred_at, actor, event_type, intent, tool,
             policy_decision, autonomy_level, status, proof, model, cost_eur,
             operation_id, payload_digest, prev_hash, hash,
             egress_destination, egress_data_level, egress_reason
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                     $17,$18,$19)
           RETURNING *`,
          [
            eventId,
            occurredAt,
            candidate.actor,
            candidate.eventType,
            candidate.intent,
            candidate.tool,
            candidate.policyDecision,
            candidate.autonomyLevel,
            candidate.status,
            candidate.proof,
            candidate.model,
            candidate.costEur,
            candidate.operationId,
            candidate.payloadDigest,
            prevHash,
            hash,
            /* Les trois vont ensemble ou pas du tout — la base impose la même
               règle (`egress_fields_together`). Une destination sans niveau
               serait une ligne d'audit qui pose une question au lieu d'y
               répondre. */
            candidate.egress?.destination ?? null,
            candidate.egress?.dataLevel ?? null,
            candidate.egress?.reason ?? null,
          ],
        );
        if (!inserted.ok) return inserted;

        const row = inserted.value.rows[0];
        if (row === undefined) {
          return err(jarvisError('INTERNAL', 'Insertion sans ligne retournée'));
        }
        return toSealed(row);
      });
    },

    /**
     * Recalcule la chaîne du début à la fin.
     *
     * Coûteux par construction : c'est une vérification d'intégrité, pas une
     * requête de lecture courante.
     */
    async verifyChain(): Promise<Result<ChainReport>> {
      const rows = await db.query<LedgerRow>(
        'SELECT * FROM event_ledger ORDER BY seq ASC',
      );
      if (!rows.ok) return rows;

      let expectedPrev = GENESIS_HASH;
      let checked = 0;

      for (const row of rows.value.rows) {
        const sealed = toSealed(row);
        if (!sealed.ok) return sealed;
        const e = sealed.value;

        if (e.prevHash !== expectedPrev) {
          return ok({
            valid: false,
            checked,
            brokenAt: {
              eventId: e.eventId,
              reason: `chaînage rompu : prev_hash attendu ${expectedPrev}, trouvé ${e.prevHash}`,
            },
          });
        }

        const recomputed = computeHash(e, e.prevHash);
        if (recomputed !== e.hash) {
          return ok({
            valid: false,
            checked,
            brokenAt: {
              eventId: e.eventId,
              reason: 'contenu altéré : le hash recalculé ne correspond pas',
            },
          });
        }

        expectedPrev = e.hash;
        checked += 1;
      }

      return ok({ valid: true, checked });
    },

    async dayTally(): Promise<Result<DayTally>> {
      /* TOUT EST CALCULÉ ICI : la borne du jour, le regroupement, le total.
         Rien ne remonte en JavaScript qui puisse dériver d'une horloge ou
         d'une limite de lignes. `to_char` rend le jour tel que la base le
         voit — c'est cette date-là qui fait autorité dans la réponse. */
      const rows = await db.query<{
        day: string;
        event_type: string;
        status: string;
        count: string;
      }>(
        `SELECT to_char(date_trunc('day', clock_timestamp()), 'YYYY-MM-DD') AS day,
                event_type, status, count(*)::text AS count
           FROM event_ledger
          WHERE occurred_at >= date_trunc('day', clock_timestamp())
            AND occurred_at <  date_trunc('day', clock_timestamp()) + interval '1 day'
          GROUP BY event_type, status
          ORDER BY event_type, status`,
      );
      if (!rows.ok) return rows;

      const entries = rows.value.rows.map((r) => ({
        eventType: r.event_type,
        status: r.status,
        count: Number(r.count),
      }));

      /* Le jour vient de la base même quand il n'y a AUCUN événement : sans
         lui, une journée vide obligerait à le recalculer en JavaScript, et le
         défaut reviendrait par la porte du cas limite. */
      const dayRow = rows.value.rows[0];
      let day = dayRow?.day;
      if (day === undefined) {
        const seul = await db.query<{ day: string }>(
          `SELECT to_char(date_trunc('day', clock_timestamp()), 'YYYY-MM-DD') AS day`,
        );
        if (!seul.ok) return seul;
        const ligne = seul.value.rows[0];
        if (ligne === undefined) {
          return err(jarvisError('INTERNAL', 'La base n’a pas rendu sa date du jour'));
        }
        day = ligne.day;
      }

      return ok({
        day,
        entries,
        total: entries.reduce((acc, e) => acc + e.count, 0),
      });
    },

    async recent(limit = 50): Promise<Result<readonly SealedEvent[]>> {
      const rows = await db.query<LedgerRow>(
        'SELECT * FROM event_ledger ORDER BY seq DESC LIMIT $1',
        [limit],
      );
      if (!rows.ok) return rows;

      const out: SealedEvent[] = [];
      for (const row of rows.value.rows) {
        const sealed = toSealed(row);
        if (!sealed.ok) return sealed;
        out.push(sealed.value);
      }
      return ok(out);
    },

    /** Support de l'idempotence : une opération déjà journalisée est retrouvable. */
    async findByOperationId(
      operationId: string,
    ): Promise<Result<SealedEvent | null>> {
      const rows = await db.query<LedgerRow>(
        'SELECT * FROM event_ledger WHERE operation_id = $1 ORDER BY seq DESC LIMIT 1',
        [operationId],
      );
      if (!rows.ok) return rows;
      const row = rows.value.rows[0];
      if (row === undefined) return ok(null);
      return toSealed(row);
    },
  };
}

export type { PolicyDecision, SealedEvent };
