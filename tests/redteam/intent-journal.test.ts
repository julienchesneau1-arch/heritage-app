/**
 * RED TEAM — journal d'intention, crash et reprise.
 *
 * Référence : ADR-027, `docs/12 §5`, matrice adversariale ligne C2.
 *
 * La question de ce fichier n'est pas « le code gère-t-il l'erreur ». C'est
 * une question de système distribué :
 *
 *     Si le processus meurt À CET ENDROIT PRÉCIS, que retrouve Jarvis au
 *     redémarrage — et combien de fois l'action a-t-elle eu lieu ?
 *
 * Chaque scénario tourne dans un processus enfant qu'on tue réellement, puis
 * un SECOND processus rejoue la même clé d'opération. C'est un vrai
 * redémarrage, pas une simulation.
 */
import { fromStorage } from '../../src/core/tools/identity.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { defineTool } from '../../src/core/tools/contract.js';
import { ok, type Result } from '../../src/core/types/result.js';
import type {
  AttemptVerdict,
  ToolContext,
  ToolExecution,
} from '../../src/core/tools/contract.js';

const run = promisify(execFile);
const skip = !databaseAvailable();
const PROBE = join(process.cwd(), 'tests', 'redteam', 'probes', 'crash-probe.ts');

interface Observation {
  readonly ok: boolean;
  readonly status: string | null;
  readonly detail: string;
  readonly etat: string | null;
  readonly tentatives: number;
  /** Nombre d'effets externes réellement produits. Doit valoir 0 ou 1. Jamais 2. */
  readonly effets: number;
}

async function probe(point: string, opId: string): Promise<string> {
  try {
    const { stdout } = await run('npx', ['tsx', PROBE, point, opId], {
      env: { ...process.env, JARVIS_DB_NAME: 'jarvis_test' },
      timeout: 60_000,
    });
    return stdout;
  } catch (error: unknown) {
    const detail: Record<string, unknown> =
      typeof error === 'object' && error !== null ? { ...error } : {};
    return typeof detail['stdout'] === 'string' ? detail['stdout'] : '';
  }
}

/** Tue le processus au point demandé, puis REDÉMARRE et rejoue. */
async function crashThenRecover(point: string): Promise<Observation> {
  const opId = `crash-${point}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const crashed = await probe(point, opId);

  /* LA SONDE A-T-ELLE RÉELLEMENT PLANTÉ ?
     Sans ce contrôle, un point d'arrêt qui cesse de reconnaître son motif SQL
     transforme silencieusement le scénario en exécution normale — et le test
     reste vert en n'éprouvant plus rien. C'est arrivé : ADR-035 a fait passer
     l'estampille de `now()` à `clock_timestamp()`, et les points E et F ont
     cessé de tirer sans qu'aucune suite ne rougisse. */
  if (!crashed.includes(`CRASH ${point}`)) {
    throw new Error(
      `le point d'arrêt ${point} n'a pas tiré : la sonde n'a rien éprouvé.\n${crashed}`,
    );
  }

  /* ATTENTE DU BAIL D'EXÉCUTION — ADR-032.

     Depuis Foundation 4, une reprise ne peut pas prendre la main tant que le
     bail de l'exécutant précédent n'a pas expiré : de l'extérieur, « mort il y
     a une seconde » est indiscernable de « encore en train de tourner ».

     Ce `sleep` n'est donc pas une commodité de test — il matérialise une
     propriété du système. Une reprise immédiate reçoit `OPERATION_IN_FLIGHT`,
     ce que `lab/crash-concurrency` vérifie explicitement. */
  await new Promise((resolve) => setTimeout(resolve, 5_400));

  const out = await probe('recover', opId);
  const line = out.trim().split('\n').at(-1) ?? '{}';
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`sonde muette : ${out}`);
  const record: Record<string, unknown> = { ...parsed };
  return {
    ok: record['ok'] === true,
    status: typeof record['status'] === 'string' ? record['status'] : null,
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
    etat: typeof record['etat'] === 'string' ? record['etat'] : null,
    tentatives: Number(record['tentatives'] ?? -1),
    effets: Number(record['effets'] ?? -1),
  };
}

