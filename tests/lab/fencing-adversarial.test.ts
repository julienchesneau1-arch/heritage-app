/**
 * CLOISONNEMENT — épreuve adversariale, Foundation 5.1.
 *
 * `docs/23 §6` a mesuré le défaut : un exécutant dont l'autorité avait expiré
 * écrasait l'état établi par son successeur. Jarvis racontait l'histoire de A
 * à propos d'un monde façonné par B.
 *
 * CE QUE CETTE ÉPREUVE ÉTABLIT
 * ----------------------------
 *   A démarre                 → génération 4
 *   B reprend et clôt         → génération 5
 *   A revient                 → ne peut modifier AUCUNE colonne
 *
 * Le dernier point est vérifié par DIFFÉRENCE D'INSTANTANÉ, pas par une liste
 * de colonnes. Énumérer les colonnes à protéger, c'est se condamner à en
 * oublier une le jour où le schéma bouge ; comparer `to_jsonb(ligne)` avant et
 * après prouve que l'ENSEMBLE des colonnes modifiées est vide — y compris
 * celles qui n'existent pas encore.
 *
 * LA FRONTIÈRE, QUI NE DOIT PAS BOUGER
 * ------------------------------------
 *   le cloisonnement PROTÈGE      l'état interne de Jarvis contre ses anciens
 *                                 exécutants
 *   le cloisonnement NE PROTÈGE   le monde extérieur contre une requête déjà
 *   PAS                           partie
 *
 *   fencing ≠ annulation ≠ idempotence ≠ vérification ≠ absence d'effet
 *
 * Aucun test de ce fichier ne prétend le contraire, et l'un d'eux le mesure
 * explicitement : A périmé n'écrit rien, ET son effet existe quand même.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { commitEffect, createWorld, resetWorld, worldDb } from './world.js';
import { defineTool } from '../../src/core/tools/contract.js';
import { verificationOutcome } from '../../src/core/verification/engine.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';
import type {
  AttemptVerdict,
  RegisteredTool,
  ToolContext,
  ToolExecution,
  VerificationOutcome,
} from '../../src/core/tools/contract.js';
import type { OperationIdentity } from '../../src/core/tools/identity.js';

const enabled = databaseAvailable();

/** Court à dessein : le cas « A dépasse son délai » ne doit pas coûter 5 s. */
const TOOL_TIMEOUT_MS = 400;

const PAYLOAD_DIGEST = createHash('sha256')
  .update(JSON.stringify({ payload: 'charge utile' }))
  .digest('hex');

const GATED_TOOL = 'lab_gated_send';
const RACEY_TOOL = 'lab_racey_send';

/* -------------------------------------------------------------------------- *
 * LA GUILLOTINE
 *
 * Elle permet de figer A EXACTEMENT là où le défaut vit : après le départ de
 * l'appel, avant l'écriture du résultat. Un `sleep` ne suffirait pas — le test
 * doit SAVOIR que A est entré, sinon il court après une fenêtre temporelle et
 * devient instable pour de mauvaises raisons.
 * -------------------------------------------------------------------------- */

interface Barrier {
  /** Résolue dès que l'outil entre dans `execute`. */
  readonly entered: Promise<void>;
  /** Appelée PAR L'OUTIL en entrant. */
  markEntered(): void;
  /** Attendue PAR L'OUTIL avant de rendre la main. */
  held(): Promise<void>;
  /** Appelée PAR LE TEST. Idempotente. */
  release(): void;
}

function makeBarrier(): Barrier {
  let markEntered = (): void => undefined;
  let release = (): void => undefined;
  // Les exécuteurs de promesse tournent de façon synchrone : les deux
  // fonctions sont affectées avant le `return`.
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, markEntered, held: () => released, release };
}

type LateReturn = 'SUCCESS' | 'ERROR' | 'TIMEOUT';

const GatedInput = z.object({ payload: z.string().min(1) });

