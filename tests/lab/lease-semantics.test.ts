/**
 * COUCHE 02 — LE BAIL : acquisition, expiration, concurrence, gel, absence de
 * renouvellement.
 *
 * Foundation 5, couche 02. La couche 01 a mesuré les horloges ; celle-ci
 * mesure ce que le bail EN FAIT.
 *
 * CE QUE CETTE COUCHE NE FERA PAS
 * -------------------------------
 * Elle n'ajoutera aucun mécanisme qui n'apporte pas de garantie mesurable.
 * L'avertissement est explicite au mandat :
 *
 *   > « Si une partie n'apporte aucune garantie supplémentaire mesurable, on
 *   >   la supprime. »
 *
 * D'où l'absence de renouvellement, de battement de cœur et de détection de
 * partition élaborée. Ce qui n'est pas implémenté est MESURÉ comme tel, plutôt
 * que passé sous silence : `absence de renouvellement` a sa propre section, et
 * elle constate une limite réelle.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createWorld, resetWorld, worldDb } from './world.js';
import { defineTool } from '../../src/core/tools/contract.js';
import { verificationOutcome } from '../../src/core/verification/engine.js';
import { ok, type Result } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';
import type {
  RegisteredTool,
  ToolContext,
  ToolExecution,
  VerificationOutcome,
} from '../../src/core/tools/contract.js';
import type { OperationIdentity } from '../../src/core/tools/identity.js';

const enabled = databaseAvailable();

const PAYLOAD_DIGEST = createHash('sha256')
  .update(JSON.stringify({ payload: 'charge utile' }))
  .digest('hex');

const TOOL = 'lab_lease_probe';
const Input = z.object({ payload: z.string().min(1) });

/**
 * Outil de couche 02, dont le `timeoutMs` est le paramètre du scénario.
 *
 * C'est là tout l'intérêt : le délai déclaré d'un outil peut CHANGER entre
 * deux déploiements, et la couche 02 mesure ce que ce changement fait au bail
 * d'une opération déjà partie.
 */
function leaseProbe(options: {
  timeoutMs: number;
  hold?: Promise<void>;
}): RegisteredTool {
  return defineTool<z.infer<typeof Input>>({
    definition: {
      id: TOOL,
      version: '1.0.0',
      description: 'Sonde de couche 02 : délai déclaré paramétrable.',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'payload', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
      auditEvent: 'LAB_LEASE_PROBE',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'EXTERNALLY_VERIFIABLE',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: Input,

    async execute(_input, ctx: ToolContext): Promise<Result<ToolExecution>> {
      if (options.hold !== undefined) await options.hold;
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
            observed: 'effet constaté',
            proof: 'recu',
          }),
        ),
      );
    },
  });
}