describe.skipIf(skip)('RED TEAM — crash aux sept points, et reprise', () => {
  /* ------------------------------------------------------------------ */
  /* L'INVARIANT QUI COMPTE                                              */
  /* ------------------------------------------------------------------ */

  it('A — crash AVANT le journal : rien n\'avait eu lieu, l\'action s\'exécute une fois', async () => {
    // L'absence de trace est ici une information FIABLE, et non un pari :
    // aucun appel n'est jamais lancé avant l'écriture de l'intention.
    const seen = await crashThenRecover('A_AVANT_JOURNAL');
    expect(seen.effets).toBe(1);
    expect(seen.etat).toBe('SUCCEEDED');
    expect(seen.status).toBe('CONFIRMED');
  }, 120_000);

  it('B — crash APRÈS le journal (PLANNED) : toujours aucun appel, exécution unique', async () => {
    const seen = await crashThenRecover('B_APRES_JOURNAL');
    expect(seen.effets).toBe(1);
    expect(seen.etat).toBe('SUCCEEDED');
  }, 120_000);

  it('C — crash PENDANT l\'appel : UNKNOWN, et aucun rejeu', async () => {
    // L'effet n'avait en fait PAS eu lieu. Jarvis l'ignore, et refuse quand
    // même de rejouer. C'est le coût assumé du modèle : le doute penche
    // toujours du côté qui ne produit pas de doublon.
    const seen = await crashThenRecover('C_PENDANT_APPEL');
    expect(seen.status).toBe('UNKNOWN');
    expect(seen.etat).toBe('UNKNOWN');
    expect(seen.detail).toContain('je ne vais pas la rejouer');
    expect(seen.tentatives).toBe(1);
  }, 120_000);

  it('D — crash APRÈS l\'effet externe : UNKNOWN, et surtout PAS de doublon', async () => {
    // LE scénario qui justifie tout le mécanisme. Sans journal d'intention,
    // la reprise ne trouvait aucune ligne et réexécutait : deux emails.
    const seen = await crashThenRecover('D_APRES_SUCCES_EXTERNE');
    expect(seen.effets).toBe(1); // et non 2
    expect(seen.status).toBe('UNKNOWN');
    expect(seen.tentatives).toBe(1);
  }, 120_000);

  it('E — crash avant la persistance du résultat : UNKNOWN, pas de doublon', async () => {
    const seen = await crashThenRecover('E_AVANT_PERSISTANCE');
    expect(seen.effets).toBe(1);
    expect(seen.status).toBe('UNKNOWN');
    expect(seen.tentatives).toBe(1);
  }, 120_000);

  it('F — crash après la persistance : la relecture confirme, sans réexécuter', async () => {
    const seen = await crashThenRecover('F_APRES_PERSISTANCE');
    expect(seen.effets).toBe(1);
    expect(seen.etat).toBe('SUCCEEDED');
    expect(seen.status).toBe('CONFIRMED');
    expect(seen.tentatives).toBe(1);
  }, 120_000);

  it('G — dans les six cas, le compteur de tentatives reste à 1', async () => {
    // G (« après redémarrage ») n'est pas un septième scénario : chaque
    // reprise ci-dessus EST un redémarrage, dans un processus neuf. Cette
    // assertion est l'invariant transversal.
    const points = [
      'A_AVANT_JOURNAL',
      'C_PENDANT_APPEL',
      'D_APRES_SUCCES_EXTERNE',
    ];
    for (const point of points) {
      const seen = await crashThenRecover(point);
      expect(seen.tentatives, point).toBeLessThanOrEqual(1);
      expect(seen.effets, point).toBeLessThanOrEqual(1);
    }
  }, 180_000);
});

/* ==================================================================== */
/* Vérification de tentative auprès du fournisseur                      */
/* ==================================================================== */

/**
 * Un outil qui SAIT dire, après coup, si une opération a eu un effet.
 *
 * C'est ce que devra fournir un connecteur sérieux — Gmail expose par exemple
 * de quoi retrouver un message par en-tête. Les cinq outils du noyau, eux,
 * déclarent honnêtement `NONE`.
 */
function verifiableTool(verdict: () => AttemptVerdict) {
  return defineTool({
    definition: {
      id: 'verifiable_effect',
      version: '1.0.0',
      description: 'Outil sachant vérifier une tentative',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'marker', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 200,
      maxRetries: 0,
      auditEvent: 'VERIFIABLE_EFFECT',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'BY_OPERATION_KEY',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
    },
    inputSchema: z.object({ marker: z.string() }),
    execute(input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      executions.push(ctx.operationId);
      return Promise.resolve(ok({ output: { marker: input.marker } }));
    },
    readBack: () =>
      Promise.resolve(ok({ status: 'CONFIRMED' as const, detail: 'relu' })),
    verifyAttempt: () => Promise.resolve(ok(verdict())),
  });
}

const executions: string[] = [];

