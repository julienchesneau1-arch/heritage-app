/**
 * Sonde — que retrouve Jarvis au redémarrage, selon l'endroit où il est mort ?
 *
 * Référence : ADR-027, `docs/12 §5`.
 *
 * Exécutée en processus ENFANT : le comportement recherché est une
 * TERMINAISON, qu'on ne peut pas observer depuis le processus qui mourrait
 * avec elle.
 *
 * L'effet externe simulé est l'insertion d'une note. Elle est réelle,
 * observable, et sans contrainte d'unicité : une double exécution laisse deux
 * lignes, et c'est précisément ce qu'on cherche à empêcher.
 *
 *   npx tsx crash-probe.ts <point> <operationId>   meurt au point demandé
 *   npx tsx crash-probe.ts recover <operationId>   rejoue, imprime le verdict
 */
import { fromStorage } from '../../../src/core/tools/identity.js';
import { z } from 'zod';
import type pg from 'pg';
import { createDb, type Db } from '../../../src/core/db/client.js';
import { defineTool } from '../../../src/core/tools/contract.js';
import { ok, type Result } from '../../../src/core/types/result.js';
import type { ToolContext, ToolExecution } from '../../../src/core/tools/contract.js';
import { buildStack } from '../../helpers/stack.js';

/**
 * Points d'arrêt, nommés d'après la question qu'ils posent.
 *
 * `A` et `B` encadrent l'écriture de l'intention ; `C` à `F` encadrent l'appel
 * et la persistance de son résultat.
 */
export type CrashPoint =
  | 'A_AVANT_JOURNAL'
  | 'B_APRES_JOURNAL'
  | 'C_PENDANT_APPEL'
  | 'D_APRES_SUCCES_EXTERNE'
  | 'E_AVANT_PERSISTANCE'
  | 'F_APRES_PERSISTANCE'
  /** Rejeu après redémarrage : aucun point d'arrêt, on observe la reprise. */
  | 'recover'
  | 'AUCUN';

const [rawPoint = 'AUCUN', operationId = 'sonde'] = process.argv.slice(2);

function credentials() {
  return {
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password: process.env['JARVIS_DB_PASSWORD'] ?? '',
  };
}

/**
 * Enveloppe la base pour tuer le processus à un point d'arrêt précis.
 *
 * Volontairement côté TEST : le code de production ne contient aucun crochet
 * de panne. Un interrupteur de plantage dans `src/` finirait par être
 * déclenché en exploitation.
 */
function crashingDb(real: Db, point: CrashPoint): Db {
  /* L'ÉCRITURE DE PERSISTANCE, reconnue par ce qui la caractérise.
     Le motif portait `observed_at = now()`. ADR-035 a fait passer l'estampille
     à `clock_timestamp()`, et les points d'arrêt E et F ont cessé de tirer —
     sans qu'aucun test ne devienne rouge : E s'est mis à observer une exécution
     normale, et F a continué de passer POUR UNE MAUVAISE RAISON.

     On reconnaît donc la colonne, jamais la fonction qui l'alimente. Et
     `crashThenRecover` vérifie désormais que le point d'arrêt a bien tiré :
     une sonde muette ne doit plus pouvoir se faire passer pour un test vert. */
  const persistsOutcome = (sql: string): boolean =>
    /UPDATE tool_operations/.test(sql) && /observed_at\s*=/.test(sql);

  const shouldCrashBefore = (sql: string): boolean =>
    (point === 'A_AVANT_JOURNAL' && /INSERT INTO tool_operations/.test(sql)) ||
    (point === 'E_AVANT_PERSISTANCE' && persistsOutcome(sql));

  const shouldCrashAfter = (sql: string): boolean =>
    (point === 'B_APRES_JOURNAL' && /INSERT INTO tool_operations/.test(sql)) ||
    (point === 'F_APRES_PERSISTANCE' && persistsOutcome(sql));

  return {
    async query<T extends pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
      if (shouldCrashBefore(text)) {
        process.stdout.write(`CRASH ${point}\n`);
        process.exit(9);
      }
      const result = await real.query<T>(text, params);
      if (shouldCrashAfter(text)) {
        process.stdout.write(`CRASH ${point}\n`);
        process.exit(9);
      }
      return result;
    },
    transaction: real.transaction.bind(real),
    health: real.health.bind(real),
    close: real.close.bind(real),
  };
}