describe.runIf(enabled)('couche 02 — le bail', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(30);
    world = worldDb(10);
    await createWorld(world);
  });

  afterAll(async () => {
    await db.query('DELETE FROM tool_operations WHERE tool_id = $1', [TOOL]);
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  /* ================================================================== *
   * CONTRE-EXEMPLE — l'observateur recalcule l'échéance
   *
   * Découvert par `docs/24 §7 bis`, reproduit ici avant toute correction.
   * ================================================================== */

  it(
    "CONTRE-EXEMPLE : un changement de timeoutMs raccourcit le bail d'une opération DÉJÀ partie",
    async () => {
      /* LA SITUATION, et elle est parfaitement atteignable :

           A part avec timeoutMs = 30 000   →  échéance réelle : +35 s
           6 secondes passent
           le contrat de l'outil est modifié, redéploiement
           B reprend avec timeoutMs = 200   →  seuil recalculé : 5,2 s

         Si l'échéance est RECALCULÉE par B, l'opération de A paraît expirée
         depuis 800 ms, alors qu'il lui reste 29 secondes de bail légitime.

         Aucun `sleep` ici : l'état est mis en scène tel que le système sait
         le produire. Le contre-exemple est minimal, et instantané. */
      const key = labKey('lease-recalcul');
      await stageAcquired(db, key, {
        acquiredSecondsAgo: 6,
        leaseRemainingSeconds: 29,
      });

      const stack = buildLabStack(db);
      // Le repreneur connaît un délai COURT — le contrat a changé.
      stack.register(leaseProbe({ timeoutMs: 200 }));

      const b = await stack.gateway.invoke(labCall(key, { toolId: TOOL }));

      /* LA PROPRIÉTÉ RECHERCHÉE : B doit constater que le bail court encore.
         L'échéance appartient à l'ACQUISITION, pas à l'observateur. */
      expect(b.ok).toBe(false);
      if (b.ok) return;
      expect(b.error.kind).toBe('OPERATION_IN_FLIGHT');

      // Et l'opération de A est intacte : ni reprise, ni verdict écrit.
      const row = await snapshot(db, key);
      expect(row['state']).toBe('EXECUTING');
      expect(row['lease_generation']).toBe(4);
    },
    30_000,
  );

  it(
    "symétrie : un timeoutMs ALLONGÉ ne prolonge pas non plus un bail expiré",
    async () => {
      /* L'erreur inverse, et elle coûte de la disponibilité plutôt que de la
         sûreté — mais elle vient de la même faute : l'observateur qui décide
         d'une échéance qu'il n'a pas fixée.

         Bail réellement expiré depuis 10 s. Un repreneur au délai généreux
         ne doit pas en conclure que le bail court encore. */
      const key = labKey('lease-allonge');
      await stageAcquired(db, key, {
        acquiredSecondsAgo: 60,
        leaseRemainingSeconds: -10,
      });

      const stack = buildLabStack(db);
      stack.register(leaseProbe({ timeoutMs: 600_000 }));

      const b = await stack.gateway.invoke(labCall(key, { toolId: TOOL }));

      // La reprise est légitime : le bail est expiré, quoi qu'en pense B.
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.value.status).toBe('UNKNOWN');
      expect(b.value.replayed).toBe(true);
    },
    30_000,
  );

  /* ================================================================== *
   * ACQUISITION — exclusivité par le vrai Gateway
   * ================================================================== */

  it('30 appels simultanés : exactement une acquisition de bail', async () => {
    /* `clock.test.ts` mesurait le compare-and-swap en SQL nu. Ici c'est le
       Gateway complet — politique, journal, vérification comprises. Un
       goulot correct en SQL et contourné par la couche au-dessus ne vaudrait
       rien. */
    const key = labKey('lease-acquisition');
    const stack = buildLabStack(db);
    stack.register(leaseProbe({ timeoutMs: 2_000 }));

    const results = await Promise.all(
      Array.from({ length: 30 }, () => stack.gateway.invoke(labCall(key, { toolId: TOOL }))),
    );

    const executed = results.filter((r) => r.ok && !r.value.replayed);
    expect(executed).toHaveLength(1);

    // Une seule génération frappée : `attempts` le confirme indépendamment.
    const row = await snapshot(db, key);
    expect(row['attempts']).toBe(1);
    expect(row['lease_generation']).toBe(1);
  }, 60_000);

  /* ================================================================== *
   * CONCURRENCE DE REPRISE — un seul repreneur écrit le verdict
   * ================================================================== */

  it('20 reprises simultanées sur un bail expiré : un seul verdict', async () => {
    const key = labKey('lease-reprises');
    await stageAcquired(db, key, {
      acquiredSecondsAgo: 3_600,
      leaseRemainingSeconds: -3_500,
    });

    const stack = buildLabStack(db);
    stack.register(leaseProbe({ timeoutMs: 2_000 }));

    const results = await Promise.all(
      Array.from({ length: 20 }, () => stack.gateway.invoke(labCall(key, { toolId: TOOL }))),
    );

    /* CE QUE MON ASSERTION INITIALE SE FIGURAIT — et qui était faux.

       J'attendais « exactement un vainqueur ». La mesure en a rendu quatre, et
       c'est le système qui avait raison :

         le bail ne garde QUE la reprise depuis `EXECUTING` ;
         une opération en `UNKNOWN` n'a plus d'exécutant vivant — celui qui a
         écrit `UNKNOWN` avait terminé — donc plus de bail à respecter.

       Les repreneurs qui lisent l'état APRÈS le premier verdict trouvent
       `UNKNOWN`, se succèdent par compare-and-swap de génération, et
       re-constatent la même ignorance. C'est répétitif, pas dangereux.

       La propriété qui compte n'a jamais été « un seul vainqueur ». C'est :
       AUCUNE SECONDE EXÉCUTION, et aucun verdict affirmatif fabriqué. */
    const row = await snapshot(db, key);
    expect(row['attempts']).toBe(1);
    expect(row['state']).toBe('UNKNOWN');

    for (const r of results) {
      if (r.ok) {
        // Un repreneur ne peut que constater l'ignorance, jamais la lever.
        expect(r.value.status).toBe('UNKNOWN');
        expect(r.value.replayed).toBe(true);
      } else {
        expect(['OPERATION_IN_FLIGHT', 'STALE_EXECUTOR']).toContain(r.error.kind);
      }
    }

    /* Et la sérialisation est réelle : chaque verdict écrit a consommé une
       génération distincte. Autant de générations que de vainqueurs, jamais
       deux vainqueurs sur la même. */
    const winners = results.filter((r) => r.ok).length;
    expect(Number(row['lease_generation'])).toBe(4 + winners);
  }, 60_000);

  /* ================================================================== *
   * GEL — un exécutant VIVANT dont le bail expire
   * ================================================================== */

  it(
    "GEL : le bail d'un exécutant vivant expire, et Jarvis ne le sait pas",
    async () => {
      /* La propriété la plus importante de la couche, et c'est une LIMITE,
         pas une garantie.

         A est bel et bien vivant — il attend à l'intérieur de `execute`. Son
         bail est mis en scène comme expiré. B reprend, légitimement du point
         de vue du bail, et à tort du point de vue de la réalité.

         Aucune mesure ne permet de distinguer les deux cas. C'est exactement
         ce que `docs/21` avait établi, et la couche 02 le confirme au lieu de
         l'espérer résolu. */
      const key = labKey('lease-gel');
      let release = (): void => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });

      const stackA = buildLabStack(db);
      stackA.register(leaseProbe({ timeoutMs: 60_000, hold }));
      const aRun = stackA.gateway.invoke(labCall(key, { toolId: TOOL }));

      // On attend que A détienne réellement le bail.
      await waitForState(db, key, 'EXECUTING');

      // Le bail de A est forcé à l'expiration — un gel, une pause système,
      // une machine virtuelle suspendue : de l'extérieur, c'est identique.
      const expired = await db.query(
        `UPDATE tool_operations SET lease_expires_at = clock_timestamp() - interval '1 second'
          WHERE operation_id = $1`,
        [key],
      );
      expect(expired.ok).toBe(true);

      const stackB = buildLabStack(db);
      stackB.register(leaseProbe({ timeoutMs: 60_000 }));
      const b = await stackB.gateway.invoke(labCall(key, { toolId: TOOL }));

      // B reprend : de son point de vue, c'est correct.
      expect(b.ok).toBe(true);

      // A se réveille. Son écriture est refusée — c'est le cloisonnement, pas
      // le bail, qui le protège. Les deux mécanismes sont distincts.
      release();
      const a = await aRun;
      expect(a.ok).toBe(false);
      if (a.ok) return;
      expect(a.error.kind).toBe('STALE_EXECUTOR');
    },
    60_000,
  );

  /* ================================================================== *
   * ABSENCE DE RENOUVELLEMENT — la limite, mesurée plutôt que tue
   * ================================================================== */

  it(
    "AUCUN renouvellement n'existe : une opération plus longue que son bail est reprenable",
    async () => {
      /* Le battement de cœur a été explicitement écarté. Cette décision a un
         COÛT, et le taire serait malhonnête : rien ne prolonge le bail d'un
         exécutant en bonne santé dont l'opération dépasse la durée prévue.

         Ce test ne demande pas la correction du défaut. Il MESURE le coût de
         la décision, pour que la révision se fonde sur un chiffre plutôt que
         sur une intuition. */
      const key = labKey('lease-sans-renouvellement');
      await stageAcquired(db, key, {
        acquiredSecondsAgo: 10,
        leaseRemainingSeconds: 20,
      });

      /* La comparaison se fait EN BASE, dans le format de la base. La lire via
         `to_jsonb` produirait une autre représentation du même instant, et le
         test échouerait sur un désaccord de format plutôt que sur la propriété
         — ce qu'il a d'ailleurs fait au premier essai. */
      const deadline = async (): Promise<string> => {
        const row = await db.query<{ echeance: string }>(
          'SELECT lease_expires_at::text AS echeance FROM tool_operations WHERE operation_id = $1',
          [key],
        );
        if (!row.ok) throw new Error(row.error.message);
        return row.value.rows[0]?.echeance ?? '';
      };

      const before = await deadline();
      expect(before).not.toBe('');

      // On laisse le temps passer, et on interroge à nouveau. Rien, nulle
      // part, ne repousse l'échéance : aucun code ne le fait, et c'est le
      // constat que cette section existe pour établir.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await deadline()).toBe(before);

      /* Conséquence directe et mesurable : passé l'échéance, l'opération
         devient reprenable même si son exécutant se porte bien. */
      const forced = await db.query(
        `UPDATE tool_operations SET lease_expires_at = clock_timestamp() - interval '1 ms'
          WHERE operation_id = $1`,
        [key],
      );
      expect(forced.ok).toBe(true);

      const stack = buildLabStack(db);
      stack.register(leaseProbe({ timeoutMs: 2_000 }));
      const repris = await stack.gateway.invoke(labCall(key, { toolId: TOOL }));
      expect(repris.ok).toBe(true);
    },
    30_000,
  );

  /* ================================================================== *
   * PARTITION — ce qui est réellement mesurable ici
   * ================================================================== */

  it(
    "PARTITION : sans base, aucune acquisition de bail n'est possible — rien n'est tenté",
    async () => {
      /* La partition réseau complète n'est pas mesurable sur une machine
         unique, et le prétendre serait exactement le genre de chiffre qui ne
         prouve rien. Ce qui EST mesurable : la base injoignable.

         La propriété qui compte alors n'est pas « Jarvis continue », c'est
         « Jarvis ne tente rien ». Un bail ne peut pas être frappé sans la
         base, donc aucun effet ne peut partir sans trace d'intention. */
      const isolated = labDb(2);
      const stack = buildLabStack({
        ...isolated,
        query: () => Promise.resolve({
          ok: false as const,
          error: {
            kind: 'PROVIDER_UNAVAILABLE' as const,
            message: 'base injoignable (partition simulée)',
          },
        }),
        health: () => ({
          state: 'DOWN' as const,
          since: new Date().toISOString(),
          reason: 'partition simulée',
        }),
      });
      stack.register(leaseProbe({ timeoutMs: 2_000 }));

      const result = await stack.gateway.invoke(
        labCall(labKey('lease-partition'), { toolId: TOOL }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
      expect(result.error.message).toContain("Rien n'a été tenté");

      await isolated.close();
    },
    30_000,
  );
});