/** Outil dont le retour est piloté par le test, au millimètre. */
function createGatedTool(options: {
  barrier: Barrier;
  outcome: LateReturn;
  world: Db;
}): RegisteredTool {
  return defineTool<z.infer<typeof GatedInput>>({
    definition: {
      id: GATED_TOOL,
      version: '1.0.0',
      description: 'Outil de banc dont le retour est piloté par le test.',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'payload', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: TOOL_TIMEOUT_MS,
      maxRetries: 0,
      auditEvent: 'LAB_GATED_SEND',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'EXTERNALLY_VERIFIABLE',
      /* `VERIFIABLE` à dessein : A tentera d'écrire SUCCEEDED + CONFIRMED,
         soit l'écriture la plus affirmative que le système sache produire.
         Éprouver le cloisonnement sur un verdict tiède ne prouverait rien. */
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },

    inputSchema: GatedInput,

    async execute(input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      /* L'EFFET EXTERNE EST PRODUIT AVANT LA GUILLOTINE.
         C'est le point de tout le scénario : quand A sera déclaré périmé, son
         effet existera déjà dans le monde. Le cloisonnement ne le défait pas,
         et ne prétend pas le défaire. */
      await commitEffect(options.world, {
        operationKey: ctx.operationId,
        providerId: 'lab-gated',
        target: '-',
        payload: input.payload,
      });

      options.barrier.markEntered();
      await options.barrier.held();

      if (options.outcome === 'ERROR') {
        return err(jarvisError('PROVIDER_UNAVAILABLE', 'le fournisseur a rendu 503'));
      }
      return ok({
        output: { reference: ctx.operationId },
        resource: { kind: 'lab_effect', id: ctx.operationId },
        proof: ctx.operationId,
      });
    },

    readBack(): Promise<Result<VerificationOutcome>> {
      return Promise.resolve(
        ok(
          verificationOutcome.confirmed({
            observed: 'effet constaté par A',
            proof: 'recu-a',
          }),
        ),
      );
    },
  });
}

/**
 * Outil dont la VÉRIFICATION DE TENTATIVE se fait doubler.
 *
 * `verifyAttempt` simule un troisième exécutant qui prend le bail pendant que
 * le repreneur interroge le monde, puis rend `NO_EFFECT` — la seule réponse
 * qui autorise un rembobinage.
 */
function createRaceyVerifyTool(db: Db): RegisteredTool {
  return defineTool<z.infer<typeof GatedInput>>({
    definition: {
      id: RACEY_TOOL,
      version: '1.0.0',
      description: 'Outil de banc : un tiers reprend le bail pendant la vérification.',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'payload', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: TOOL_TIMEOUT_MS,
      maxRetries: 0,
      auditEvent: 'LAB_RACEY_SEND',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'BY_OPERATION_KEY',
      /* `PROVIDER_IDEMPOTENT` : le SEUL contrat qui ouvre le rembobinage. Avec
         tout autre, la reprise s'arrêterait à UNKNOWN et le chemin dangereux
         ne serait jamais atteint — le test ne prouverait rien. */
      effect: 'PROVIDER_IDEMPOTENT',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },

    inputSchema: GatedInput,

    execute(): Promise<Result<ToolExecution>> {
      // Ne doit JAMAIS être atteinte dans ce scénario. Si elle l'est, le
      // rembobinage périmé a réussi et le défaut est de retour.
      return Promise.reject(
        new Error('exécution atteinte : le rembobinage périmé a réussi'),
      );
    },

    readBack(): Promise<Result<VerificationOutcome>> {
      return Promise.resolve(
        ok(verificationOutcome.unknown('non atteint', 'NO_OBSERVATION')),
      );
    },

    async verifyAttempt(operationId: string): Promise<Result<AttemptVerdict>> {
      // C prend le bail pendant que B regarde le monde.
      const stolen = await db.query(
        `UPDATE tool_operations
            SET lease_generation = lease_generation + 1, lease_owner = 'pid-C'
          WHERE operation_id = $1`,
        [operationId],
      );
      if (!stolen.ok) throw new Error(stolen.error.message);
      return ok({ kind: 'NO_EFFECT', detail: 'aucun effet trouvé' });
    },
  });
}

/* -------------------------------------------------------------------------- */

const SUCCEEDED = { state: 'SUCCEEDED', status: 'CONFIRMED' } as const;
const FAILED = { state: 'FAILED', status: 'FAILED' } as const;
const UNKNOWN = { state: 'UNKNOWN', status: 'UNKNOWN' } as const;