/** L'outil dont l'effet externe est une note. Il ne sait pas se vérifier. */
function effectTool(point: CrashPoint) {
  return defineTool({
    definition: {
      id: 'crash_effect',
      version: '1.0.0',
      description: 'Outil dont l\'effet externe est observable',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'marker', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      // Court : le bail d'exécution (ADR-032) vaut `timeoutMs + marge`, et la
      // sonde doit pouvoir être reprise dans un délai de test raisonnable.
      timeoutMs: 200,
      maxRetries: 0,
      auditEvent: 'CRASH_EFFECT',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: z.object({ marker: z.string() }),

    async execute(input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      if (point === 'C_PENDANT_APPEL') {
        // Mort AVANT l'effet : l'appel était parti, rien n'a changé.
        process.stdout.write('CRASH C_PENDANT_APPEL\n');
        process.exit(9);
      }

      // L'EFFET EXTERNE. Sans contrainte d'unicité : un doublon se verrait.
      const inserted = await ctx.db.query<{ id: string }>(
        'INSERT INTO notes (content, privacy_class) VALUES ($1, $2) RETURNING id',
        [input.marker, 'GREEN'],
      );
      if (!inserted.ok) return inserted;

      if (point === 'D_APRES_SUCCES_EXTERNE') {
        // Mort APRÈS l'effet, avant tout retour : le pire cas.
        process.stdout.write('CRASH D_APRES_SUCCES_EXTERNE\n');
        process.exit(9);
      }

      return ok({
        output: { id: inserted.value.rows[0]?.id ?? null },
        resource: { kind: 'note', id: inserted.value.rows[0]?.id ?? '' },
      });
    },

    async readBack(execution, ctx: ToolContext) {
      const id = execution.resource?.id;
      if (id === undefined || id.length === 0) {
        return ok({ status: 'UNKNOWN' as const, detail: 'aucune ressource à relire' });
      }
      const found = await ctx.db.query('SELECT id FROM notes WHERE id = $1', [id]);
      if (!found.ok) return found;
      return ok(
        found.value.rowCount === 1
          ? { status: 'CONFIRMED' as const, detail: 'note présente' }
          : { status: 'FAILED' as const, detail: 'note absente' },
      );
    },
  });
}

async function main(): Promise<void> {
  const point = rawPoint as CrashPoint;
  const real = createDb(credentials());
  const db = point === 'recover' || point === 'AUCUN' ? real : crashingDb(real, point);
  const stack = buildStack(db);
  stack.registerExtra(effectTool(point === 'recover' ? 'AUCUN' : point));

  const result = await stack.gateway.invoke({
    toolId: 'crash_effect',
    input: { marker: `crash-${operationId}` },
    parameterProvenance: { marker: 'USER' },
    operationId: fromStorage(operationId),
    actor: 'USER',
    context: { mode: 'NORMAL', cloudEnabled: false, proactive: false, userConfirmed: false },
  });

  const row = await real.query<{ state: string; attempts: number }>(
    'SELECT state, attempts FROM tool_operations WHERE operation_id = $1',
    [operationId],
  );
  const effets = await real.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM notes WHERE content = $1',
    [`crash-${operationId}`],
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: result.ok,
      status: result.ok ? result.value.status : null,
      erreur: result.ok ? null : result.error.kind,
      detail: result.ok ? result.value.verification.detail : result.error.message,
      etat: row.ok ? (row.value.rows[0]?.state ?? null) : null,
      tentatives: row.ok ? (row.value.rows[0]?.attempts ?? 0) : -1,
      effets: effets.ok ? Number(effets.value.rows[0]?.n ?? '0') : -1,
    })}\n`,
  );
  await real.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `SONDE_EN_ERREUR ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(3);
});
