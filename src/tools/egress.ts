/**
 * `egress_review` — scénario doré **C4**, porte de sortie de `docs/02` Phase 4.
 *
 *   > **Entrée :** « Montre-moi ce qui est parti sur Internet. »
 *   > **Attendu :** liste lisible par un humain — **destination, classe de
 *   > données, raison.**
 *
 * Et la porte de sortie l'exige dans les mêmes termes :
 *
 *   > L'utilisateur peut voir ce qui est parti sur Internet, **sans lire un
 *   > log**.
 *
 * TROIS COLONNES, ET AUCUNE N'EST DÉCORATIVE
 * -------------------------------------------
 * « Trois requêtes sont sorties » ne répond à rien. La question porte sur ce
 * qu'on ne peut pas reconstituer soi-même :
 *
 *   OÙ        chez qui — un fournisseur, pas une URL (`docs/03 §12`)
 *   QUOI      la classe de la donnée, au sens de `docs/14`
 *   POURQUOI  ce que la politique a répondu, en clair
 *
 * LA SOURCE EST LE JOURNAL, POUR LA RAISON D'ADR-041
 * ---------------------------------------------------
 * Une console alimentée par une seconde table pourrait diverger — et le jour
 * où elles divergent, aucune ne fait autorité. Les trois faits sont écrits
 * dans `event_ledger` au moment où la sortie a lieu, couverts par la chaîne de
 * hachage comme le reste (ADR-052).
 *
 * CE QU'ELLE NE FAIT PAS
 * -----------------------
 * Elle ne DÉDUIT rien. Reconstituer l'égression après coup à partir du
 * `networkRequired` d'un outil serait « l'observateur redéfinit le passé »
 * appliqué à l'audit : ce champ dépend du fournisseur branché (ADR-051), donc
 * un rebranchement réécrirait l'histoire.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { ok, type Result } from '../core/types/result.js';

const EgressReviewInput = z.object({
  window: z.enum(['today', 'week', 'month']).default('week'),
  limit: z.number().int().min(1).max(200).default(50),
});

interface EgressRow {
  occurred_at: Date;
  tool: string | null;
  actor: string;
  status: string;
  egress_destination: string;
  egress_data_level: string;
  egress_reason: string;
}

export function egressReviewTool(): RegisteredTool {
  return defineTool<z.infer<typeof EgressReviewInput>>({
    definition: {
      id: 'egress_review',
      version: '1.0.0',
      description: 'Montrer ce qui est parti de la machine : où, quelle classe, pourquoi.',
      autonomy: 'L1',
      privacyClass: 'ORANGE',
      /* La liste des sorties dit à qui on parle et quand. C'est une
         information sur la vie de l'utilisateur, même sans aucun contenu —
         même raisonnement qu'`audit_query`. */
      dataCategory: 'OTHER',
      reversible: false,
      /* Cette console LIT le journal local. Elle ne sort de rien — et il
         serait absurde qu'un outil de surveillance des sorties en produise
         une. */
      networkRequired: false,
      parameters: [
        { name: 'window', sensitive: false },
        { name: 'limit', sensitive: false },
      ],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 5_000,
      maxRetries: 2,
      auditEvent: 'EGRESS_REVIEWED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: EgressReviewInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* La fenêtre est calculée par la base (ADR-037), comme partout. Un
         processus dont l'horloge dérive montrerait la mauvaise semaine — et
         une console de surveillance qui montre la mauvaise semaine est pire
         qu'aucune console, parce qu'elle rassure. */
      const rows = await ctx.db.query<EgressRow>(
        `SELECT occurred_at, tool, actor, status,
                egress_destination, egress_data_level, egress_reason
           FROM event_ledger
          WHERE egress_destination IS NOT NULL
            AND occurred_at >= date_trunc($1, clock_timestamp())
          ORDER BY seq DESC
          LIMIT $2`,
        [input.window === 'today' ? 'day' : input.window, String(input.limit)],
      );
      if (!rows.ok) return rows;

      const sorties = rows.value.rows.map((r) => ({
        occurredAt: r.occurred_at.toISOString(),
        tool: r.tool,
        actor: r.actor,
        status: r.status,
        destination: r.egress_destination,
        dataLevel: r.egress_data_level,
        reason: r.egress_reason,
      }));

      return ok({
        output: {
          window: input.window,
          count: sorties.length,
          /* Une console tronquée sans le dire donnerait l'image d'un système
             plus discret qu'il n'est — le mensonge le plus tentant de cet
             outil précis. */
          truncated: sorties.length === input.limit,
          /* RENDU MÊME QUAND IL VAUT ZÉRO, et c'est le point.

             « Rien n'est sorti » est une réponse, et c'est même la réponse
             qu'on espère. Elle doit être distinguable d'une console qui n'a
             pas su regarder — d'où le champ explicite plutôt qu'une liste
             vide qu'on interprète. */
          rienNEstSorti: sorties.length === 0,
          sorties,
        },
      });
    },
  });
}