describe.runIf(enabled)('banc — cloisonnement du bail', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(20);
    world = worldDb(15);
    await createWorld(world);
  });

  afterAll(async () => {
    /* Ce fichier met en scène des états terminaux que ses outils n'ont pas
       réellement produits — B est joué par le banc. On ne les laisse pas
       derrière soi : les invariants du chaos balaient toute opération `lab_%`,
       et une mise en scène abandonnée deviendrait une fausse violation. */
    await db.query('DELETE FROM tool_operations WHERE tool_id = ANY($1)', [
      [GATED_TOOL, RACEY_TOOL],
    ]);
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  /* ================================================================== *
   * LE SCÉNARIO DU MANDAT — A(4), B(5), A revient
   * ================================================================== */

  for (const terminal of [SUCCEEDED, FAILED, UNKNOWN]) {
    for (const outcome of ['SUCCESS', 'ERROR', 'TIMEOUT'] as const) {
      it(
        `A périmé n'écrit RIEN par-dessus ${terminal.state} (retour ${outcome})`,
        async () => {
          const key = labKey('fence');
          // Génération 3 au départ : la prise de bail de A donnera 4, celle de
          // B donnera 5 — les nombres du mandat, littéralement.
          await seedPlanned(db, key, 3);

          const barrier = makeBarrier();
          const stack = buildLabStack(db);
          stack.register(createGatedTool({ barrier, outcome, world }));

          const aRun = stack.gateway.invoke(labCall(key, { toolId: GATED_TOOL }));
          await barrier.entered;

          expect(await generationOf(db, key)).toBe(4);

          expect(await takeOverAndSettle(db, key, terminal)).toBe(5);
          const before = await snapshot(db, key);

          // Pour `TIMEOUT`, on ne relâche pas : c'est `withTimeout` qui tranche.
          if (outcome !== 'TIMEOUT') barrier.release();
          const result = await aRun;
          // Libère l'exécution restée en vol après le dépassement de délai.
          barrier.release();

          /* 1. A n'obtient PAS un état terminal : il n'a plus l'autorité d'en
                décider un, et le lui rendre serait lui laisser croire qu'il
                sait quelque chose. */
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.kind).toBe('STALE_EXECUTOR');

          /* 2. AUCUNE colonne n'a bougé — état, statut, observation,
                provenance de ressource, estampilles, métadonnées de reprise,
                bail. La comparaison porte sur la ligne entière. */
          const after = await snapshot(db, key);
          expect(changedColumns(before, after)).toEqual([]);

          /* 3. Et le verdict de B est intact, mot pour mot. */
          expect(after['state']).toBe(terminal.state);
          expect(after['status']).toBe(terminal.status);
          expect(after['recovery_detail']).toBe('repris et clos par B');
        },
        20_000,
      );
    }
  }

  /* ================================================================== *
   * LA FRONTIÈRE — ce que le cloisonnement ne fait PAS
   * ================================================================== */

  it(
    "l'effet de A existe malgré tout : le cloisonnement ne l'annule pas",
    async () => {
      /* La phrase à ne jamais perdre. A a été déclaré périmé, son écriture a
         été refusée — et le monde porte quand même sa trace. Un système qui
         conclurait « écriture refusée, donc pas d'effet » aurait remplacé un
         défaut par un mensonge. */
      const key = labKey('fence-frontiere');
      await seedPlanned(db, key, 3);

      const barrier = makeBarrier();
      const stack = buildLabStack(db);
      stack.register(createGatedTool({ barrier, outcome: 'SUCCESS', world }));

      const aRun = stack.gateway.invoke(labCall(key, { toolId: GATED_TOOL }));
      await barrier.entered;
      await takeOverAndSettle(db, key, UNKNOWN);
      barrier.release();
      const result = await aRun;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('STALE_EXECUTOR');

      const effects = await world.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM lab_world_effects WHERE operation_key = $1',
        [key],
      );
      expect(effects.ok).toBe(true);
      if (!effects.ok) return;
      // L'effet de A est là. Le cloisonnement protège l'état INTERNE, rien d'autre.
      expect(Number(effects.value.rows[0]?.n ?? '0')).toBe(1);
    },
    20_000,
  );

  it("l'exécution de A ne disparaît pas du journal, elle est MARQUÉE", async () => {
    /* Le journal était le second chemin parallèle, trouvé par l'audit et non
       par relecture. L'interdire entièrement aurait effacé la seule trace
       qu'une requête est partie vers le monde — exactement l'information dont
       un humain a besoin. On la garde, sous un type d'événement distinct et
       avec un statut retombé à `UNKNOWN`. */
    const key = labKey('fence-journal');
    await seedPlanned(db, key, 3);

    const barrier = makeBarrier();
    const stack = buildLabStack(db);
    stack.register(createGatedTool({ barrier, outcome: 'SUCCESS', world }));

    const aRun = stack.gateway.invoke(labCall(key, { toolId: GATED_TOOL }));
    await barrier.entered;
    await takeOverAndSettle(db, key, SUCCEEDED);
    barrier.release();
    await aRun;

    const events = await db.query<{ event_type: string; status: string }>(
      'SELECT event_type, status FROM event_ledger WHERE operation_id = $1',
      [key],
    );
    expect(events.ok).toBe(true);
    if (!events.ok) return;

    const stale = events.value.rows.filter((r) => r.event_type.endsWith('_STALE'));
    expect(stale).toHaveLength(1);
    // A avait pourtant vérifié CONFIRMED. Périmé, il n'a plus d'opinion recevable.
    expect(stale[0]?.status).toBe('UNKNOWN');
    expect(events.value.rows.some((r) => r.status === 'CONFIRMED')).toBe(false);
  }, 20_000);

  /* ================================================================== *
   * LES ÉCRITURES PRÉ-BAIL — la catégorie d'exception, vérifiée
   * ================================================================== */

  it(
    'les écritures pré-bail ne peuvent pas atteindre une opération engagée',
    async () => {
      /* Deux `UPDATE` du Gateway ne sont pas cloisonnés, et ne peuvent pas
         l'être : ce sont ceux qui rendent la frappe du bail possible. Leur
         garde est un LITTÉRAL d'état d'où aucun effet n'est possible.

         Ce test vérifie que le littéral fait réellement barrage. Sans lui,
         « catégorie d'exception justifiée » ne serait qu'une formule. */
      const key = labKey('fence-prebail');
      await seedExecuting(db, key, 4);

      const commit = await db.query(
        `UPDATE tool_operations
            SET state = 'COMMITTED_TO_EXECUTION', committed_at = now()
          WHERE operation_id = $1 AND state = 'PLANNED'`,
        [key],
      );
      expect(commit.ok).toBe(true);
      if (commit.ok) expect(commit.value.rowCount ?? 0).toBe(0);

      const rewind = await db.query(
        `UPDATE tool_operations SET state = 'PLANNED', recovery_detail = 'tentative'
           WHERE operation_id = $1 AND state = 'COMMITTED_TO_EXECUTION'`,
        [key],
      );
      expect(rewind.ok).toBe(true);
      if (rewind.ok) expect(rewind.value.rowCount ?? 0).toBe(0);

      const after = await snapshot(db, key);
      expect(after['state']).toBe('EXECUTING');
    },
    20_000,
  );

  /* ================================================================== *
   * RÉGRESSION — le chemin parallèle trouvé par l'audit
   * ================================================================== */

  it(
    'un repreneur périmé ne peut pas rembobiner vers PLANNED',
    async () => {
      /* LE DÉFAUT, tel que l'audit de F5.1 l'a construit :

           B reprend            → génération 5, `attempts` INCHANGÉ
           B interroge le monde → NO_EFFECT (la lecture prend du temps)
           C reprend            → génération 6 ; B est périmé
           B rembobine          → gardé par `attempts`, qui n'a pas bougé
                                  ⟹ ÇA PASSAIT

         `claimForRecovery` ne touche pas à `attempts` — seule l'exécution
         l'incrémente — si bien que le compteur ne voyait pas passer les
         reprises. Un exécutant sans autorité rouvrait donc l'exécution d'une
         opération qu'un autre était en train de trancher.

         Ici C prend la relève PENDANT la vérification de B : c'est le
         contre-exemple minimal, pas une approximation. */
      const key = labKey('fence-rembobinage');
      await seedExecuting(db, key, 4);

      const stack = buildLabStack(db);
      stack.register(createRaceyVerifyTool(db));

      const bRun = await stack.gateway.invoke(labCall(key, { toolId: RACEY_TOOL }));

      expect(bRun.ok).toBe(false);
      if (bRun.ok) return;
      expect(bRun.error.kind).toBe('STALE_EXECUTOR');

      const after = await snapshot(db, key);
      // Pas rembobinée : l'opération reste ce que C a trouvé.
      expect(after['state']).toBe('EXECUTING');
      // Et surtout : aucune seconde exécution n'a été lancée.
      expect(after['attempts']).toBe(1);
    },
    20_000,
  );
});

