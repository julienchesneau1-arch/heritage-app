/**
 * `audit_query` — « Qu'as-tu fait aujourd'hui ? »
 *
 * Scénario doré **A9**, porte de sortie Phase 3, et la promesse centrale de
 * `docs/12`. L'exigence tient en une clause, et c'est toute la difficulté :
 *
 *   > réponse construite **depuis l'Event Ledger**.
 *   > **Interdit :** réponse reconstruite par le modèle de mémoire.
 *
 * POURQUOI CETTE DISTINCTION EST LA SEULE QUI COMPTE
 * ---------------------------------------------------
 * Un système qui raconte ses actions depuis sa mémoire raconte ce qu'il CROIT
 * avoir fait. Un système qui les lit dans un journal append-only et chaîné
 * rapporte ce qui a ÉTÉ ÉCRIT au moment où ça s'est produit.
 *
 * L'écart entre les deux est exactement l'espace où un audit devient inutile :
 * si la source peut être révisée après coup, elle ne prouve rien. Le journal
 * ne peut pas l'être — c'est sa seule raison d'exister.
 *
 * CE QUE CET OUTIL N'A PAS LE DROIT DE FAIRE
 * -------------------------------------------
 *   ✗ interroger la mémoire, les notes, les tâches
 *   ✗ demander à un modèle de résumer
 *   ✗ compléter un trou du journal par une déduction
 *
 * Un trou dans le journal se RAPPORTE. Il ne se comble pas.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { ok, type Result } from '../core/types/result.js';

const AuditQueryInput = z.object({
  /**
   * Fenêtre demandée. Bornée : un audit qui balaie tout le journal à chaque
   * question deviendrait inutilisable le jour où il compte.
   */
  window: z.enum(['today', 'week', 'month']).default('today'),
  limit: z.number().int().min(1).max(200).default(50),
});

interface LedgerRow {
  occurred_at: Date;
  event_type: string;
  tool: string | null;
  actor: string;
  status: string;
  policy_decision: string | null;
  autonomy_level: string | null;
  operation_id: string | null;
}

/** Ce que l'audit rapporte pour un événement. Aucune interprétation. */
export interface AuditEntry {
  readonly occurredAt: string;
  readonly eventType: string;
  readonly tool: string | null;
  readonly actor: string;
  readonly status: string;
  readonly policyDecision: string | null;
  readonly operationId: string | null;
}

export function createAuditQueryTool(): RegisteredTool {
  return defineTool<z.infer<typeof AuditQueryInput>>({
    definition: {
      id: 'audit_query',
      version: '1.0.0',
      description: "Répondre à « qu'as-tu fait ? » depuis le journal d'audit.",
      /* L1 : une lecture ne demande pas de confirmation, mais elle n'est pas
         anodine non plus — le journal décrit tout ce que Jarvis a fait. */
      autonomy: 'L1',
      /* ORANGE et non GREEN. Le journal ne contient aucune charge utile — que
         des empreintes — mais l'ENCHAÎNEMENT des actions est en soi une
         information sur la vie de l'utilisateur. Classer GREEN reviendrait à
         dire que la liste de ce qu'on a fait ne dit rien de soi. */
      privacyClass: 'ORANGE',
      /* `false`, et le validateur de contrat me l'a appris — il refuse un
         outil qui se déclare réversible sans décrire comment défaire.

         Le nom prête à confusion pour une lecture : ce n'est pas « on ne peut
         pas revenir en arrière », c'est « il n'y a RIEN à défaire ». Déclarer
         `true` promettrait une procédure d'annulation qui ne peut pas exister,
         et le contrat exigerait qu'on l'écrive. Même valeur que `task_list`,
         pour la même raison. */
      reversible: false,
      networkRequired: false,
      parameters: [
        { name: 'window', sensitive: false },
        { name: 'limit', sensitive: false },
      ],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 5_000,
      maxRetries: 2,
      auditEvent: 'AUDIT_QUERIED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      /* Une lecture ne change rien, nulle part. C'est le seul outil du dépôt
         qui peut honnêtement le déclarer. */
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: AuditQueryInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* LA LECTURE SE FAIT DIRECTEMENT SUR `event_ledger`, ET NULLE PART
         AILLEURS. Pas de jointure vers `tool_operations`, pas de mémoire, pas
         de résumé. Le registre est mutable et ne garde que le dernier état ;
         le journal est la seule source qui ne peut pas être révisée.

         La fenêtre est calculée PAR LA BASE — `date_trunc(… clock_timestamp())`
         — et non par le processus : la leçon d'ADR-037. Un appelant dont
         l'horloge dérive verrait sinon « aujourd'hui » ailleurs qu'aujourd'hui,
         et un audit qui montre le mauvais jour est pire qu'un audit absent. */
      const rows = await ctx.db.query<LedgerRow>(
        `SELECT occurred_at, event_type, tool, actor, status,
                policy_decision, autonomy_level, operation_id
           FROM event_ledger
          WHERE occurred_at >= date_trunc($1, clock_timestamp())
          ORDER BY seq DESC
          LIMIT $2`,
        [input.window === 'today' ? 'day' : input.window, String(input.limit)],
      );
      if (!rows.ok) return rows;

      const entries: AuditEntry[] = rows.value.rows.map((r) => ({
        occurredAt: r.occurred_at.toISOString(),
        eventType: r.event_type,
        tool: r.tool,
        actor: r.actor,
        status: r.status,
        policyDecision: r.policy_decision,
        operationId: r.operation_id,
      }));

      /* `truncated` est rendu explicitement. Un audit qui montrerait
         cinquante lignes sur trois cents sans le dire donnerait une image
         fausse — et c'est la seule façon dont une lecture honnête peut
         mentir. */
      return ok({
        output: {
          window: input.window,
          count: entries.length,
          truncated: entries.length === input.limit,
          entries,
        },
      });
    },
  });
}