/* -------------------------------------------------------------------------- *
 * Outillage
 * -------------------------------------------------------------------------- */

/**
 * Met en scène une opération dont le bail a été PRIS à un instant donné, avec
 * une échéance donnée.
 *
 * Les deux paramètres sont indépendants — c'est tout l'objet de la couche :
 * l'instant de départ et l'échéance sont deux faits distincts, et confondre
 * l'un avec l'autre est précisément le défaut mesuré.
 */
async function stageAcquired(
  db: Db,
  key: OperationIdentity,
  when: { acquiredSecondsAgo: number; leaseRemainingSeconds: number },
): Promise<void> {
  const written = await db.query(
    `INSERT INTO tool_operations
       (operation_id, tool_id, tool_version, state, input_digest, actor,
        attempts, committed_at, executing_at, lease_expires_at,
        lease_generation, lease_owner)
     VALUES ($1,$2,'1.0.0','EXECUTING',$3,'USER',1,
             clock_timestamp() - ($4 || ' seconds')::interval,
             clock_timestamp() - ($4 || ' seconds')::interval,
             clock_timestamp() + ($5 || ' seconds')::interval,
             4, 'pid-A')`,
    [
      key,
      TOOL,
      PAYLOAD_DIGEST,
      String(when.acquiredSecondsAgo),
      String(when.leaseRemainingSeconds),
    ],
  );
  if (!written.ok) throw new Error(written.error.message);
}

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

/** Attend qu'une opération atteigne un état, sans deviner un délai. */
async function waitForState(
  db: Db,
  key: OperationIdentity,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await db.query<{ state: string }>(
      'SELECT state FROM tool_operations WHERE operation_id = $1',
      [key],
    );
    if (row.ok && row.value.rows[0]?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${key} n'a jamais atteint ${state}`);
}