/* -------------------------------------------------------------------------- *
 * Outillage
 * -------------------------------------------------------------------------- */

async function seedPlanned(
  db: Db,
  key: OperationIdentity,
  generation: number,
): Promise<void> {
  const written = await db.query(
    `INSERT INTO tool_operations
       (operation_id, tool_id, tool_version, state, input_digest, actor,
        attempts, lease_generation)
     VALUES ($1,$2,'1.0.0','PLANNED',$3,'USER',0,$4)`,
    [key, GATED_TOOL, PAYLOAD_DIGEST, String(generation)],
  );
  if (!written.ok) throw new Error(written.error.message);
}

/** Opération engagée depuis une heure : le bail est expiré, la reprise ouverte. */
async function seedExecuting(
  db: Db,
  key: OperationIdentity,
  generation: number,
): Promise<void> {
  const written = await db.query(
    `INSERT INTO tool_operations
       (operation_id, tool_id, tool_version, state, input_digest, actor,
        attempts, committed_at, executing_at, lease_expires_at, lease_generation)
     VALUES ($1,$2,'1.0.0','EXECUTING',$3,'USER',1,
             clock_timestamp() - interval '1 hour',
             clock_timestamp() - interval '1 hour',
             clock_timestamp() - interval '59 minutes',
             $4)`,
    [key, RACEY_TOOL, PAYLOAD_DIGEST, String(generation)],
  );
  if (!written.ok) throw new Error(written.error.message);
}