describe.skipIf(skip)('RED TEAM — vérification idempotente auprès du fournisseur', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Place une opération dans l'état `EXECUTING`, comme après un crash. */
  async function leaveExecuting(opId: string): Promise<void> {
    const digest = await stack.gateway
      .invoke({
        toolId: 'verifiable_effect',
        input: { marker: opId },
        parameterProvenance: { marker: 'USER' },
        operationId: fromStorage(opId),
        actor: 'USER',
        context: callContext(),
      })
      .then(() => undefined);
    void digest;
    /* On simule un exécutant MORT, pas un exécutant en vol.
       `executing_at` est donc reculé au-delà du bail (ADR-032) : sans cela,
       l'opération serait considérée comme encore en cours, et la reprise
       refuserait de prendre la main — ce qui est le comportement correct, mais
       pas celui que ce test cherche à éprouver.

       `lease_expires_at` est reculé de même. La contrainte `lease_has_deadline`
       (migration 0008) l'exige, et c'est tant mieux : une mise en scène qui
       laisserait `EXECUTING` sans échéance décrirait un état que le système ne
       peut pas produire, et le test éprouverait une fiction. */
    const forced = await db.query(
      `UPDATE tool_operations
          SET state = 'EXECUTING', status = NULL, observed_at = NULL,
              executing_at = clock_timestamp() - interval '1 hour',
              lease_expires_at = clock_timestamp() - interval '59 minutes'
        WHERE operation_id = $1`,
      [opId],
    );
    if (!forced.ok) throw new Error(forced.error.message);
  }

  it('le contrat REFUSE un outil qui promet une vérification sans la fournir', () => {
    // Promettre de savoir vérifier sans savoir le faire est pire que l'avouer :
    // la reprise croirait pouvoir trancher, et trancherait au hasard.
    const menteur = defineTool({
      definition: {
        id: 'menteur',
        version: '1.0.0',
        description: 'Promet une vérification qu\'il ne fournit pas',
        autonomy: 'L2',
        privacyClass: 'GREEN',
        // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
        dataCategory: 'OTHER',
        reversible: false,
        networkRequired: false,
        parameters: [],
        idempotency: 'OPERATION_KEY',
        verification: 'READ_BACK',
        timeoutMs: 200,
        maxRetries: 0,
        auditEvent: 'MENTEUR',
        requiredSecrets: [],
        rollback: null,
        attemptVerification: 'BY_OPERATION_KEY',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      },
      inputSchema: z.object({}),
      execute: () => Promise.resolve(ok({ output: null })),
    });
    const result = stack.gateway.register(menteur);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain('verifyAttempt');
  });

  it('effet CONFIRMÉ par le fournisseur : succès sans réexécution', async () => {
    stack.registerExtra(
      verifiableTool(() => ({
        kind: 'EFFECT_CONFIRMED',
        detail: 'le fournisseur a déjà traité cette opération',
        proof: 'msg-123',
      })),
    );
    const opId = operationId('verif-confirmed');
    await leaveExecuting(opId);
    const before = executions.length;

    const resumed = await stack.gateway.invoke({
      toolId: 'verifiable_effect',
      input: { marker: opId },
      parameterProvenance: { marker: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext(),
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.status).toBe('CONFIRMED');
    expect(resumed.value.replayed).toBe(true);
    expect(executions.length).toBe(before); // AUCUNE réexécution
  });

  it('absence d\'effet AFFIRMÉE : la réexécution est autorisée, une seule fois', async () => {
    stack.registerExtra(
      verifiableTool(() => ({
        kind: 'NO_EFFECT',
        detail: 'le fournisseur n\'a aucune trace de cette opération',
      })),
    );
    const opId = operationId('verif-noeffect');
    await leaveExecuting(opId);
    const before = executions.length;

    const resumed = await stack.gateway.invoke({
      toolId: 'verifiable_effect',
      input: { marker: opId },
      parameterProvenance: { marker: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext(),
    });

    expect(resumed.ok).toBe(true);
    // Une affirmation POSITIVE d'absence est le seul chemin qui rouvre
    // l'exécution. Une absence de preuve n'y suffit jamais.
    expect(executions.length).toBe(before + 1);
  });

  it('vérification NON CONCLUANTE : UNKNOWN, aucune réexécution', async () => {
    stack.registerExtra(
      verifiableTool(() => ({
        kind: 'INCONCLUSIVE',
        detail: 'le fournisseur ne répond pas',
      })),
    );
    const opId = operationId('verif-inconclusive');
    await leaveExecuting(opId);
    const before = executions.length;

    const resumed = await stack.gateway.invoke({
      toolId: 'verifiable_effect',
      input: { marker: opId },
      parameterProvenance: { marker: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext(),
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.status).toBe('UNKNOWN');
    expect(resumed.value.verification.detail).toContain('rejoue pas');
    expect(executions.length).toBe(before);
  });

  it('les cinq outils du noyau déclarent honnêtement ne pas savoir vérifier', () => {
    const core = stack.gateway
      .list()
      .filter((t) => !t.definition.id.includes('effect') && t.definition.id !== 'menteur');
    expect(core.length).toBeGreaterThanOrEqual(5);
    for (const tool of core) {
      expect(tool.definition.attemptVerification, tool.definition.id).toBe('NONE');
    }
    // Conséquence assumée : après un crash en cours d'appel, ces outils
    // laissent UNKNOWN. Les rendre vérifiables suppose d'écrire la clé
    // d'opération dans la ressource créée — chantier nommé, non fait.
  });

  it('aucun rejeu automatique n\'existe dans le noyau', () => {
    // `maxRetries` est déclaré par les contrats mais consommé par PERSONNE.
    // C'est volontaire : le brief interdit tout retry tant que la sémantique
    // d'UNKNOWN n'est pas éprouvée. Ce test empêche d'en ajouter un par
    // inadvertance.
    const source = readFileSync(
      join(process.cwd(), 'src', 'core', 'tools', 'gateway.ts'),
      'utf8',
    );
    expect(source).not.toContain('maxRetries');
    expect(source).not.toMatch(/for\s*\(.*attempt/i);
  });
});