async function generationOf(db: Db, key: OperationIdentity): Promise<number> {
  const row = await db.query<{ lease_generation: number }>(
    'SELECT lease_generation FROM tool_operations WHERE operation_id = $1',
    [key],
  );
  if (!row.ok) throw new Error(row.error.message);
  return row.value.rows[0]?.lease_generation ?? -1;
}

/** L'instantané COMPLET de la ligne : aucune colonne n'échappe à la comparaison. */
async function snapshot(
  db: Db,
  key: OperationIdentity,
): Promise<Record<string, unknown>> {
  const row = await db.query<{ ligne: Record<string, unknown> }>(
    'SELECT to_jsonb(t) AS ligne FROM tool_operations t WHERE operation_id = $1',
    [key],
  );
  if (!row.ok) throw new Error(row.error.message);
  const ligne = row.value.rows[0]?.ligne;
  if (ligne === undefined) throw new Error(`ligne absente pour ${key}`);
  return ligne;
}

function changedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((c) => JSON.stringify(before[c]) !== JSON.stringify(after[c]))
    .sort();
}

/**
 * B reprend le bail ET clôt l'opération.
 *
 * Écriture DÉLIBÉRÉMENT non cloisonnée : c'est le banc qui joue B, pas le
 * Gateway. L'invariant I17 ne balaie que `src/`, et l'exception est
 * légitime — un test incapable de mettre en scène un autre exécutant ne
 * pourrait rien prouver du tout.
 */
async function takeOverAndSettle(
  db: Db,
  key: OperationIdentity,
  terminal: { readonly state: string; readonly status: string },
): Promise<number> {
  const taken = await db.query<{ lease_generation: number }>(
    `UPDATE tool_operations
        SET lease_generation = lease_generation + 1,
            lease_owner = 'pid-B',
            state = $2, status = $3,
            observed_at = clock_timestamp(),
            recovery_detail = 'repris et clos par B',
            lease_expires_at = NULL
      WHERE operation_id = $1
    RETURNING lease_generation`,
    [key, terminal.state, terminal.status],
  );
  if (!taken.ok) throw new Error(taken.error.message);
  return taken.value.rows[0]?.lease_generation ?? -1;
}
